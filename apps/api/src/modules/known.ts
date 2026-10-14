import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { KnownImport, Prisma } from '@prisma/client';
import { Readable } from 'node:stream';
import { HttpError, requireUser, type ContextResolver } from '../context.js';
import {
  parse,
  id,
  normalize,
  obj,
  json,
  transact,
  wordInclude,
  wordDto,
  progressDto,
} from './shared.js';
import { decodeCursor, pageInfo } from './pagination.js';

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    field = '',
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (!quoted && field.trim()) throw new HttpError(400, 'invalid_csv');
      else quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      row.push(field);
      field = '';
    } else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (quoted) throw new HttpError(400, 'invalid_csv', 'CSV引号未闭合');
  row.push(field);
  if (row.some((v) => v.trim())) rows.push(row);
  return rows;
}
export function knownRows(
  format: string,
  text: string,
): { lemma: string; wordId?: string; language?: string }[] {
  if (Buffer.byteLength(text) > 256 * 1024) throw new HttpError(413, 'import_too_large');
  let rows: { lemma: string; wordId?: string; language?: string }[];
  if (format === 'json') {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new HttpError(400, 'invalid_json');
    }
    const raw = Array.isArray(value) ? value : obj(value).rows;
    if (!Array.isArray(raw)) throw new HttpError(400, 'invalid_known_format');
    rows = raw.map((entry) =>
      typeof entry === 'string'
        ? { lemma: entry }
        : {
            lemma: String(obj(entry).lemma ?? obj(entry).word ?? ''),
            ...(obj(entry).wordId ? { wordId: String(obj(entry).wordId) } : {}),
            ...(obj(entry).language ? { language: String(obj(entry).language) } : {}),
          },
    );
  } else if (format === 'csv') {
    const matrix = parseCsv(text.replace(/^\uFEFF/, '')),
      header = matrix.shift()?.map(normalize) ?? [];
    const lemmaColumn = header.findIndex((x) => ['lemma', 'word', '单词'].includes(x));
    if (lemmaColumn < 0) throw new HttpError(400, 'missing_lemma_column');
    const wordIdColumn = header.indexOf('wordid'),
      languageColumn = header.indexOf('language');
    rows = matrix.map((row) => ({
      lemma: row[lemmaColumn] ?? '',
      ...(wordIdColumn >= 0 && row[wordIdColumn] ? { wordId: row[wordIdColumn] } : {}),
      ...(languageColumn >= 0 && row[languageColumn] ? { language: row[languageColumn] } : {}),
    }));
  } else
    rows = text
      .split(/\r?\n/)
      .filter((x) => x.trim())
      .map((lemma) => ({ lemma }));
  if (!rows.length || rows.length > 1000)
    throw new HttpError(400, 'import_row_limit', '每批支持1–1000条');
  if (rows.some((row) => row.lemma.length > 160 || (row.wordId?.length ?? 0) > 160))
    throw new HttpError(400, 'import_row_too_long');
  return rows;
}
function importDto(value: KnownImport) {
  return {
    id: value.id,
    status: value.status,
    formatVersion: value.formatVersion,
    rows: value.rowsJson,
    counts: value.countsJson,
    createdAt: value.createdAt.toISOString(),
    confirmedAt: value.confirmedAt?.toISOString() ?? null,
    revokedAt: value.revokedAt?.toISOString() ?? null,
  };
}
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}
export async function registerKnown(app: FastifyInstance, getContext: ContextResolver) {
  app.get('/known-words', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx);
    const query = parse(
      z
        .object({
          limit: z.coerce.number().int().min(1).max(100).default(50),
          cursor: z.string().min(1).max(1200).optional(),
        })
        .strict(),
      req.query,
    );
    const scope = `known-words:${ctx.siteId}:${user.id}`;
    const after = decodeCursor(scope, query.cursor, 'string');
    const where: Prisma.WordWhereInput = {
      status: 'published',
      OR: [
        { claims: { some: { userId: user.id, import: { status: 'confirmed' } } } },
        { autoKnownWords: { some: { userId: user.id, revokedAt: null } } },
      ],
    };
    return ctx.prisma.$transaction(
      async (tx) => {
        const rows = await tx.word.findMany({
          where: { ...where, ...(after ? { id: { gt: after } } : {}) },
          include: {
            ...wordInclude,
            claims: {
              where: { userId: user.id, import: { status: 'confirmed' } },
              select: { createdAt: true },
              orderBy: { createdAt: 'desc' },
              take: 1,
            },
            autoKnownWords: {
              where: { userId: user.id, revokedAt: null },
              select: { confirmedAt: true },
            },
            progress: { where: { userId: user.id } },
          },
          orderBy: { id: 'asc' },
          take: query.limit + 1,
        });
        const total = await tx.word.count({ where });
        const result = pageInfo(rows, query.limit, total, scope, (row) => row.id);
        return {
          items: result.items.map((word) => ({
            wordId: word.id,
            word: wordDto(word),
            origin: word.claims.length ? 'manual' : 'automatic',
            knownAt: (
              word.claims[0]?.createdAt ?? word.autoKnownWords[0]!.confirmedAt
            ).toISOString(),
            progress: progressDto(word.progress[0] ?? null),
          })),
          page: result.page,
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  });
  app.post('/known-words/imports', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx),
      input = parse(
        z
          .object({ format: z.enum(['text', 'csv', 'json']), text: z.string().min(1).max(262144) })
          .strict(),
        req.body,
      );
    const raw = knownRows(input.format, input.text);
    const words = await ctx.prisma.word.findMany({
      where: {
        status: 'published',
        OR: [
          { normalizedLemma: { in: raw.map((r) => normalize(r.lemma)) } },
          { id: { in: raw.filter((r) => r.wordId).map((r) => r.wordId!) } },
        ],
      },
      select: { id: true, lemma: true, normalizedLemma: true },
    });
    const seen = new Set<string>();
    const rows = raw.map((row, index) => {
      const word =
        row.language && !['en', 'english'].includes(normalize(row.language))
          ? undefined
          : (words.find(
              (w) =>
                row.wordId === w.id && (!row.lemma || normalize(row.lemma) === w.normalizedLemma),
            ) ?? words.find((w) => w.normalizedLemma === normalize(row.lemma)));
      const match = !word ? 'unknown' : seen.has(word.id) ? 'duplicate' : 'matched';
      if (word) seen.add(word.id);
      return {
        rowNumber: index + 1,
        input: row.lemma,
        wordId: word?.id ?? null,
        lemma: word?.lemma ?? row.lemma,
        match,
        source: 'user_claim',
        confidence: word ? 'exact_demo_match' : 'unresolved',
      };
    });
    const counts = {
      total: rows.length,
      matched: rows.filter((r) => r.match === 'matched').length,
      unknown: rows.filter((r) => r.match === 'unknown').length,
      duplicate: rows.filter((r) => r.match === 'duplicate').length,
    };
    const value = await ctx.prisma.knownImport.create({
      data: {
        userId: user.id,
        formatVersion: `1/${input.format}`,
        rowsJson: json(rows),
        countsJson: json(counts),
      },
    });
    return { import: importDto(value) };
  });
  app.get('/known-words/imports', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx);
    return {
      items: (
        await ctx.prisma.knownImport.findMany({
          where: { userId: user.id },
          orderBy: { createdAt: 'desc' },
          take: 50,
        })
      ).map(importDto),
    };
  });
  app.post('/known-words/imports/:id/confirm', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx),
      params = parse(z.object({ id }), req.params);
    return transact(ctx.prisma, async (tx) => {
      const lock = await tx.$queryRaw<
        { id: string }[]
      >`SELECT "id" FROM "KnownImport" WHERE "id"=${params.id} AND "userId"=${user.id} FOR UPDATE`;
      if (!lock.length) throw new HttpError(404, 'import_not_found');
      const value = await tx.knownImport.findUniqueOrThrow({ where: { id: params.id } });
      if (value.status === 'revoked') throw new HttpError(409, 'import_revoked');
      if (value.status === 'confirmed')
        return { import: importDto(value), addedCount: 0, alreadyConfirmed: true };
      const rows = Array.isArray(value.rowsJson) ? value.rowsJson.map(obj) : [];
      const ids = rows
        .filter((r) => r.match === 'matched' && typeof r.wordId === 'string')
        .map((r) => String(r.wordId));
      const available = await tx.word.findMany({
        where: { id: { in: ids }, status: 'published' },
        select: { id: true },
      });
      if (available.length !== ids.length)
        throw new HttpError(409, 'import_preview_stale', '预览后的词条状态已变化，请重新预览');
      const created = await tx.knownClaim.createMany({
        data: available.map((w) => ({ importId: value.id, userId: user.id, wordId: w.id })),
        skipDuplicates: true,
      });
      const updated = await tx.knownImport.update({
        where: { id: value.id },
        data: { status: 'confirmed', confirmedAt: new Date() },
      });
      return { import: importDto(updated), addedCount: created.count };
    });
  });
  app.post('/known-words/imports/:id/revoke', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx),
      params = parse(z.object({ id }), req.params);
    return transact(ctx.prisma, async (tx) => {
      const lock = await tx.$queryRaw<
        { id: string }[]
      >`SELECT "id" FROM "KnownImport" WHERE "id"=${params.id} AND "userId"=${user.id} FOR UPDATE`;
      if (!lock.length) throw new HttpError(404, 'import_not_found');
      const value = await tx.knownImport.findFirst({ where: { id: params.id, userId: user.id } });
      if (!value) throw new HttpError(404, 'import_not_found');
      const updated = await tx.knownImport.update({
        where: { id: value.id },
        data: { status: 'revoked', revokedAt: value.revokedAt ?? new Date() },
      });
      return { import: importDto(updated), progressRetained: true };
    });
  });
  app.get('/known-words/exports', async (req, reply) => {
    const ctx = await getContext(req),
      user = requireUser(ctx),
      query = parse(z.object({ format: z.enum(['json', 'csv']).default('json') }), req.query);
    reply
      .header(
        'Content-Disposition',
        `attachment; filename="nightstudy-known-words.${query.format}"`,
      )
      .header('Cache-Control', 'private, no-store');
    const metadata = {
      formatVersion: 1,
      kind: 'known-words',
      sourceSiteId: ctx.siteId,
      exportedAt: new Date().toISOString(),
      consistency: 'cursor_export',
    };
    async function* exportRows() {
      let cursor = '',
        count = 0;
      yield query.format === 'csv'
        ? '\uFEFFwordId,lemma,language,familiarity\r\n'
        : JSON.stringify(metadata).slice(0, -1) + ',"rows":[';
      for (;;) {
        const page = await ctx.prisma.$queryRaw<
          { wordId: string; lemma: string; knownAt: Date; manual: boolean }[]
        >`
          WITH sources AS (
            SELECT c."wordId", c."createdAt" AS "knownAt", true AS manual
            FROM "KnownClaim" c JOIN "KnownImport" i ON i."id" = c."importId"
            WHERE c."userId" = ${user.id} AND i."status" = 'confirmed'
            UNION ALL
            SELECT a."wordId", a."confirmedAt" AS "knownAt", false AS manual
            FROM "AutoKnownWord" a WHERE a."userId" = ${user.id} AND a."revokedAt" IS NULL
          )
          SELECT s."wordId", w."lemma",
            COALESCE(MAX(s."knownAt") FILTER (WHERE s.manual), MAX(s."knownAt")) AS "knownAt",
            BOOL_OR(s.manual) AS manual
          FROM sources s JOIN "Word" w ON w."id" = s."wordId"
          WHERE s."wordId" > ${cursor}
          GROUP BY s."wordId", w."lemma" ORDER BY s."wordId" ASC LIMIT 1000
        `;
        for (const entry of page) {
          const row = {
            wordId: entry.wordId,
            lemma: entry.lemma,
            language: 'en',
            familiarity: entry.manual ? 'claimed_known' : 'automatic_known',
            source: entry.manual ? 'user_claim' : 'fsrs_reviews',
            origin: entry.manual ? 'manual' : 'automatic',
            knownAt: entry.knownAt.toISOString(),
            ...(entry.manual ? { claimedAt: entry.knownAt.toISOString() } : {}),
          };
          yield query.format === 'csv'
            ? [row.wordId, row.lemma, row.language, row.familiarity].map(csvCell).join(',') + '\r\n'
            : (count ? ',' : '') + JSON.stringify(row);
          count++;
        }
        if (page.length < 1000) break;
        cursor = page.at(-1)!.wordId;
      }
      if (query.format === 'json') yield `],"rowCount":${count}}`;
    }
    return reply
      .type(query.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8')
      .send(Readable.from(exportRows(), { objectMode: false }));
  });
}
