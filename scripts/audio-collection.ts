import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { loadSentenceAudioPolicy } from '../apps/api/src/sentence-audio-policy.js';

export const sentenceAudioPackId = z.string().regex(/^sentence-audio-v4(?:-(?!0000)[0-9]{4})?$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().positive();
const collectionSchema = z
  .object({
    formatVersion: z.literal(1),
    kind: z.literal('sentence-audio-collection'),
    id: z.literal('sentence-audio-v4'),
    learningSensesManifestSha256: digest,
    learningSensesManifestFileName: z
      .string()
      .regex(/^learning-senses-collection-[a-z0-9-]+\.manifest\.json$/),
    pronunciationHoldsManifestFileName: z.literal('sentence-audio-holds-v1.manifest.json'),
    pronunciationHoldsManifestSha256: digest,
    entryCount: count.max(2_000_000),
    packs: z
      .array(
        z
          .object({
            id: sentenceAudioPackId,
            fileName: z.string().regex(/^sentence-audio-v4(?:-(?!0000)[0-9]{4})?\.manifest\.json$/),
            bytes: count.max(1024 * 1024),
            sha256: digest,
            lemmaCount: count.max(10000),
            entryCount: count.max(20000),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
  })
  .strict();

/** Only fixed, committed pins are accepted; no directory scan or moving release URL. */
export async function readSentenceAudioCollection(filename: string) {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
    throw new Error('sentence_audio_collection_file_invalid');
  const collection = collectionSchema.parse(JSON.parse(await fs.readFile(filename, 'utf8')));
  if (path.basename(filename) !== 'sentence-audio-v4.collection.json')
    throw new Error('sentence_audio_collection_filename_invalid');
  const pronunciationPolicy = loadSentenceAudioPolicy(path.dirname(filename));
  if (pronunciationPolicy.manifestSha256 !== collection.pronunciationHoldsManifestSha256)
    throw new Error('sentence_audio_collection_policy_pin_mismatch');
  const meaningFile = path.join(path.dirname(filename), collection.learningSensesManifestFileName);
  const meaningStat = await fs.lstat(meaningFile);
  if (
    !meaningStat.isFile() ||
    meaningStat.isSymbolicLink() ||
    meaningStat.size > 1024 * 1024 ||
    createHash('sha256')
      .update(await fs.readFile(meaningFile))
      .digest('hex') !== collection.learningSensesManifestSha256
  )
    throw new Error('sentence_audio_collection_meaning_pin_mismatch');
  if (
    new Set(collection.packs.map((pin) => pin.id)).size !== collection.packs.length ||
    new Set(collection.packs.map((pin) => pin.fileName)).size !== collection.packs.length ||
    collection.packs.reduce((n, pin) => n + pin.entryCount, 0) !== collection.entryCount
  )
    throw new Error('sentence_audio_collection_scope_mismatch');
  const pins = [];
  for (const pin of collection.packs) {
    if (pin.fileName !== `${pin.id}.manifest.json`)
      throw new Error('sentence_audio_collection_identity_mismatch');
    const file = path.join(path.dirname(filename), pin.fileName);
    const childStat = await fs.lstat(file);
    if (!childStat.isFile() || childStat.isSymbolicLink() || childStat.size !== pin.bytes)
      throw new Error('sentence_audio_collection_pin_file_invalid');
    const bytes = await fs.readFile(file);
    if (createHash('sha256').update(bytes).digest('hex') !== pin.sha256)
      throw new Error('sentence_audio_collection_pin_hash_mismatch');
    const source = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    if (
      source.id !== pin.id ||
      source.lemmaCount !== pin.lemmaCount ||
      source.entryCount !== pin.entryCount
    )
      throw new Error('sentence_audio_collection_pin_scope_mismatch');
    pins.push(source);
  }
  return { collection, pins, pronunciationPolicy };
}
