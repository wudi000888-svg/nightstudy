import type { FastifyInstance } from 'fastify';
import type { Book, CustomBookImport } from '@prisma/client';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { HttpError, requireUser, type ContextResolver } from '../context.js';
import { verifiedAudioBytes } from '../audio.js';
import {
  id,
  goal,
  commandId,
  parse,
  json,
  obj,
  digest,
  transact,
  getReceipt,
  type Db,
} from './shared.js';
import { decodeCursor, pageInfo } from './pagination.js';
import {
  bookTemplateHeader,
  bookImportLimits,
  decodeBookUpload,
  parseBookFile,
  BookParserError,
  type ParsedBookRow,
  type ImportReason,
} from './custom-book-parser.js';

type ImportRow = ParsedBookRow & {
  wordId?: string;
  lemma?: string;
  readiness?: {
    definition: boolean;
    phoneticUs: boolean;
    phoneticUk: boolean;
    audioUs: boolean;
    audioUk: boolean;
  };
};
const reasonMessages: Record<string, string> = {
  not_found: '本站词典没有该规范词条，不创建未知或推测词条',
  missing_definition: '缺少中文释义',
  missing_phonetic_us: '缺少真实美式 IPA',
  missing_phonetic_uk: '缺少真实英式 IPA',
  missing_audio_us: '缺少已就绪的美式音频文件',
  missing_audio_uk: '缺少已就绪的英式音频文件',
};
function counts(rows: ImportRow[]) {
  return {
    totalRows: rows.length,
    ready: rows.filter((r) => r.status === 'ready').length,
    failed: rows.filter((r) => r.status === 'failed').length,
    duplicates: rows.filter((r) => r.status === 'duplicate').length,
    missingPronunciation: rows.filter(
      (r) =>
        r.status === 'failed' &&
        r.reasons.some((reason) => /^missing_(?:audio|phonetic)_/.test(reason.code)),
    ).length,
    notFound: rows.filter((r) => r.reasons.some((reason) => reason.code === 'not_found')).length,
    missingDefinition: rows.filter((r) =>
      r.reasons.some((reason) => reason.code === 'missing_definition'),
    ).length,
  };
}
function importDto(value: CustomBookImport) {
  return {
    id: value.id,
    title: value.title,
    description: value.description,
    goal: value.goal,
    filename: value.filename,
    format: value.format,
    formatVersion: value.formatVersion,
    status: value.status,
    counts: value.countsJson,
    expiresAt: value.expiresAt,
    createdAt: value.createdAt,
    confirmedAt: value.confirmedAt,
    bookId: value.bookId,
  };
}
function bookDto(value: Book) {
  return {
    id: value.id,
    slug: value.slug,
    title: value.title,
    description: value.description,
    goal: value.goal,
    status: value.status,
    version: value.version,
    visibility: 'private' as const,
    ownedByMe: true,
    isDemo: false,
  };
}
function storedRows(value: CustomBookImport) {
  if (!Array.isArray(value.rowsJson)) throw new HttpError(503, 'import_preview_unavailable');
  return value.rowsJson as unknown as ImportRow[];
}
function importPage(
  value: CustomBookImport,
  userId: string,
  limit = 100,
  cursor?: string,
  status = 'all',
) {
  const scope = `custom-import:${userId}:${value.id}:${status}`,
    after = decodeCursor(scope, cursor, 'number');
  const rows = storedRows(value).filter((row) => status === 'all' || row.status === status);
  const page = pageInfo(
    rows.filter((row) => after === null || row.lineNumber > after),
    limit,
    rows.length,
    scope,
    (row) => row.lineNumber,
  );
  return { import: importDto(value), items: page.items, page: page.page };
}
type AudioSource = Parameters<typeof verifiedAudioBytes>[0];
type AudioVerification = Map<string, boolean>;
let activeReadinessChecks = 0;
const audioKey = (entry: AudioSource) =>
  JSON.stringify([entry.fileKey, entry.fileSha256, entry.mimeType]);
async function withAudioCheck<T>(operation: (verified: AudioVerification) => Promise<T>) {
  if (activeReadinessChecks >= 2)
    throw new HttpError(429, 'book_import_busy', '词书读音检查繁忙，请稍后重试');
  activeReadinessChecks++;
  try {
    return await operation(new Map());
  } finally {
    activeReadinessChecks--;
  }
}
async function verifyAudioSources(entries: AudioSource[], verified: AudioVerification) {
  const unique = new Map(entries.map((entry) => [audioKey(entry), entry]));
  const pending = [...unique].filter(([key]) => !verified.has(key)),
    deadline = Date.now() + 30000;
  // Two admitted checks with four workers each bound this module to eight live file reads.
  // Keep the lease until issued reads settle; an elapsed deadline never releases live IO.
  for (let offset = 0; offset < pending.length; offset += 4) {
    if (Date.now() > deadline)
      throw new HttpError(429, 'book_import_busy', '词书读音检查超时，请稍后重试');
    await Promise.all(
      pending.slice(offset, offset + 4).map(async ([key, entry]) => {
        try {
          await verifiedAudioBytes(entry);
          verified.set(key, true);
        } catch {
          verified.set(key, false);
        }
      }),
    );
  }
}
async function resolveRows(
  db: Db,
  rows: ImportRow[],
  verified: AudioVerification,
  readFiles = true,
): Promise<ImportRow[]> {
  const words = await db.word.findMany({
    where: {
      normalizedLemma: {
        in: [
          ...new Set(
            rows
              .filter(
                (row) => row.normalizedLemma && row.reasons.every((r) => r.code !== 'invalid_line'),
              )
              .map((row) => row.normalizedLemma),
          ),
        ],
      },
      status: 'published',
    },
    select: {
      id: true,
      lemma: true,
      normalizedLemma: true,
      phoneticUs: true,
      phoneticUk: true,
      senses: { select: { definitionZh: true } },
      audio: {
        where: { status: 'ready', accent: { in: ['US', 'UK'] } },
        select: { accent: true, fileKey: true, fileSha256: true, mimeType: true },
      },
    },
  });
  if (readFiles)
    await verifyAudioSources(
      words.flatMap((word) => word.audio),
      verified,
    );
  const byLemma = new Map(words.map((word) => [word.normalizedLemma, word]));
  return rows.map((original) => {
    if (original.reasons.some((reason) => reason.code === 'invalid_line')) return original;
    const { wordId: _wordId, lemma: _lemma, readiness: _readiness, ...base } = original;
    const duplicate = original.status === 'duplicate';
    const word = byLemma.get(original.normalizedLemma),
      reasons: ImportReason[] = duplicate
        ? original.reasons.filter((r) => r.code === 'duplicate')
        : [];
    if (!word)
      return {
        ...base,
        status: duplicate ? 'duplicate' : 'failed',
        reasons: [...reasons, { code: 'not_found', message: reasonMessages.not_found! }],
      };
    const readiness = {
      definition: word.senses.some((sense) => sense.definitionZh.trim()),
      phoneticUs: Boolean(word.phoneticUs.trim()),
      phoneticUk: Boolean(word.phoneticUk.trim()),
      audioUs: word.audio.some((a) => a.accent === 'US' && verified.get(audioKey(a)) === true),
      audioUk: word.audio.some((a) => a.accent === 'UK' && verified.get(audioKey(a)) === true),
    };
    const checks = [
      ['definition', 'missing_definition'],
      ['phoneticUs', 'missing_phonetic_us'],
      ['phoneticUk', 'missing_phonetic_uk'],
      ['audioUs', 'missing_audio_us'],
      ['audioUk', 'missing_audio_uk'],
    ] as const;
    for (const [key, code] of checks)
      if (!readiness[key]) reasons.push({ code, message: reasonMessages[code]! });
    return {
      ...base,
      status: duplicate ? 'duplicate' : reasons.length ? 'failed' : 'ready',
      reasons,
      wordId: word.id,
      lemma: word.lemma,
      readiness,
    };
  });
}
async function ownedImport(db: Db, userId: string, importId: string) {
  const value = await db.customBookImport.findFirst({ where: { id: importId, userId } });
  if (!value) throw new HttpError(404, 'custom_import_not_found');
  return value;
}
export async function registerCustomBooks(app: FastifyInstance, getContext: ContextResolver) {
  app.get('/custom-books/template', async () => ({
    formatVersion: 'word-lines-v1',
    header: bookTemplateHeader,
    text: `${bookTemplateHeader}\nrain\nwindow\n`,
    limits: bookImportLimits,
    requirements: [
      'exact_dictionary_word',
      'definition_zh',
      'phonetic_us',
      'phonetic_uk',
      'audio_us',
      'audio_uk',
    ],
    downloadUrls: {
      txt: '/api/v2/custom-books/templates/txt',
      docx: '/api/v2/custom-books/templates/docx',
      pdf: '/api/v2/custom-books/templates/pdf',
    },
  }));
  app.post('/custom-books/imports', { bodyLimit: 4 * 1024 * 1024 }, async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx);
    const input = parse(
      z
        .object({
          title: z.string().trim().min(1).max(160),
          description: z.string().max(4000).default(''),
          goal,
          filename: z.string().min(1).max(200),
          format: z.enum(['txt', 'pdf', 'docx']),
          contentBase64: z.string().min(1).max(2800000),
        })
        .strict(),
      req.body,
    );
    let bytes: Buffer, extracted: Awaited<ReturnType<typeof parseBookFile>>;
    try {
      bytes = decodeBookUpload(input.format, input.filename, input.contentBase64);
      extracted = await parseBookFile(input.format, bytes);
    } catch (error) {
      if (error instanceof BookParserError)
        throw new HttpError(
          error.statusCode,
          error.code,
          '文件无法按标准词书模板解析，请检查格式和限制',
        );
      throw error;
    }
    const resolved = await withAudioCheck((verified) =>
      resolveRows(ctx.prisma, extracted.rows, verified),
    );
    const value = await transact(ctx.prisma, async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id"=${user.id} FOR UPDATE`;
      await tx.customBookImport.deleteMany({
        where: { userId: user.id, status: 'preview', expiresAt: { lte: new Date() } },
      });
      if (
        (await tx.customBookImport.count({
          where: { userId: user.id, status: 'preview', expiresAt: { gt: new Date() } },
        })) >= 20
      )
        throw new HttpError(
          409,
          'custom_import_limit',
          '最多同时保留20份未确认预览，每份有效24小时',
        );
      return tx.customBookImport.create({
        data: {
          userId: user.id,
          title: input.title,
          description: input.description,
          goal: input.goal,
          filename: input.filename,
          format: input.format,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          rowsJson: json(resolved),
          countsJson: json(counts(resolved)),
          expiresAt: new Date(Date.now() + 24 * 3600000),
        },
      });
    });
    return importPage(value, user.id);
  });
  app.get('/custom-books/imports/:id', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx),
      params = parse(z.object({ id }), req.params);
    const query = parse(
      z.object({
        limit: z.coerce.number().int().min(1).max(200).default(100),
        cursor: z.string().max(1200).optional(),
        status: z.enum(['all', 'ready', 'failed', 'duplicate']).default('all'),
      }),
      req.query,
    );
    return importPage(
      await ownedImport(ctx.prisma, user.id, params.id),
      user.id,
      query.limit,
      query.cursor,
      query.status,
    );
  });
  app.get('/custom-books/imports/:id/failures', async (req, reply) => {
    const ctx = await getContext(req),
      user = requireUser(ctx),
      params = parse(z.object({ id }), req.params);
    const query = parse(z.object({ format: z.enum(['txt', 'tsv']).default('tsv') }), req.query),
      value = await ownedImport(ctx.prisma, user.id, params.id);
    const rows = storedRows(value).filter((row) => row.status !== 'ready');
    const clean = (text: string) => text.replace(/[\t\r\n]/g, ' ');
    const tsvCell = (text: string) => (/^[=+\-@]/.test(text) ? `'${clean(text)}` : clean(text));
    const output =
      query.format === 'tsv'
        ? `line\ttext\tstatus\treasons\n${rows.map((row) => `${row.lineNumber}\t${tsvCell(row.text)}\t${row.status}\t${row.reasons.map((r) => `${r.code}: ${r.message}`).join('; ')}`).join('\n')}\n`
        : rows
            .map(
              (row) =>
                `第${row.lineNumber}行 [${row.status}] ${clean(row.text)}\n${row.reasons.map((r) => `${r.code}: ${r.message}`).join('; ')}`,
            )
            .join('\n\n') + '\n';
    return reply
      .header('Content-Type', 'text/plain; charset=utf-8')
      .header(
        'Content-Disposition',
        `attachment; filename="nightstudy-import-failures.${query.format}"`,
      )
      .send(output);
  });
  app.post('/custom-books/imports/:id/confirm', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx),
      params = parse(z.object({ id }), req.params),
      input = parse(z.object({ commandId }).strict(), req.body);
    const hash = digest({ importId: params.id, action: 'custom-book-confirm' });
    const result = await withAudioCheck(async (verified) => {
      const before = await ownedImport(ctx.prisma, user.id, params.id);
      if (before.status === 'preview' && before.expiresAt > new Date())
        await resolveRows(
          ctx.prisma,
          storedRows(before).filter((row) => row.status === 'ready'),
          verified,
        );
      // File hashing happens before taking the import row lock. Fresh SQL below verifies
      // canonical metadata again, and only the exact checked file/SHA/MIME tuple qualifies.
      return transact(ctx.prisma, async (tx) => {
        const lock = await tx.$queryRaw<
          Array<{ id: string }>
        >`SELECT "id" FROM "CustomBookImport" WHERE "id"=${params.id} AND "userId"=${user.id} FOR UPDATE`;
        if (!lock.length) throw new HttpError(404, 'custom_import_not_found');
        const value = await ownedImport(tx, user.id, params.id),
          old = await getReceipt(tx, user.id, input.commandId, hash);
        if (old) return { ...obj(old.responseJson), duplicate: true };
        if (value.status === 'confirmed') {
          const existing = value.bookId
            ? await tx.book.findFirst({ where: { id: value.bookId, ownerId: user.id } })
            : null;
          if (!existing) throw new HttpError(409, 'custom_import_book_unavailable');
          const response = {
            book: bookDto(existing),
            import: importDto(value),
            duplicate: true,
            addedCount: Number(obj(value.countsJson).ready ?? 0),
            skippedCount: storedRows(value).length - Number(obj(value.countsJson).ready ?? 0),
          };
          await tx.commandReceipt.create({
            data: {
              userId: user.id,
              commandId: input.commandId,
              requestHash: hash,
              responseJson: json(response),
            },
          });
          return response;
        }
        if (value.expiresAt <= new Date()) throw new HttpError(410, 'custom_import_expired');
        const original = storedRows(value),
          checked = await resolveRows(
            tx,
            original.filter((row) => row.status === 'ready'),
            verified,
            false,
          );
        const replacements = new Map(checked.map((row) => [row.lineNumber, row]));
        const rows = original.map((row) => replacements.get(row.lineNumber) ?? row);
        const ready = rows.filter((row) => row.status === 'ready' && row.wordId);
        if (!ready.length) {
          const updated = await tx.customBookImport.update({
            where: { id: value.id },
            data: { rowsJson: json(rows), countsJson: json(counts(rows)) },
          });
          return { blocked: true, import: importDto(updated) };
        }
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id"=${user.id} FOR UPDATE`;
        if ((await tx.book.count({ where: { ownerId: user.id } })) >= 100)
          throw new HttpError(409, 'custom_book_limit', '最多保留100本个人词书（含归档）');
        const bookId = `custom-book-${randomUUID()}`;
        const book = await tx.book.create({
          data: {
            id: bookId,
            slug: bookId,
            title: value.title,
            description: value.description,
            goal: value.goal,
            ownerId: user.id,
            status: 'published',
            version: `custom-${Date.now()}`,
          },
        });
        for (let offset = 0; offset < ready.length; offset += 1000) {
          await tx.bookItem.createMany({
            data: ready.slice(offset, offset + 1000).map((row, index) => ({
              bookId: book.id,
              wordId: row.wordId!,
              ordinal: offset + index,
            })),
          });
        }
        const updated = await tx.customBookImport.update({
          where: { id: value.id },
          data: {
            bookId: book.id,
            status: 'confirmed',
            confirmedAt: new Date(),
            rowsJson: json(rows),
            countsJson: json(counts(rows)),
          },
        });
        const response = {
          book: bookDto(book),
          import: importDto(updated),
          duplicate: false,
          addedCount: ready.length,
          skippedCount: rows.length - ready.length,
        };
        await tx.commandReceipt.create({
          data: {
            userId: user.id,
            commandId: input.commandId,
            requestHash: hash,
            responseJson: json(response),
          },
        });
        return response;
      });
    });
    if ('blocked' in result && result.blocked)
      throw new HttpError(
        409,
        'custom_import_no_ready_words',
        '没有符合发音、音标和释义要求的词条，请检查失败清单',
        { import: result.import },
      );
    return result;
  });
  app.get('/custom-books', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx);
    const query = parse(
      z.object({ status: z.enum(['published', 'archived', 'all']).default('published') }),
      req.query,
    );
    const books = await ctx.prisma.book.findMany({
      where: { ownerId: user.id, ...(query.status !== 'all' ? { status: query.status } : {}) },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
    const totals = await ctx.prisma.bookItem.groupBy({
      by: ['bookId'],
      where: { bookId: { in: books.map((b) => b.id) }, word: { status: 'published' } },
      _count: { _all: true },
    });
    const learned = await ctx.prisma.bookItem.groupBy({
      by: ['bookId'],
      where: {
        bookId: { in: books.map((b) => b.id) },
        word: {
          status: 'published',
          progress: { some: { userId: user.id, firstLearnedAt: { not: null } } },
        },
      },
      _count: { _all: true },
    });
    const profiles = await ctx.prisma.masteryProfile.findMany({
      where: { userId: user.id },
      select: { evidenceJson: true },
    });
    const verified = [
      ...new Set(
        profiles.flatMap((profile) => {
          const ids = obj(profile.evidenceJson).verifiedWordIds;
          return Array.isArray(ids)
            ? ids.filter((value): value is string => typeof value === 'string')
            : [];
        }),
      ),
    ];
    const [covered, known] = await Promise.all([
      ctx.prisma.bookItem.groupBy({
        by: ['bookId'],
        where: {
          bookId: { in: books.map((b) => b.id) },
          word: { status: 'published' },
          OR: [
            { word: { progress: { some: { userId: user.id, firstLearnedAt: { not: null } } } } },
            { wordId: { in: verified } },
          ],
        },
        _count: { _all: true },
      }),
      ctx.prisma.bookItem.groupBy({
        by: ['bookId'],
        where: {
          bookId: { in: books.map((b) => b.id) },
          word: {
            status: 'published',
            claims: { some: { userId: user.id, import: { status: 'confirmed' } } },
          },
        },
        _count: { _all: true },
      }),
    ]);
    return {
      items: books.map((book) => ({
        ...bookDto(book),
        wordCount: totals.find((r) => r.bookId === book.id)?._count._all ?? 0,
        learnedCount: learned.find((r) => r.bookId === book.id)?._count._all ?? 0,
        coveredCount: covered.find((r) => r.bookId === book.id)?._count._all ?? 0,
        claimedKnownCount: known.find((r) => r.bookId === book.id)?._count._all ?? 0,
      })),
    };
  });
  app.patch('/custom-books/:id', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx),
      params = parse(z.object({ id }), req.params);
    const input = parse(
      z
        .object({
          title: z.string().trim().min(1).max(160).optional(),
          description: z.string().max(4000).optional(),
          status: z.enum(['published', 'archived']).optional(),
        })
        .strict(),
      req.body,
    );
    return transact(ctx.prisma, async (tx) => {
      if (!(await tx.book.findFirst({ where: { id: params.id, ownerId: user.id } })))
        throw new HttpError(404, 'book_not_found');
      const value = await tx.book.update({
        where: { id: params.id },
        data: { ...input, version: `custom-${Date.now()}` },
      });
      if (input.status === 'archived')
        await tx.userSettings.updateMany({
          where: { userId: user.id, currentBookId: value.id },
          data: { currentBookId: null, revision: { increment: 1 } },
        });
      return { book: bookDto(value) };
    });
  });
  app.delete('/custom-books/:id', async (req) => {
    const ctx = await getContext(req),
      user = requireUser(ctx),
      params = parse(z.object({ id }), req.params);
    await transact(ctx.prisma, async (tx) => {
      if (!(await tx.book.findFirst({ where: { id: params.id, ownerId: user.id } })))
        throw new HttpError(404, 'book_not_found');
      await tx.book.update({ where: { id: params.id }, data: { status: 'archived' } });
      await tx.userSettings.updateMany({
        where: { userId: user.id, currentBookId: params.id },
        data: { currentBookId: null, revision: { increment: 1 } },
      });
    });
    return { archived: true, progressRetained: true, existingSessionsRetainSnapshots: true };
  });
}
