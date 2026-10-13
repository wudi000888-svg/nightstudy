import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { KnownImport } from '@prisma/client';
import { HttpError, requireUser, type ContextResolver } from '../context.js';
import { parse, id, normalize, obj, json, transact } from './shared.js';

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
    const claims = await ctx.prisma.knownClaim.findMany({
      where: { userId: user.id, import: { status: 'confirmed' } },
      include: { word: true },
      take: 10000,
      orderBy: { createdAt: 'asc' },
    });
    const distinct = new Map(
      claims.map((c) => [
        c.wordId,
        {
          wordId: c.wordId,
          lemma: c.word.lemma,
          language: 'en',
          familiarity: 'claimed_known',
          source: 'user_claim',
          claimedAt: c.createdAt.toISOString(),
        },
      ]),
    );
    const rows = [...distinct.values()];
    reply
      .header(
        'Content-Disposition',
        `attachment; filename="nightstudy-known-words.${query.format}"`,
      )
      .header('Cache-Control', 'private, no-store');
    if (query.format === 'csv')
      return reply
        .type('text/csv; charset=utf-8')
        .send(
          '\uFEFFwordId,lemma,language,familiarity\r\n' +
            rows
              .map((r) => [r.wordId, r.lemma, r.language, r.familiarity].map(csvCell).join(','))
              .join('\r\n'),
        );
    return {
      formatVersion: 1,
      kind: 'known-words',
      sourceSiteId: ctx.siteId,
      exportedAt: new Date().toISOString(),
      rows,
    };
  });
}
