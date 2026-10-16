import { it, expect } from 'vitest';
import { Client } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { importBilingualRows, type BilingualManifest, type BilingualRow } from './bilingual-lib.js';
import {
  applyExampleTranslationCorrections,
  repairHeldDefaultFocus,
} from './lexical-polish-lib.js';

const databaseUrl = process.env.CONTENT_TEST_DATABASE_URL;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const authored = {
  kind: 'original-authoring',
  author: 'NightStudy contributors',
  license: 'MIT',
  review: 'pending',
} as const;

it.skipIf(!databaseUrl)(
  'adds an anchored corrected sense without overwriting source, private focus or learner history; rejects conflicts atomically',
  async () => {
    if (!new URL(databaseUrl!).pathname.endsWith('_test'))
      throw new Error('use_a_disposable_test_database');
    const db = new Client({ connectionString: databaseUrl });
    await db.connect();
    const nonce = randomUUID(),
      prefix = 'polish-fixture-' + nonce;
    const wordId = prefix + '-word',
      senseId = prefix + '-source',
      editedId = prefix + '-edited';
    const fillId = prefix + '-fill',
      userId = prefix + '-user',
      email = prefix + '@example.invalid';
    const publicBook = prefix + '-public',
      privateBook = prefix + '-private';
    const correctionId = 'bilingual-sense-' + hash(prefix);
    const source = '原始合成释义，含待校正歧义';
    const manifest: BilingualManifest = {
      formatVersion: 1,
      id: prefix,
      version: 'synthetic',
      fileName: 'fixture.jsonl.gz',
      bytes: 1,
      sha256: hash(prefix),
      jsonlSha256: hash(prefix + 'jsonl'),
      wordCount: 1,
      scope: 'synthetic fixtures',
      sourceUrl: 'https://example.invalid/original-test',
      license: 'MIT',
    };
    const correction = {
      id: correctionId,
      replacesSenseId: senseId,
      sourceDefinitionZhSha256: hash(source),
      sourceDefinitionEnSha256: hash(''),
      sourcePos: 'n.',
      definitionZh: '单独撰写的准确合成释义',
      definitionEn: 'An independently authored synthetic definition.',
      pos: 'n.',
      reason: 'Original fixture deliberately has an ambiguous meaning.',
      contentMetadata: { definitionZh: authored, definitionEn: authored },
    };
    const rows: BilingualRow[] = [
      {
        normalizedLemma: prefix,
        senses: [
          {
            id: fillId,
            pos: 'adj.',
            sourceDefinitionZhSha256: hash('待补词性的合成释义'),
            definitionEn: 'A synthetic adjective.',
            contentMetadata: {
              pos: authored,
              definitionEn: { ...authored, sourceTextSha256: hash('待补词性的合成释义') },
            },
          },
        ],
        examples: [],
        corrections: [
          correction,
          {
            ...correction,
            id: 'bilingual-sense-' + hash(prefix + 'edited'),
            replacesSenseId: editedId,
          },
        ],
      },
    ];
    const snapshot = async () => ({
      word: (await db.query('SELECT * FROM "Word" WHERE id=$1', [wordId])).rows,
      history: (await db.query('SELECT * FROM "StudyProgress" WHERE "userId"=$1', [userId])).rows,
      privateItems: (await db.query('SELECT * FROM "BookItem" WHERE "bookId"=$1', [privateBook]))
        .rows,
    });
    try {
      const site = (await db.query(`SELECT "siteId" FROM "SiteState" WHERE id='singleton'`))
        .rows[0];
      if (!site) throw new Error('test_database_not_prepared');
      await db.query(
        `INSERT INTO "Word"(id,lemma,"normalizedLemma","goalTags","sourceRef","contentVersion","updatedAt")
      VALUES($1,$2,$2,'{}','synthetic-polish','synthetic',NOW())`,
        [wordId, prefix],
      );
      await db.query(
        `INSERT INTO "Sense"(id,"wordId",pos,"definitionZh",ordinal,"contentMetadata")
      VALUES($1,$4,'n.',$5,-20000,'{}'),($2,$4,'n.','管理员改过的释义',-19999,'{}'),
        ($3,$4,'','待补词性的合成释义',0,'{}')`,
        [senseId, editedId, fillId, wordId, source],
      );
      await db.query(
        `INSERT INTO "User"(id,name,email,"updatedAt") VALUES($1,'Synthetic',$2,NOW())`,
        [userId, email],
      );
      await db.query(
        `INSERT INTO "StudyProgress"(id,"userId","wordId","fsrsJson","dueAt",revision,"updatedAt")
      VALUES($1,$2,$3,'{"reps":3,"stability":9}',NOW(),4,NOW())`,
        [prefix + '-progress', userId, wordId],
      );
      await db.query(
        `INSERT INTO "Book"(id,slug,title,description,goal,status,version,"ownerId","updatedAt")
      VALUES($1,$1,'Synthetic public','','daily','published','ecdict-synthetic',NULL,NOW()),
        ($2,$2,'Synthetic private','','daily','published','private-fixture',$3,NOW())`,
        [publicBook, privateBook, userId],
      );
      await db.query(
        `INSERT INTO "BookItem"(id,"bookId","wordId","focusSenseId",ordinal)
      VALUES($1,$2,$5,$6,0),($3,$4,$5,$6,0)`,
        [publicBook + '-item', publicBook, privateBook + '-item', privateBook, wordId, senseId],
      );
      const before = await snapshot();
      // A missing final word rolls back all earlier correction, POS and focus writes.
      await expect(
        importBilingualRows(
          { id: site.siteId, databaseUrl: databaseUrl! },
          [...rows, { normalizedLemma: prefix + '-missing', senses: [], examples: [] }],
          { ...manifest, wordCount: 2 },
        ),
      ).rejects.toThrow('words_missing');
      expect(await snapshot()).toEqual(before);
      expect((await db.query('SELECT * FROM "Sense" WHERE id=$1', [correctionId])).rowCount).toBe(
        0,
      );
      expect(
        (await db.query('SELECT pos,"definitionEn" FROM "Sense" WHERE id=$1', [fillId])).rows[0],
      ).toEqual({ pos: '', definitionEn: '' });
      const result = await importBilingualRows(
        { id: site.siteId, databaseUrl: databaseUrl! },
        rows,
        manifest,
      );
      expect(result).toMatchObject({
        matchedWords: 1,
        correctedSenses: 1,
        posFields: 1,
        translatedFields: 1,
        conflicts: 1,
        focusItems: 1,
      });
      expect(await snapshot()).toEqual(before);
      expect(
        (await db.query('SELECT "focusSenseId" FROM "BookItem" WHERE "bookId"=$1', [publicBook]))
          .rows[0].focusSenseId,
      ).toBe(correctionId);
      expect(
        (await db.query('SELECT * FROM "Sense" WHERE id=$1', [senseId])).rows[0],
      ).toMatchObject({
        definitionZh: source,
        definitionEn: '',
        pos: 'n.',
        contentMetadata: {
          lexicalQuality: {
            excludeFromLearning: true,
            replacementSenseId: correctionId,
            sourceTextSha256: hash(source),
          },
        },
      });
      expect(
        (await db.query('SELECT * FROM "Sense" WHERE id=$1', [editedId])).rows[0],
      ).toMatchObject({ definitionZh: '管理员改过的释义', contentMetadata: {} });
      const installed = (
        await db.query('SELECT * FROM "Sense" WHERE "wordId"=$1 ORDER BY id', [wordId])
      ).rows;
      await expect(
        importBilingualRows({ id: site.siteId, databaseUrl: databaseUrl! }, rows, manifest),
      ).resolves.toMatchObject({ alreadyInstalled: true });
      expect(
        (await db.query('SELECT * FROM "Sense" WHERE "wordId"=$1 ORDER BY id', [wordId])).rows,
      ).toEqual(installed);
      await db.query('UPDATE "BookItem" SET "focusSenseId"=$2 WHERE "bookId"=$1', [
        publicBook,
        senseId,
      ]);
      // A concurrent administrator edit wins over a repair calculated from the
      // old held focus. Exercise PostgreSQL's actual lock-wait/recheck path.
      const editor = new Client({ connectionString: databaseUrl });
      await editor.connect();
      let repair: Promise<number> | undefined;
      try {
        const repairPid = (await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        await editor.query('BEGIN');
        await editor.query('UPDATE "BookItem" SET "focusSenseId"=$2 WHERE "bookId"=$1', [
          publicBook,
          fillId,
        ]);
        repair = repairHeldDefaultFocus(db, [wordId]);
        let waiting = false;
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          waiting =
            (
              await editor.query('SELECT "wait_event_type" FROM pg_stat_activity WHERE pid=$1', [
                repairPid,
              ])
            ).rows[0]?.wait_event_type === 'Lock';
          if (waiting) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await editor.query('COMMIT');
        expect(waiting).toBe(true);
        expect(await repair).toBe(0);
        expect(
          (await db.query('SELECT "focusSenseId" FROM "BookItem" WHERE "bookId"=$1', [publicBook]))
            .rows[0].focusSenseId,
        ).toBe(fillId);
      } finally {
        await editor.query('ROLLBACK');
        if (repair) await repair;
        await editor.end();
      }
      await db.query('UPDATE "BookItem" SET "focusSenseId"=$2 WHERE "bookId"=$1', [
        publicBook,
        senseId,
      ]);
      expect(await repairHeldDefaultFocus(db, [wordId])).toBe(1);
      expect(
        (await db.query('SELECT "focusSenseId" FROM "BookItem" WHERE "bookId"=$1', [publicBook]))
          .rows[0].focusSenseId,
      ).toBe(correctionId);
      expect(await snapshot()).toEqual(before);
      // A conflicting correction ID must not retire its anchor or leave a ready pack.
      const conflictManifest = { ...manifest, id: prefix + '-conflict', sha256: hash('conflict') };
      const conflictRows: BilingualRow[] = [
        {
          normalizedLemma: prefix,
          senses: [],
          examples: [],
          corrections: [{ ...correction, definitionEn: 'A different conflicting text.' }],
        },
      ];
      await expect(
        importBilingualRows(
          { id: site.siteId, databaseUrl: databaseUrl! },
          conflictRows,
          conflictManifest,
        ),
      ).rejects.toThrow('correction_identity_conflict');
      expect(
        (await db.query('SELECT * FROM "ContentPack" WHERE id=$1', [conflictManifest.id])).rowCount,
      ).toBe(0);
      expect(
        (await db.query('SELECT * FROM "Sense" WHERE "wordId"=$1 ORDER BY id', [wordId])).rows,
      ).toEqual(installed);
      const withdrawalManifest = {
        ...manifest,
        id: prefix + '-withdrawal',
        sha256: hash('withdrawal'),
      };
      const withdrawalRows: BilingualRow[] = [
        {
          normalizedLemma: prefix,
          senses: [],
          examples: [],
          defaultBookWithdrawal: {
            sourceSenseId: senseId,
            sourceDefinitionZhSha256: hash(source),
            sourceRef: 'synthetic-polish',
            contentVersion: 'synthetic',
            reason: 'A deliberately malformed default-book test entry.',
            evidenceUrls: [],
          },
        },
      ];
      await expect(
        importBilingualRows(
          { id: site.siteId, databaseUrl: databaseUrl! },
          withdrawalRows,
          withdrawalManifest,
        ),
      ).resolves.toMatchObject({ withdrawnBookItems: 1, conflicts: 0 });
      expect(
        (await db.query('SELECT * FROM "BookItem" WHERE "bookId"=$1', [publicBook])).rowCount,
      ).toBe(0);
      expect(await snapshot()).toEqual(before);
      expect(
        (await db.query('SELECT * FROM "Sense" WHERE "wordId"=$1 ORDER BY id', [wordId])).rows,
      ).toEqual(installed);
    } finally {
      await db.query('DELETE FROM "Book" WHERE id=ANY($1::text[])', [[publicBook, privateBook]]);
      await db.query('DELETE FROM "User" WHERE id=$1 AND email=$2', [userId, email]);
      await db.query(`DELETE FROM "Word" WHERE id=$1 AND "sourceRef"='synthetic-polish'`, [wordId]);
      await db.query('DELETE FROM "ContentPack" WHERE id=ANY($1::text[])', [
        [manifest.id, manifest.id + '-conflict', manifest.id + '-withdrawal'],
      ]);
      await db.end();
    }
  },
);

it
  .skipIf(!databaseUrl)
  .each([
    'changed-source',
    'site-authored',
    'example-collision',
    'installed-conflicts',
    'explicit-nonstrict',
    'success',
  ] as const)('strict bilingual installation is atomic: %s', async (scenario) => {
  if (!new URL(databaseUrl!).pathname.endsWith('_test'))
    throw new Error('use_a_disposable_test_database');
  const db = new Client({ connectionString: databaseUrl });
  await db.connect();
  const prefix = 'strict-polish-fixture-' + randomUUID();
  const wordId = prefix + '-word',
    anchorId = prefix + '-anchor',
    fillId = prefix + '-fill',
    conflictId = prefix + '-conflict',
    bookId = prefix + '-book';
  const source = '待独立校正的原始释义',
    fillSource = '待补译文和词性的原始释义',
    conflictSource = '最初待译的原始释义';
  const defaultPolicy = scenario === 'changed-source' || scenario === 'explicit-nonstrict';
  const manifest: BilingualManifest = {
    formatVersion: 1,
    id: defaultPolicy ? 'bilingual-v2' : prefix + '-pack',
    version: 'synthetic-strict',
    fileName: 'fixture.jsonl.gz',
    bytes: 1,
    sha256: hash(prefix),
    jsonlSha256: hash(prefix + '-jsonl'),
    wordCount: 1,
    scope: 'Synthetic atomicity fixture',
    sourceUrl: 'https://example.invalid/' + prefix,
    license: 'MIT',
  };
  const exampleEn = `The ${prefix} appears in this synthetic example.`;
  const exampleId = 'bilingual-example-' + hash(prefix + '\0' + exampleEn);
  const correctionId = 'bilingual-sense-' + hash(prefix + '-correction');
  const rows: BilingualRow[] = [
    {
      normalizedLemma: prefix,
      senses: [
        {
          id: fillId,
          definitionEn: 'An independently translated synthetic adjective.',
          pos: 'adj.',
          sourceDefinitionZhSha256: hash(fillSource),
          contentMetadata: {
            definitionEn: { ...authored, sourceTextSha256: hash(fillSource) },
            pos: { ...authored, sourceTextSha256: hash(fillSource) },
          },
        },
      ],
      corrections: [
        {
          id: correctionId,
          replacesSenseId: anchorId,
          sourceDefinitionZhSha256: hash(source),
          sourceDefinitionEnSha256: hash(''),
          sourcePos: 'n.',
          definitionZh: '独立校正的合成释义',
          definitionEn: 'An independently corrected synthetic definition.',
          pos: 'n.',
          reason: 'The synthetic source deliberately needs a correction.',
          contentMetadata: { definitionZh: authored, definitionEn: authored },
        },
      ],
      examples: [
        {
          exampleEn,
          exampleZh: '这是一条独立撰写的合成例句。',
          contentMetadata: {
            exampleEn: { ...authored, language: 'en', sourceTextSha256: hash(exampleEn) },
            exampleZh: { ...authored, sourceLanguage: 'en', sourceTextSha256: hash(exampleEn) },
          },
        },
      ],
    },
  ];
  if (
    ['changed-source', 'site-authored', 'installed-conflicts', 'explicit-nonstrict'].includes(
      scenario,
    )
  )
    rows[0]!.senses.push({
      id: conflictId,
      definitionEn: 'This translation must never replace a protected or changed source.',
      contentMetadata: {
        definitionEn: { ...authored, sourceTextSha256: hash(conflictSource) },
      },
    });
  const snapshot = async () => ({
    word: (await db.query('SELECT * FROM "Word" WHERE id=$1', [wordId])).rows,
    senses: (await db.query('SELECT * FROM "Sense" WHERE "wordId"=$1 ORDER BY id', [wordId])).rows,
    examples: (
      await db.query('SELECT * FROM "WordExample" WHERE "wordId"=$1 ORDER BY id', [wordId])
    ).rows,
    items: (await db.query('SELECT * FROM "BookItem" WHERE "bookId"=$1 ORDER BY id', [bookId]))
      .rows,
    pack: (await db.query('SELECT * FROM "ContentPack" WHERE id=$1', [manifest.id])).rows,
  });

  try {
    // Never borrow, overwrite or clean up a pre-existing default package.
    expect(
      (await db.query('SELECT id FROM "ContentPack" WHERE id=$1', [manifest.id])).rowCount,
    ).toBe(0);
    const siteId = (await db.query('SELECT "siteId" FROM "SiteState" WHERE id=\'singleton\''))
      .rows[0]?.siteId;
    if (!siteId) throw new Error('test_database_not_prepared');
    const site = { id: siteId, databaseUrl: databaseUrl! };
    await db.query(
      `INSERT INTO "Word"(id,lemma,"normalizedLemma","goalTags","sourceRef","contentVersion","updatedAt")
       VALUES($1,$2,$2,'{}','synthetic-strict-polish','synthetic',NOW())`,
      [wordId, prefix],
    );
    await db.query(
      `INSERT INTO "Sense"(id,"wordId",pos,"definitionZh",ordinal,"contentMetadata")
       VALUES($1,$4,'n.',$5,0,'{}'),($2,$4,'',$6,1,'{}'),($3,$4,'n.',$7,2,$8::jsonb)`,
      [
        anchorId,
        fillId,
        conflictId,
        wordId,
        source,
        fillSource,
        scenario === 'site-authored' ? conflictSource : '管理员已经改过的另一项释义',
        JSON.stringify(
          scenario === 'site-authored'
            ? { definitionZh: { kind: 'site-authored', review: 'source' } }
            : {},
        ),
      ],
    );
    await db.query(
      `INSERT INTO "Book"(id,slug,title,description,goal,status,version,"ownerId","updatedAt")
       VALUES($1,$1,'Synthetic strict book','','daily','published','ecdict-synthetic',NULL,NOW())`,
      [bookId],
    );
    await db.query(
      `INSERT INTO "BookItem"(id,"bookId","wordId","focusSenseId",ordinal) VALUES($1,$2,$3,$4,0)`,
      [bookId + '-item', bookId, wordId, anchorId],
    );
    if (scenario === 'example-collision')
      await db.query(
        `INSERT INTO "WordExample"(id,"wordId","exampleEn","exampleZh","contentMetadata",ordinal)
         VALUES($1,$2,$3,'管理员保留的不同译文','{"exampleZh":{"kind":"site-authored"}}',7)`,
        [exampleId, wordId, exampleEn],
      );
    if (scenario === 'installed-conflicts' || scenario === 'explicit-nonstrict') {
      const installed = await importBilingualRows(site, rows, manifest, { strict: false });
      expect(installed).toMatchObject({
        alreadyInstalled: false,
        translatedFields: 1,
        posFields: 1,
        correctedSenses: 1,
        focusItems: 1,
        examples: 1,
        conflicts: 1,
      });
      const beforeReplay = await snapshot();
      expect(beforeReplay.pack[0]).toMatchObject({ status: 'ready', tagCounts: { conflicts: 1 } });
      await expect(
        importBilingualRows(site, rows, manifest, defaultPolicy ? undefined : { strict: true }),
      ).rejects.toThrow('bilingual_installed_pack_has_conflicts');
      expect(await snapshot()).toEqual(beforeReplay);
      return;
    }
    const before = await snapshot();
    if (scenario === 'success') {
      const installed = await importBilingualRows(site, rows, manifest, { strict: true });
      expect(installed).toMatchObject({
        alreadyInstalled: false,
        translatedFields: 1,
        posFields: 1,
        correctedSenses: 1,
        focusItems: 1,
        examples: 1,
        conflicts: 0,
      });
      const after = await snapshot();
      expect(after.pack[0]).toMatchObject({ status: 'ready', tagCounts: { conflicts: 0 } });
      expect(after.senses.find((sense) => sense.id === fillId)).toMatchObject({
        pos: 'adj.',
        definitionEn: rows[0]!.senses[0]!.definitionEn,
      });
      expect(after.senses.some((sense) => sense.id === correctionId)).toBe(true);
      expect(after.items[0].focusSenseId).toBe(correctionId);
      await expect(
        importBilingualRows(site, rows, manifest, { strict: true }),
      ).resolves.toMatchObject({
        alreadyInstalled: true,
      });
      expect(await snapshot()).toEqual(after);
    } else {
      await expect(
        importBilingualRows(site, rows, manifest, defaultPolicy ? undefined : { strict: true }),
      ).rejects.toThrow(
        scenario === 'example-collision'
          ? 'bilingual_example_identity_conflict'
          : 'bilingual_strict_source_conflict',
      );
      // The error comes after successful field, POS, correction and focus work.
      // Compare every scoped row, including the prior collision and ready marker.
      expect(await snapshot()).toEqual(before);
      expect((await db.query('SELECT id FROM "Sense" WHERE id=$1', [correctionId])).rowCount).toBe(
        0,
      );
    }
  } finally {
    await db.query('DELETE FROM "Book" WHERE id=$1', [bookId]);
    await db.query('DELETE FROM "Word" WHERE id=$1 AND "sourceRef"=\'synthetic-strict-polish\'', [
      wordId,
    ]);
    await db.query('DELETE FROM "ContentPack" WHERE id=$1 AND sha256=$2 AND "sourceUrl"=$3', [
      manifest.id,
      manifest.sha256,
      manifest.sourceUrl,
    ]);
    await db.end();
  }
});

it
  .skipIf(!databaseUrl)
  .each([
    'success',
    'en-and-zh-success',
    'changed-en',
    'changed-zh',
    'site-authored-en',
    'site-authored-zh',
    'wrong-word',
    'nonstrict-conflict',
    'missing-en-provenance',
    'invalid-zh-provenance',
    'invalid-en-kind',
    'blank-zh-kind',
    'wrong-translation-chain',
  ] as const)('corrects pinned example text without changing identity: %s', async (scenario) => {
  if (!new URL(databaseUrl!).pathname.endsWith('_test'))
    throw new Error('use_a_disposable_test_database');
  const db = new Client({ connectionString: databaseUrl });
  await db.connect();
  const prefix = 'example-polish-fixture-' + randomUUID();
  const wordId = prefix + '-word',
    otherWordId = prefix + '-other-word',
    senseId = prefix + '-sense',
    firstId = prefix + '-first',
    targetId = prefix + '-target',
    oldPackId = prefix + '-original-pack';
  const replaceEnglish = scenario === 'en-and-zh-success' || scenario === 'changed-en';
  const oldEn = 'Please close the window.\r\n',
    oldZh = '  请打开窗户。\r\n',
    newZh = replaceEnglish ? '窗户已经关上了。' : '请关上窗户。',
    senseZh = '用于事务回滚验证的合成释义';
  const originalMetadata = {
    packId: oldPackId,
    exampleEn: { kind: 'recorded-source', source: 'Synthetic public source', review: 'source' },
    exampleZh: {
      kind: 'source',
      license: 'Synthetic license',
      attribution: ['Original author'],
    },
    customNested: { keep: ['exactly', { value: 7 }] },
    translationCorrection: { originalText: '更早的合成原文', packId: 'earlier-fixture' },
  };
  const targetMetadata = {
    ...originalMetadata,
    ...(scenario === 'site-authored-en'
      ? { exampleEn: { kind: 'site-authored', review: 'source' } }
      : {}),
    ...(scenario === 'site-authored-zh'
      ? { exampleZh: { kind: 'site-authored', review: 'source' } }
      : {}),
    ...(scenario === 'missing-en-provenance' ? { exampleEn: undefined } : {}),
    ...(scenario === 'invalid-zh-provenance' ? { exampleZh: [] } : {}),
    ...(scenario === 'invalid-en-kind' ? { exampleEn: { kind: 42 } } : {}),
    ...(scenario === 'blank-zh-kind' ? { exampleZh: { kind: ' ' } } : {}),
  };
  const manifest: BilingualManifest = {
    formatVersion: 1,
    id: scenario === 'changed-en' ? 'bilingual-v2' : prefix + '-pack',
    version: 'synthetic-example-correction',
    fileName: 'fixture.jsonl.gz',
    bytes: 1,
    sha256: hash(prefix),
    jsonlSha256: hash(prefix + '-jsonl'),
    wordCount: 1,
    scope: 'Synthetic existing-example Chinese corrections',
    sourceUrl: 'https://example.invalid/' + prefix,
    license: 'MIT',
  };
  const correction = {
    sourceExampleEnSha256: hash(oldEn),
    sourceExampleZhSha256: hash(oldZh),
    exampleZh: newZh,
    ...(replaceEnglish ? { exampleEn: 'The window is closed.' } : {}),
    reason: 'The original synthetic Chinese reverses the action.',
    contentMetadata: {
      exampleZh: {
        ...authored,
        sourceLanguage: 'en' as const,
        sourceTextSha256: hash(replaceEnglish ? 'The window is closed.' : oldEn),
        translatedFrom: replaceEnglish
          ? { ...authored, language: 'en', sourceTextSha256: hash('The window is closed.') }
          : originalMetadata.exampleEn,
      },
      ...(replaceEnglish
        ? {
            exampleEn: {
              ...authored,
              language: 'en' as const,
              sourceTextSha256: hash('The window is closed.'),
            },
          }
        : {}),
    },
  };
  const rows: BilingualRow[] = [
    {
      normalizedLemma: prefix,
      senses: [
        {
          id: senseId,
          definitionEn: 'A synthetic definition for checking transaction rollback.',
          contentMetadata: {
            definitionEn: { ...authored, sourceTextSha256: hash(senseZh) },
          },
        },
      ],
      examples: [],
      exampleCorrections: [
        { ...correction, id: firstId },
        {
          ...correction,
          id: targetId,
          ...(scenario === 'wrong-translation-chain'
            ? {
                contentMetadata: {
                  ...correction.contentMetadata,
                  exampleZh: {
                    ...correction.contentMetadata.exampleZh,
                    translatedFrom: { kind: 'corpus', source: 'A different, unbound source' },
                  },
                },
              }
            : {}),
        },
      ],
    },
  ];
  const snapshot = async () => ({
    words: (
      await db.query('SELECT * FROM "Word" WHERE id=ANY($1::text[]) ORDER BY id', [
        [wordId, otherWordId],
      ])
    ).rows,
    senses: (await db.query('SELECT * FROM "Sense" WHERE "wordId"=$1 ORDER BY id', [wordId])).rows,
    examples: (
      await db.query('SELECT * FROM "WordExample" WHERE id=ANY($1::text[]) ORDER BY id', [
        [firstId, targetId],
      ])
    ).rows,
    packs: (
      await db.query('SELECT * FROM "ContentPack" WHERE id=ANY($1::text[]) ORDER BY id', [
        [oldPackId, manifest.id],
      ])
    ).rows,
  });
  try {
    const siteId = (await db.query('SELECT "siteId" FROM "SiteState" WHERE id=\'singleton\''))
      .rows[0]?.siteId;
    if (!siteId) throw new Error('test_database_not_prepared');
    const site = { id: siteId, databaseUrl: databaseUrl! };
    expect(
      (await db.query('SELECT id FROM "ContentPack" WHERE id=$1', [manifest.id])).rowCount,
    ).toBe(0);
    await db.query(
      `INSERT INTO "Word"(id,lemma,"normalizedLemma","goalTags","sourceRef","contentVersion","updatedAt")
     VALUES($1,$3,$3,'{}','synthetic-example-polish','synthetic',NOW()),
       ($2,$4,$4,'{}','synthetic-example-polish','synthetic',NOW())`,
      [wordId, otherWordId, prefix, prefix + '-other'],
    );
    await db.query(
      `INSERT INTO "Sense"(id,"wordId",pos,"definitionZh",ordinal,"contentMetadata")
     VALUES($1,$2,'n.',$3,0,'{}')`,
      [senseId, wordId, senseZh],
    );
    await db.query(
      `INSERT INTO "ContentPack"(id,version,status,"sourceUrl",sha256,license,"entryCount","phoneticCount","definitionZhCount","definitionEnCount","tagCounts","updatedAt")
     VALUES($1,'original-fixture','ready',$2,$3,'Synthetic',0,0,0,0,'{"untouched":true}',NOW())`,
      [oldPackId, manifest.sourceUrl, hash(oldPackId)],
    );
    await db.query(
      `INSERT INTO "WordExample"(id,"wordId","exampleEn","exampleZh","contentMetadata",ordinal)
     VALUES($1,$3,$5,$6,$7::jsonb,17),($2,$4,$8,$9,$10::jsonb,29)`,
      [
        firstId,
        targetId,
        wordId,
        scenario === 'wrong-word' ? otherWordId : wordId,
        oldEn,
        oldZh,
        JSON.stringify(originalMetadata),
        scenario === 'changed-en' ? oldEn.trim() : oldEn,
        scenario === 'changed-zh' || scenario === 'nonstrict-conflict' ? oldZh.trim() : oldZh,
        JSON.stringify(targetMetadata),
      ],
    );
    const before = await snapshot();
    if (scenario === 'nonstrict-conflict') {
      const installed = await importBilingualRows(site, rows, manifest);
      expect(installed).toMatchObject({
        exampleTranslations: 1,
        conflicts: 1,
        translatedFields: 1,
      });
      const after = await snapshot();
      expect(after.examples.find((example) => example.id === targetId)).toEqual(
        before.examples.find((example) => example.id === targetId),
      );
      expect(after.examples.find((example) => example.id === firstId)?.exampleZh).toBe(newZh);
      expect(after.packs.find((pack) => pack.id === manifest.id)).toMatchObject({
        tagCounts: { exampleTranslations: 1, conflicts: 1 },
      });
      await expect(importBilingualRows(site, rows, manifest, { strict: true })).rejects.toThrow(
        'bilingual_installed_pack_has_conflicts',
      );
      expect(await snapshot()).toEqual(after);
      return;
    }
    if (scenario !== 'success' && scenario !== 'en-and-zh-success') {
      await expect(
        importBilingualRows(
          site,
          rows,
          manifest,
          scenario === 'changed-en' ? undefined : { strict: true },
        ),
      ).rejects.toThrow('bilingual_strict_source_conflict');
      // Both an earlier Sense fill and the first valid example correction ran
      // before the final guard failed. Neither may escape the transaction.
      expect(await snapshot()).toEqual(before);
      return;
    }
    const installed = await importBilingualRows(site, rows, manifest, { strict: true });
    expect(installed).toMatchObject({
      exampleTranslations: 2,
      conflicts: 0,
      translatedFields: 1,
    });
    const after = await snapshot();
    expect(after.words).toEqual(before.words);
    expect(after.packs.find((pack) => pack.id === oldPackId)).toEqual(before.packs[0]);
    expect(after.packs.find((pack) => pack.id === manifest.id)).toMatchObject({
      tagCounts: { exampleTranslations: 2, conflicts: 0 },
    });
    for (const example of after.examples) {
      const original = before.examples.find((entry) => entry.id === example.id);
      expect(example).toEqual({
        ...original,
        ...(scenario === 'en-and-zh-success' ? { exampleEn: correction.exampleEn } : {}),
        exampleZh: newZh,
        contentMetadata: {
          ...originalMetadata,
          ...(scenario === 'en-and-zh-success'
            ? { exampleEn: correction.contentMetadata.exampleEn }
            : {}),
          exampleZh: correction.contentMetadata.exampleZh,
          packId: manifest.id,
          translationCorrection: {
            originalExampleEn: oldEn,
            originalText: oldZh,
            originalMetadata,
            originalPackId: oldPackId,
            sourceExampleEnSha256: hash(oldEn),
            sourceExampleZhSha256: hash(oldZh),
            reason: correction.reason,
            packId: manifest.id,
          },
        },
      });
    }
    await expect(
      importBilingualRows(site, rows, manifest, { strict: true }),
    ).resolves.toMatchObject({
      alreadyInstalled: true,
      exampleTranslations: 0,
      translatedFields: 0,
    });
    expect(await snapshot()).toEqual(after);
  } finally {
    await db.query(
      'DELETE FROM "Word" WHERE id=ANY($1::text[]) AND "sourceRef"=\'synthetic-example-polish\'',
      [[wordId, otherWordId]],
    );
    await db.query('DELETE FROM "ContentPack" WHERE id=ANY($1::text[]) AND "sourceUrl"=$2', [
      [oldPackId, manifest.id],
      manifest.sourceUrl,
    ]);
    await db.end();
  }
});

it.skipIf(!databaseUrl)(
  'rechecks a locked example after a concurrent administrator edit',
  async () => {
    if (!new URL(databaseUrl!).pathname.endsWith('_test'))
      throw new Error('use_a_disposable_test_database');
    const db = new Client({ connectionString: databaseUrl });
    const editor = new Client({ connectionString: databaseUrl });
    await db.connect();
    await editor.connect();
    const prefix = 'example-lock-fixture-' + randomUUID();
    const wordId = prefix + '-word',
      exampleId = prefix + '-example';
    const exampleEn = 'Please close the window.',
      exampleZh = '请打开窗户。';
    const originalEnglishProvenance = { kind: 'corpus', source: 'Synthetic lock fixture' };
    let correction: ReturnType<typeof applyExampleTranslationCorrections> | undefined;
    try {
      await db.query(
        `INSERT INTO "Word"(id,lemma,"normalizedLemma","goalTags","sourceRef","contentVersion","updatedAt")
     VALUES($1,$2,$2,'{}','synthetic-example-lock','synthetic',NOW())`,
        [wordId, prefix],
      );
      await db.query(
        `INSERT INTO "WordExample"(id,"wordId","exampleEn","exampleZh","contentMetadata",ordinal)
     VALUES($1,$2,$3,$4,$5::jsonb,4)`,
        [
          exampleId,
          wordId,
          exampleEn,
          exampleZh,
          JSON.stringify({ exampleEn: originalEnglishProvenance, exampleZh: { kind: 'source' } }),
        ],
      );
      const pid = (await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await editor.query('BEGIN');
      await editor.query(
        `UPDATE "WordExample" SET "exampleZh"='管理员保留的译文',
     "contentMetadata"='{"exampleZh":{"kind":"site-authored"},"customNote":"preserve"}' WHERE id=$1`,
        [exampleId],
      );
      await db.query('BEGIN');
      correction = applyExampleTranslationCorrections(
        db,
        [
          {
            id: exampleId,
            wordId,
            sourceExampleEnSha256: hash(exampleEn),
            sourceExampleZhSha256: hash(exampleZh),
            exampleZh: '请关上窗户。',
            reason: 'Synthetic action reversal.',
            contentMetadata: {
              exampleZh: {
                ...authored,
                sourceLanguage: 'en',
                sourceTextSha256: hash(exampleEn),
                translatedFrom: originalEnglishProvenance,
              },
            },
          },
        ],
        prefix + '-pack',
      );
      let waiting = false;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        waiting =
          (await editor.query('SELECT "wait_event_type" FROM pg_stat_activity WHERE pid=$1', [pid]))
            .rows[0]?.wait_event_type === 'Lock';
        if (waiting) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await editor.query('COMMIT');
      expect(waiting).toBe(true);
      expect(await correction).toEqual({ exampleTranslations: 0, conflicts: 1 });
      await db.query('COMMIT');
      expect(
        (await db.query('SELECT * FROM "WordExample" WHERE id=$1', [exampleId])).rows[0],
      ).toMatchObject({
        exampleEn,
        exampleZh: '管理员保留的译文',
        ordinal: 4,
        contentMetadata: { exampleZh: { kind: 'site-authored' }, customNote: 'preserve' },
      });
    } finally {
      await editor.query('ROLLBACK');
      if (correction) await correction;
      await db.query('ROLLBACK');
      await db.query('DELETE FROM "Word" WHERE id=$1 AND "sourceRef"=\'synthetic-example-lock\'', [
        wordId,
      ]);
      await editor.end();
      await db.end();
    }
  },
);
