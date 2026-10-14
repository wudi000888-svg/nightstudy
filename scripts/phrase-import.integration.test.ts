import { createHash, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Client } from 'pg';
import { expect, it } from 'vitest';
import { createPhraseFixture } from './phrase-fixture.js';
import { importPhraseRows, readPhraseRows, type PhraseRow } from './phrase-lib.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const privateTables = [
  'User',
  'Session',
  'Account',
  'Verification',
  'UserSettings',
  'UserWord',
  'AutoKnownWord',
  'StudyProgress',
  'StudySession',
  'SessionItem',
  'CommandReceipt',
  'ReviewLog',
  'DailyPlan',
  'DailyPlanWord',
  'KnownImport',
  'KnownClaim',
  'Assessment',
  'AssessmentItem',
  'MasteryProfile',
  'ActivityInterval',
  'CustomBookImport',
  'SiteState',
] as const;
type Summary = { count: string; digest: string };

// Only aggregate digests leave PostgreSQL; existing account/learning rows are never copied.
async function summarize(client: Client, table: string, where = '', values: unknown[] = []) {
  const result = await client.query<Summary>(
    `SELECT COUNT(*)::text AS count,
       md5(COALESCE(string_agg(md5(to_jsonb(t)::text), '' ORDER BY md5(to_jsonb(t)::text)), '')) AS digest
     FROM "${table}" AS t ${where}`,
    values,
  );
  return result.rows[0]!;
}

function isolatedFixture() {
  const fixture = createPhraseFixture();
  const nonce = randomUUID();
  // Parser-compatible whole-word tokens; no collisions with fixed fixture or standard books.
  const letters = nonce
    .replaceAll('-', '')
    .replace(/[0-9]/g, (digit) => String.fromCharCode(107 + Number(digit)));
  const prefix = `phrase-pg-${nonce}`;
  const tokens = ['alpha', 'beta', 'gamma', 'delta'].map((part) => part + letters);
  const wordIds = [prefix + '-word-a', prefix + '-word-b'];
  const senseIds = [prefix + '-source-a', prefix + '-source-b'];
  const adminSenseId = prefix + '-admin';
  const sourceTexts = ['  测试夹具短语；保留全角符号。\n', '  测试夹具：不可靠旧源义。\n'];
  const rows = wordIds.map((sourceWordId, index): PhraseRow => {
    const row = structuredClone(fixture.row);
    const sourceText = sourceTexts[index]!;
    const sourceTextSha256 = hash(sourceText);
    const sourceSenseId = senseIds[index]!;
    row.normalizedLemma = `${tokens[index * 2]} ${index ? 'in' : 'of'} ${tokens[index * 2 + 1]}`;
    row.book = index ? 'cet6-phrases' : 'cet4-phrases';
    row.sourceWordId = sourceWordId;
    row.sourceFocusSenseId = sourceSenseId;
    row.sourceFocusTextSha256 = sourceTextSha256;
    row.focusSenseId = sourceSenseId;
    row.collocationTokens = tokens.slice(index * 2, index * 2 + 2);
    const patch = {
      ...row.senses[0]!,
      id: sourceSenseId,
      sourceText,
      sourceTextSha256,
      contentMetadata: {
        definitionEn: {
          ...(row.senses[0]!.contentMetadata.definitionEn as Record<string, unknown>),
          sourceTextSha256,
          sourceSenseId,
        },
      },
    };
    row.senses = index ? [] : [patch];
    row.examples[0]!.exampleEn = `Please check ${row.normalizedLemma} before running this synthetic test.`;
    row.examples[0]!.exampleZh = '运行这个合成测试前，请检查该夹具词组。';
    if (index) {
      const id = prefix + '-curated';
      const authored = {
        kind: 'original-authoring',
        review: 'pending',
        license: 'MIT',
        author: 'NightStudy contributors',
        sourceSenseId,
        sourceTextSha256,
        correctionReason: 'Synthetic unreliable source exercises a separate corrected focus.',
        sourceRelation: 'correction-reference-not-literal-translation',
      };
      row.focusSenseId = id;
      row.curatedFocus = {
        id,
        pos: 'n.',
        definitionZh: '仅用于测试的独立修正词组义。',
        definitionEn: 'An independent corrected phrase meaning used only by this test.',
        ordinal: -1,
        contentMetadata: { definitionEn: { ...authored }, definitionZh: { ...authored } },
      };
      row.qualityWarnings = [
        {
          senseId: sourceSenseId,
          field: 'definitionZh',
          sourceTextSha256,
          code: 'source-definition-unreliable',
          message: 'Synthetic source-quality warning; retain the exact original source.',
          excludeFromLearning: true,
        },
      ];
    } else {
      row.senses.push({
        ...structuredClone(patch),
        id: adminSenseId,
        contentMetadata: {
          definitionEn: {
            ...(patch.contentMetadata.definitionEn as Record<string, unknown>),
            sourceSenseId: adminSenseId,
          },
        },
      });
    }
    return row;
  });
  const decoded = Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const bytes = gzipSync(decoded);
  const manifest = {
    ...fixture.manifest,
    id: `phrase-books-fixture-${nonce}`,
    bytes: bytes.length,
    sha256: hash(bytes),
    jsonlSha256: hash(decoded),
    wordCount: rows.length,
    bookCounts: { 'cet4-phrases': 1, 'cet6-phrases': 1 },
    tagCounts: { 'phrase-books': 2 },
  };
  const heads = [...tokens, tokens[0] + 'x', 'x' + tokens[1]];
  const headIds = heads.map((_, index) => prefix + '-head-' + index);
  const bookIds = ['cet4-phrases', 'cet6-phrases'].map((goal) => `content-${manifest.id}-${goal}`);
  return {
    rows: readPhraseRows(bytes, manifest),
    manifest,
    tokens,
    heads,
    headIds,
    wordIds,
    senseIds,
    adminSenseId,
    sourceTexts,
    bookIds,
    sourceRef: 'synthetic-only:' + prefix,
  };
}

it.runIf(!!databaseUrl)(
  'installs only owned phrases, preserves canonical/private data, and rolls back conflicts atomically',
  async () => {
    const url = new URL(databaseUrl!);
    const databaseName = decodeURIComponent(url.pathname.slice(1));
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !/^[^/]+_test$/.test(databaseName) ||
      ['host', 'hostaddr', 'service'].some((key) => url.searchParams.has(key))
    )
      throw new Error('phrase_integration_requires_local_disposable_test_database');
    const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10000 });
    await client.connect();
    const fixture = isolatedFixture();
    const allWordIds = [...fixture.wordIds, ...fixture.headIds];
    let ownsFixture = false;
    let setupTransaction = false;
    const privateSummary = async () => {
      const summary: Record<string, Summary> = {};
      for (const table of privateTables) summary[table] = await summarize(client, table);
      return summary;
    };
    const catalogSummary = async (owned: boolean) => {
      const filter = owned ? '' : 'NOT ';
      return {
        Word: await summarize(client, 'Word', `WHERE ${filter}(id=ANY($1::text[]))`, [allWordIds]),
        Sense: await summarize(client, 'Sense', `WHERE ${filter}("wordId"=ANY($1::text[]))`, [
          allWordIds,
        ]),
        WordExample: await summarize(
          client,
          'WordExample',
          `WHERE ${filter}("wordId"=ANY($1::text[]))`,
          [allWordIds],
        ),
        WordAudio: await summarize(
          client,
          'WordAudio',
          `WHERE ${filter}("wordId"=ANY($1::text[]))`,
          [allWordIds],
        ),
        WordCollocation: await summarize(
          client,
          'WordCollocation',
          `WHERE ${filter}("wordId"=ANY($1::text[]) OR "phraseId"=ANY($1::text[]))`,
          [allWordIds],
        ),
        Book: await summarize(client, 'Book', `WHERE ${filter}(id=ANY($1::text[]))`, [
          fixture.bookIds,
        ]),
        BookItem: await summarize(client, 'BookItem', `WHERE ${filter}("bookId"=ANY($1::text[]))`, [
          fixture.bookIds,
        ]),
        ContentPack: await summarize(client, 'ContentPack', `WHERE ${filter}(id=$1)`, [
          fixture.manifest.id,
        ]),
      };
    };
    let preservedPrivate: Record<string, Summary> | undefined;
    let preservedCatalog: Awaited<ReturnType<typeof catalogSummary>> | undefined;
    try {
      const binding = (
        await client.query<{ database: string; address: string; siteId: string }>(
          `SELECT current_database() AS database, host(inet_server_addr()) AS address, "siteId"
         FROM "SiteState" WHERE id='singleton'`,
        )
      ).rows[0];
      if (
        !binding ||
        binding.database !== databaseName ||
        !['127.0.0.1', '::1'].includes(binding.address)
      )
        throw new Error('phrase_test_database_or_site_not_prepared');
      const schema = await client.query<{ ready: boolean }>(
        `SELECT to_regclass('public."WordCollocation"') IS NOT NULL AS ready`,
      );
      if (!schema.rows[0]?.ready) throw new Error('phrase_test_requires_WordCollocation_migration');
      const site = { id: binding.siteId, databaseUrl: databaseUrl! };
      const collision = await client.query<{ count: number }>(
        `SELECT (
          (SELECT COUNT(*) FROM "Word" WHERE id=ANY($1::text[]) OR "normalizedLemma"=ANY($2::text[])) +
          (SELECT COUNT(*) FROM "Sense" WHERE id=ANY($3::text[])) +
          (SELECT COUNT(*) FROM "Book" WHERE id=ANY($4::text[]) OR slug=ANY($5::text[])) +
          (SELECT COUNT(*) FROM "ContentPack" WHERE id=$6)
        )::int AS count`,
        [
          allWordIds,
          [...fixture.rows.map((row) => row.normalizedLemma), ...fixture.heads],
          [...fixture.senseIds, fixture.adminSenseId, fixture.rows[1]!.focusSenseId],
          fixture.bookIds,
          ['cet4-phrases', 'cet6-phrases'].map((goal) => `${fixture.manifest.id}-${goal}`),
          fixture.manifest.id,
        ],
      );
      if (collision.rows[0]?.count !== 0) throw new Error('phrase_test_namespace_collision');
      preservedPrivate = await privateSummary();
      preservedCatalog = await catalogSummary(false);
      await client.query('BEGIN');
      setupTransaction = true;
      for (const [index, id] of allWordIds.entries()) {
        const lemma = index < 2 ? fixture.rows[index]!.normalizedLemma : fixture.heads[index - 2]!;
        await client.query(
          `INSERT INTO "Word" (id,lemma,"normalizedLemma","goalTags",difficulty,status,"sourceRef","contentVersion","updatedAt")
           VALUES($1,$2,$2,ARRAY['daily','cet4'],3,'published',$3,'fixture-admin-preserved',NOW())`,
          [id, lemma, fixture.sourceRef],
        );
      }
      for (const [index, id] of fixture.senseIds.entries())
        await client.query(
          `INSERT INTO "Sense" (id,"wordId",pos,"definitionZh","definitionEn","exampleEn","exampleZh",ordinal,"contentMetadata")
           VALUES($1,$2,'n.',$3,'','Original fixture example.','原有夹具例句。',$4,'{"customNote":"preserve source metadata"}')`,
          [id, fixture.wordIds[index], fixture.sourceTexts[index], 7 + index],
        );
      await client.query(
        `INSERT INTO "Sense" (id,"wordId",pos,"definitionZh","definitionEn",ordinal,"contentMetadata")
         VALUES($1,$2,'n.',$3,'Administrator-authored English must remain intact.',11,
           '{"definitionEn":{"kind":"site-authored","review":"source"},"customNote":"keep admin edit"}')`,
        [fixture.adminSenseId, fixture.wordIds[0], fixture.sourceTexts[0]],
      );
      await client.query('COMMIT');
      setupTransaction = false;
      ownsFixture = true;
      const wordsBefore = (
        await client.query(`SELECT * FROM "Word" WHERE id=ANY($1::text[]) ORDER BY id`, [
          allWordIds,
        ])
      ).rows;
      const oldSenses = (
        await client.query(`SELECT * FROM "Sense" WHERE "wordId"=ANY($1::text[]) ORDER BY id`, [
          fixture.wordIds,
        ])
      ).rows;
      const assertPreserved = async () => {
        expect(await privateSummary()).toEqual(preservedPrivate);
        expect(await catalogSummary(false)).toEqual(preservedCatalog);
      };

      // Claim the original SHA while the database has different UTF-8 bytes: fail before mutation.
      await client.query(`UPDATE "Sense" SET "definitionZh"=$2 WHERE id=$1 AND "wordId"=$3`, [
        fixture.senseIds[1],
        fixture.sourceTexts[1] + 'changed',
        fixture.wordIds[1],
      ]);
      const wrongSourceBefore = await catalogSummary(true);
      await expect(importPhraseRows(site, fixture.rows, fixture.manifest)).rejects.toThrow(
        'phrase_primary_source_changed',
      );
      expect(await catalogSummary(true)).toEqual(wrongSourceBefore);
      await assertPreserved();
      await client.query(`UPDATE "Sense" SET "definitionZh"=$2 WHERE id=$1 AND "wordId"=$3`, [
        fixture.senseIds[1],
        fixture.sourceTexts[1],
        fixture.wordIds[1],
      ]);

      const dryBefore = await catalogSummary(true);
      expect(
        await importPhraseRows(site, fixture.rows, fixture.manifest, { dryRun: true }),
      ).toMatchObject({ dryRun: true, matchedWords: 2, translatedSourceSenses: 0, newBooks: 0 });
      expect(await catalogSummary(true)).toEqual(dryBefore);

      // This second-book conflict occurs after patches, curated focus, examples and first book.
      await client.query(
        `INSERT INTO "Book" (id,slug,title,description,goal,kind,version,"updatedAt")
         VALUES($1,$1,'Owned rollback conflict','','cet6','vocabulary',$2,NOW())`,
        [fixture.bookIds[1], fixture.manifest.version],
      );
      const lateConflictBefore = await catalogSummary(true);
      await expect(importPhraseRows(site, fixture.rows, fixture.manifest)).rejects.toThrow(
        'phrase_book_identity_conflict',
      );
      expect(await catalogSummary(true)).toEqual(lateConflictBefore);
      await assertPreserved();
      expect(
        (
          await client.query(
            `DELETE FROM "Book" WHERE id=$1 AND kind='vocabulary' AND version=$2`,
            [fixture.bookIds[1], fixture.manifest.version],
          )
        ).rowCount,
      ).toBe(1);

      const result = await importPhraseRows(site, fixture.rows, fixture.manifest);
      expect(result).toMatchObject({
        alreadyInstalled: false,
        matchedWords: 2,
        translatedSourceSenses: 1,
        newCuratedFocusSenses: 1,
        newExamples: 2,
        newBooks: 2,
        collocations: 4,
      });
      expect(result.conflicts).toEqual([
        {
          normalizedLemma: fixture.rows[0]!.normalizedLemma,
          code: 'existing_english_preserved',
          senseId: fixture.adminSenseId,
        },
      ]);
      expect(
        (
          await client.query(`SELECT * FROM "Word" WHERE id=ANY($1::text[]) ORDER BY id`, [
            allWordIds,
          ])
        ).rows,
      ).toEqual(wordsBefore);
      const senses = (
        await client.query(`SELECT * FROM "Sense" WHERE "wordId"=ANY($1::text[]) ORDER BY id`, [
          fixture.wordIds,
        ])
      ).rows;
      for (const original of oldSenses) {
        const current = senses.find((sense) => sense.id === original.id)!;
        if (original.id === fixture.adminSenseId) expect(current).toEqual(original);
        else {
          const {
            definitionEn: _beforeEn,
            contentMetadata: _beforeMetadata,
            ...identity
          } = original;
          const {
            definitionEn: _afterEn,
            contentMetadata: _afterMetadata,
            ...currentIdentity
          } = current;
          expect(currentIdentity).toEqual(identity);
          expect(current.contentMetadata.customNote).toBe(original.contentMetadata.customNote);
        }
      }
      expect(senses.find((sense) => sense.id === fixture.senseIds[0])).toMatchObject({
        definitionEn: fixture.rows[0]!.senses[0]!.definitionEn,
        contentMetadata: fixture.rows[0]!.senses[0]!.contentMetadata,
      });
      expect(senses.find((sense) => sense.id === fixture.senseIds[1])).toMatchObject({
        definitionZh: fixture.sourceTexts[1],
        definitionEn: '',
        contentMetadata: {
          lexicalQuality: {
            excludeFromLearning: true,
            field: 'definitionZh',
            sourceTextSha256: hash(fixture.sourceTexts[1]!),
            code: 'source-definition-unreliable',
            review: 'pending',
          },
        },
      });
      expect(senses.find((sense) => sense.id === fixture.rows[1]!.focusSenseId)).toMatchObject({
        ...fixture.rows[1]!.curatedFocus,
        wordId: fixture.wordIds[1],
        exampleEn: '',
        exampleZh: '',
      });
      expect(senses).toHaveLength(oldSenses.length + 1);

      const examples = (
        await client.query(
          `SELECT * FROM "WordExample" WHERE "wordId"=ANY($1::text[]) ORDER BY "wordId"`,
          [fixture.wordIds],
        )
      ).rows;
      expect(examples).toHaveLength(2);
      for (const row of fixture.rows) {
        const example = examples.find((item) => item.wordId === row.sourceWordId);
        const input = row.examples[0]!;
        expect(example).toEqual({
          id:
            'phrase-example-' +
            hash(row.sourceWordId + '\0' + input.exampleEn + '\0' + input.exampleZh),
          wordId: row.sourceWordId,
          ...input,
          ordinal: -1,
        });
        expect(input.exampleEn.toLowerCase()).toContain(row.normalizedLemma);
        expect(input.contentMetadata).toMatchObject({
          exampleEn: {
            kind: 'generated',
            review: 'pending',
            license: 'MIT',
            author: 'NightStudy contributors',
          },
          exampleZh: {
            kind: 'generated',
            review: 'pending',
            license: 'MIT',
            author: 'NightStudy contributors',
          },
        });
      }
      const links = (
        await client.query(
          `SELECT c."wordId",c."phraseId",c.ordinal,w."normalizedLemma" AS token
         FROM "WordCollocation" c JOIN "Word" w ON w.id=c."wordId"
         WHERE c."phraseId"=ANY($1::text[]) ORDER BY w."normalizedLemma"`,
          [fixture.wordIds],
        )
      ).rows;
      expect(links).toEqual(
        fixture.tokens
          .map((token, index) => ({
            wordId: fixture.headIds[index],
            phraseId: fixture.wordIds[Math.floor(index / 2)],
            ordinal: 0,
            token,
          }))
          .sort((a, b) => a.token.localeCompare(b.token)),
      );
      expect(
        links.some((link) => ['of', 'in', fixture.heads[4], fixture.heads[5]].includes(link.token)),
      ).toBe(false);
      const books = (
        await client.query(
          `SELECT id,slug,kind,"ownerId",version FROM "Book" WHERE id=ANY($1::text[]) ORDER BY id`,
          [fixture.bookIds],
        )
      ).rows;
      expect(books).toEqual(
        fixture.bookIds.map((id, index) => ({
          id,
          slug: `${fixture.manifest.id}-${index ? 'cet6-phrases' : 'cet4-phrases'}`,
          kind: 'phrases',
          ownerId: null,
          version: fixture.manifest.version,
        })),
      );
      const items = (
        await client.query(
          `SELECT * FROM "BookItem" WHERE "bookId"=ANY($1::text[]) ORDER BY "bookId"`,
          [fixture.bookIds],
        )
      ).rows;
      expect(items).toEqual(
        fixture.rows.map((row, index) => ({
          id: 'phrase-item-' + hash(fixture.bookIds[index] + '\0' + row.sourceWordId),
          bookId: fixture.bookIds[index],
          wordId: row.sourceWordId,
          focusSenseId: row.focusSenseId,
          ordinal: 0,
        })),
      );
      expect(
        (
          await client.query(
            `SELECT status,sha256,license,"entryCount","tagCounts" FROM "ContentPack" WHERE id=$1`,
            [fixture.manifest.id],
          )
        ).rows[0],
      ).toEqual({
        status: 'ready',
        sha256: fixture.manifest.sha256,
        license: 'MIT',
        entryCount: 2,
        tagCounts: { kind: 'phrase-books', 'phrase-books': 2 },
      });
      await assertPreserved();
      const installedBefore = await catalogSummary(true);
      expect(await importPhraseRows(site, fixture.rows, fixture.manifest)).toMatchObject({
        alreadyInstalled: true,
        matchedWords: 0,
        translatedSourceSenses: 0,
        newCuratedFocusSenses: 0,
        newExamples: 0,
        newBooks: 0,
        collocations: 0,
        conflicts: [],
      });
      expect(await catalogSummary(true)).toEqual(installedBefore);
      await assertPreserved();
    } finally {
      if (setupTransaction) await client.query('ROLLBACK');
      try {
        if (ownsFixture) {
          // Exact owned identities only; private learning/auth and SiteState are never deleted.
          await client.query('BEGIN');
          try {
            await client.query(`DELETE FROM "BookItem" WHERE "bookId"=ANY($1::text[])`, [
              fixture.bookIds,
            ]);
            await client.query(`DELETE FROM "Book" WHERE id=ANY($1::text[]) AND version=$2`, [
              fixture.bookIds,
              fixture.manifest.version,
            ]);
            await client.query(
              `DELETE FROM "WordCollocation" WHERE "phraseId"=ANY($1::text[]) OR "wordId"=ANY($1::text[])`,
              [allWordIds],
            );
            await client.query(`DELETE FROM "WordExample" WHERE "wordId"=ANY($1::text[])`, [
              allWordIds,
            ]);
            await client.query(`DELETE FROM "WordAudio" WHERE "wordId"=ANY($1::text[])`, [
              allWordIds,
            ]);
            await client.query(`DELETE FROM "Sense" WHERE "wordId"=ANY($1::text[])`, [allWordIds]);
            await client.query(`DELETE FROM "Word" WHERE id=ANY($1::text[]) AND "sourceRef"=$2`, [
              allWordIds,
              fixture.sourceRef,
            ]);
            await client.query(
              `DELETE FROM "ContentPack" WHERE id=$1 AND "sourceUrl"=$2 AND sha256=$3`,
              [fixture.manifest.id, fixture.manifest.sourceUrl, fixture.manifest.sha256],
            );
            await client.query('COMMIT');
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          }
          expect(await privateSummary()).toEqual(preservedPrivate);
          expect(await catalogSummary(false)).toEqual(preservedCatalog);
          const empty = await catalogSummary(true);
          expect(Object.values(empty).every((summary) => summary.count === '0')).toBe(true);
        }
      } finally {
        await client.end();
      }
    }
  },
);
