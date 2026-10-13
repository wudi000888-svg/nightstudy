import { createHash } from 'node:crypto';

export const IPA_DICT_COMMIT = '43c3570eb3553bdd19fccd2bd0091534889af023';
const ipaLicense = {
  filename: 'LICENSE.ipa-dict.txt',
  url: `https://raw.githubusercontent.com/open-dict-data/ipa-dict/${IPA_DICT_COMMIT}/LICENSE`,
  sha256: '2c6a7e4c71f834a8fc0114fa4f65ca85e80bc4b4dc7ed08746963a09a7b0d177',
};
export const phoneticsPacks = {
  us: {
    id: 'ipa-us-43c3570eb355',
    locale: 'en-US',
    column: 'phoneticUs',
    version: IPA_DICT_COMMIT,
    license: 'MIT AND BSD-2-Clause',
    sourceUrl: `https://raw.githubusercontent.com/open-dict-data/ipa-dict/${IPA_DICT_COMMIT}/data/en_US.txt`,
    sha256: '2af6f154a5c363275f052d1f85acedef38ed185ca9745aa4314be77f6b70de67',
    sourceEntryCount: 125927,
    licenses: [
      ipaLicense,
      {
        filename: 'LICENSE.cmudict-ipa.txt',
        url: 'https://raw.githubusercontent.com/lingz/cmudict-ipa/629483e9a7fa5b9ff11bb83e3fda6dcc25c5c511/LICENSE',
        sha256: 'a504bede5a50d1ac19c38984d9bb33371927f72e714946a963bf40bb2de21188',
      },
      {
        filename: 'LICENSE.CMUdict.txt',
        url: 'https://raw.githubusercontent.com/cmusphinx/cmudict/74790861f652b15e4ac49015a90074ad62a27690/LICENSE',
        sha256: 'bd4ce8e44170a5f9f481310ca85c51de3c4f851a65e679b40e603b143bd3542a',
      },
    ],
  },
  uk: {
    id: 'ipa-uk-43c3570eb355',
    locale: 'en-GB',
    column: 'phoneticUk',
    version: IPA_DICT_COMMIT,
    license: 'GPL-3.0-only',
    sourceUrl: `https://raw.githubusercontent.com/open-dict-data/ipa-dict/${IPA_DICT_COMMIT}/data/en_UK.txt`,
    sha256: '221394caef0cf723b4f2df81a98ac33191293257b88aed5b1fb89466d3a0dc77',
    sourceEntryCount: 65119,
    licenses: [
      ipaLicense,
      {
        filename: 'LICENSE.ipacards.GPL-3.0.txt',
        url: 'https://raw.githubusercontent.com/melissaboiko/ipacards/ac25f24df0712562b3c4762e21880fced2ae0b92/LICENSE',
        sha256: '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903',
      },
    ],
  },
} as const;
export type PhoneticsPack = (typeof phoneticsPacks)[keyof typeof phoneticsPacks];
export const sha256 = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
export const normalizePhoneticLemma = (value: string) =>
  value.normalize('NFKC').trim().toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ');

/** Keeps all source variants and rejects malformed input; no spelling-to-IPA guessing. */
export function parsePhoneticsTsv(text: string) {
  const entries = new Map<string, { normalizedLemma: string; ipa: string }>();
  let sourceEntryCount = 0;
  for (const [index, line] of text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .entries()) {
    if (!line) continue;
    const cells = line.split('\t');
    if (cells.length !== 2) throw new Error(`Invalid phonetics TSV at line ${index + 1}`);
    const normalizedLemma = normalizePhoneticLemma(cells[0]!),
      ipa = cells[1]!.trim();
    if (
      !normalizedLemma ||
      normalizedLemma.length > 320 ||
      !/^\/[^/\t\r\n]+\/(?:,\s*\/[^/\t\r\n]+\/)*$/u.test(ipa)
    )
      throw new Error(`Invalid phonetics TSV at line ${index + 1}`);
    const previous = entries.get(normalizedLemma);
    const variants = [...new Set([...(previous?.ipa.split(/,\s*/) ?? []), ...ipa.split(/,\s*/)])];
    entries.set(normalizedLemma, { normalizedLemma, ipa: variants.join(', ') });
    sourceEntryCount++;
  }
  if (!entries.size) throw new Error('Phonetics source is empty');
  return { entries: [...entries.values()], sourceEntryCount };
}
