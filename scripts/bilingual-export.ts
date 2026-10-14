import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Client } from 'pg';
import { readConfig } from '../apps/api/src/config.js';
import { normalizeContentLemma } from './content-lib.js';

// Exports lexical content only: never users, private books, sessions, or credentials.
if (fs.existsSync('.env')) process.loadEnvFile('.env');
const { values } = parseArgs({
  options: {
    site: { type: 'string' },
    output: { type: 'string' },
    lemmas: { type: 'string' },
  },
  strict: true,
});
if (!values.output) throw new Error('Use --output with an explicit lexical export path');
const sites = readConfig().sites;
const site = values.site
  ? sites.find((entry) => entry.id === values.site)
  : sites.length === 1
    ? sites[0]
    : undefined;
if (!site) throw new Error('Select a configured --site');
const lemmas = values.lemmas
  ? [
      ...new Set(
        fs
          .readFileSync(values.lemmas, 'utf8')
          .split(/\r?\n/)
          .map(normalizeContentLemma)
          .filter(Boolean),
      ),
    ]
  : null;
const client = new Client({ connectionString: site.databaseUrl });
await client.connect();
try {
  const result = await client.query(
    `
    SELECT w."normalizedLemma", w.lemma, w."sourceRef", w."contentVersion",
      jsonb_agg(jsonb_build_object('id',s.id,'pos',s.pos,'definitionZh',s."definitionZh",
        'definitionEn',s."definitionEn",'exampleEn',s."exampleEn",'exampleZh',s."exampleZh",'ordinal',s.ordinal,
        'contentMetadata',s."contentMetadata")
        ORDER BY s.ordinal,s.id) AS senses
    FROM "Word" w JOIN "Sense" s ON s."wordId"=w.id
    WHERE w.status='published' AND (
      ($1::text[] IS NOT NULL AND w."normalizedLemma"=ANY($1::text[])) OR
      ($1::text[] IS NULL AND EXISTS (
        SELECT 1 FROM "BookItem" bi JOIN "Book" b ON b.id=bi."bookId"
        WHERE bi."wordId"=w.id AND b."ownerId" IS NULL AND b.status='published' AND b.version LIKE 'ecdict-%')))
    GROUP BY w.id ORDER BY w."normalizedLemma"`,
    [lemmas],
  );
  if (!result.rows.length) throw new Error('No published lexical content matched the selection');
  fs.mkdirSync(path.dirname(path.resolve(values.output)), { recursive: true });
  fs.writeFileSync(values.output, result.rows.map((row) => JSON.stringify(row)).join('\n') + '\n', {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      action: 'bilingual.export',
      words: result.rows.length,
      senses: result.rows.reduce((n, row) => n + row.senses.length, 0),
    }),
  );
} finally {
  await client.end();
}
