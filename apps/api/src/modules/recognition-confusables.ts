import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const normalize = (value: string) =>
  value.normalize('NFKC').toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/gu, ' ').trim();

/** Fixed public lexical evidence only. Exclusion is conservative across all senses. */
export function loadRecognitionConfusables(directory = path.resolve('data')) {
  const read = (name: string, limit: number) => {
    if (path.basename(name) !== name) throw new Error('recognition_index_path_invalid');
    const filename = path.join(directory, name),
      stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit)
      throw new Error('recognition_index_file_invalid');
    return fs.readFileSync(filename);
  };
  const manifest = JSON.parse(
    read('recognition-confusables-v1.manifest.json', 1024 * 1024).toString('utf8'),
  );
  if (
    manifest.formatVersion !== 1 ||
    manifest.id !== 'recognition-confusables-v1' ||
    manifest.fileName !== 'recognition-confusables-v1.json.gz' ||
    manifest.license !== 'WordNet-3.0' ||
    manifest.semanticQualityCertified !== false ||
    !Number.isSafeInteger(manifest.indexedWordCount) ||
    manifest.indexedWordCount > 20000 ||
    !Number.isSafeInteger(manifest.directedExclusionCount) ||
    manifest.directedExclusionCount > 1000000
  )
    throw new Error('recognition_index_manifest_invalid');
  const packed = read(manifest.fileName, 8 * 1024 * 1024);
  if (
    packed.length !== manifest.bytes ||
    sha(packed) !== manifest.sha256 ||
    sha(read(manifest.licenseNoticeFileName, 128 * 1024)) !== manifest.licenseNoticeSha256
  )
    throw new Error('recognition_index_checksum');
  const decoded = gunzipSync(packed, { maxOutputLength: 16 * 1024 * 1024 });
  if (sha(decoded) !== manifest.jsonSha256) throw new Error('recognition_index_decoded_checksum');
  const data = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(decoded));
  if (
    data.formatVersion !== 1 ||
    data.id !== manifest.id ||
    !data.words ||
    typeof data.words !== 'object' ||
    Array.isArray(data.words)
  )
    throw new Error('recognition_index_payload_invalid');
  const words = new Map<string, Set<string>>();
  let edges = 0;
  for (const [lemma, values] of Object.entries(data.words)) {
    if (
      !lemma ||
      normalize(lemma) !== lemma ||
      !Array.isArray(values) ||
      !values.length ||
      values.length > 20000 ||
      values.some(
        (word) => typeof word !== 'string' || !word || normalize(word) !== word || word === lemma,
      ) ||
      new Set(values).size !== values.length
    )
      throw new Error('recognition_index_word_invalid');
    edges += values.length;
    words.set(lemma, new Set(values as string[]));
  }
  if (words.size !== manifest.indexedWordCount || edges !== manifest.directedExclusionCount)
    throw new Error('recognition_index_counts');
  for (const [lemma, values] of words)
    for (const other of values)
      if (!words.get(other)?.has(lemma)) throw new Error('recognition_index_not_symmetric');
  return words;
}

let index: ReturnType<typeof loadRecognitionConfusables> | undefined;
export function recognitionWordsConfusable(a: string, b: string) {
  index ??= loadRecognitionConfusables();
  return Boolean(index.get(normalize(a))?.has(normalize(b)));
}
