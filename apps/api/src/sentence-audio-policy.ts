import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const normalize = (text: string) =>
  text.normalize('NFKC').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/gu, ' ').trim();
export const sentenceAudioIdentity = (textHash: string, accent: string) => textHash + '\0' + accent;

export const sentenceAudioHoldSchema = z
  .object({
    id: z.string().regex(/^sentence-audio-hold-[a-f0-9]{64}$/),
    text: z.string().min(15).max(4000),
    textHash: digest,
    accent: z.enum(['US', 'UK']),
    learningSenseId: z.string().regex(/^learning-sense-[a-f0-9]{64}$/),
    exampleId: z.string().regex(/^sense-example-[a-f0-9]{64}$/),
    riskCategory: z.enum([
      'wrong-lexeme',
      'insufficient-regional-evidence',
      'insufficient-reading-evidence',
    ]),
    review: z
      .object({
        reviewer: z.literal('Codex'),
        decision: z.literal('hold'),
        expertCertified: z.literal(false),
        reason: z
          .string()
          .min(15)
          .max(4000)
          .refine((value) => value.trim().length >= 15 && !/[\x00-\x1f]/u.test(value)),
      })
      .strict(),
  })
  .strict();
const policySchema = z
  .object({
    formatVersion: z.literal(1),
    id: z.literal('sentence-audio-holds-v1'),
    entries: z.array(sentenceAudioHoldSchema).max(5000),
  })
  .strict();
const manifestSchema = z
  .object({
    formatVersion: z.literal(1),
    id: z.literal('sentence-audio-holds-v1'),
    fileName: z.literal('sentence-audio-holds-v1.json'),
    bytes: z
      .number()
      .int()
      .positive()
      .max(4 * 1024 * 1024),
    sha256: digest,
    holdCount: z.number().int().nonnegative().max(5000),
    learningSensesManifestFileName: z
      .string()
      .regex(/^learning-senses-collection-[a-z0-9-]+\.manifest\.json$/),
    learningSensesManifestSha256: digest,
  })
  .strict();

export type SentenceAudioHold = z.infer<typeof sentenceAudioHoldSchema>;
export interface SentenceAudioPolicy {
  entries: SentenceAudioHold[];
  byIdentity: ReadonlyMap<string, SentenceAudioHold>;
  manifestSha256: string | null;
  manifest: z.infer<typeof manifestSchema> | null;
}

function fixedFile(directory: string, name: string, limit: number) {
  if (path.basename(name) !== name) throw new Error('sentence_audio_policy_path_invalid');
  const file = path.join(directory, name);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit)
    throw new Error('sentence_audio_policy_file_invalid');
  const bytes = fs.readFileSync(file);
  if (bytes.length !== stat.size) throw new Error('sentence_audio_policy_file_changed');
  return bytes;
}
function decode(bytes: Buffer) {
  const text = new TextDecoder('utf8', { fatal: true }).decode(bytes);
  const value: unknown = JSON.parse(text);
  const stack: { object: boolean; key: boolean; keys: Set<string> }[] = [];
  // JSON.parse validates syntax; this pass additionally rejects duplicate keys,
  // including escaped spellings of the same key, and unreasonable nesting.
  for (let i = 0; i < text.length; i++) {
    const token = text[i];
    if (token === '"') {
      const start = i;
      for (i++; i < text.length; i++) {
        if (text[i] === '\\') i++;
        else if (text[i] === '"') break;
      }
      const current = stack.at(-1);
      if (current?.object && current.key) {
        const key = JSON.parse(text.slice(start, i + 1)) as string;
        if (current.keys.has(key)) throw new Error('sentence_audio_policy_duplicate_json_key');
        current.keys.add(key);
        current.key = false;
      }
    } else if (token === '{' || token === '[') {
      if (stack.length >= 64) throw new Error('sentence_audio_policy_json_depth');
      stack.push({ object: token === '{', key: token === '{', keys: new Set() });
    } else if (token === '}' || token === ']') stack.pop();
    else if (token === ',' && stack.at(-1)?.object) stack.at(-1)!.key = true;
  }
  return value;
}

export function parseSentenceAudioHoldPolicy(bytes: Buffer) {
  if (bytes.length > 4 * 1024 * 1024) throw new Error('sentence_audio_policy_bytes_limit');
  const policy = policySchema.parse(decode(bytes));
  const byIdentity = new Map<string, SentenceAudioHold>();
  for (const entry of policy.entries) {
    const identity = sentenceAudioIdentity(entry.textHash, entry.accent);
    if (
      normalize(entry.text) !== entry.text ||
      sha(entry.text) !== entry.textHash ||
      entry.id !== 'sentence-audio-hold-' + sha(identity) ||
      byIdentity.has(identity)
    )
      throw new Error('sentence_audio_policy_identity_invalid');
    byIdentity.set(identity, entry);
  }
  return { entries: policy.entries, byIdentity };
}

/** Fixed release policy only: no remote configuration or per-request filesystem scans. */
export function loadSentenceAudioPolicy(directory = path.resolve('data')): SentenceAudioPolicy {
  const collectionName = 'sentence-audio-v4.collection.json';
  const manifestName = 'sentence-audio-holds-v1.manifest.json';
  const hasCollection = fs.existsSync(path.join(directory, collectionName));
  const hasManifest = fs.existsSync(path.join(directory, manifestName));
  const hasPayload = fs.existsSync(path.join(directory, 'sentence-audio-holds-v1.json'));
  if (!hasCollection && !hasManifest && !hasPayload)
    return { entries: [], byIdentity: new Map(), manifestSha256: null, manifest: null };
  // A partial policy installation must never silently reactivate old ready rows.
  if (!hasCollection || !hasManifest || !hasPayload)
    throw new Error('sentence_audio_policy_installation_incomplete');
  const collection = z
    .object({
      id: z.literal('sentence-audio-v4'),
      learningSensesManifestFileName: manifestSchema.shape.learningSensesManifestFileName,
      learningSensesManifestSha256: digest,
      pronunciationHoldsManifestFileName: z.literal('sentence-audio-holds-v1.manifest.json'),
      pronunciationHoldsManifestSha256: digest,
    })
    .passthrough()
    .parse(decode(fixedFile(directory, collectionName, 1024 * 1024)));
  const manifestBytes = fixedFile(directory, manifestName, 1024 * 1024);
  const manifest = manifestSchema.parse(decode(manifestBytes));
  if (
    sha(manifestBytes) !== collection.pronunciationHoldsManifestSha256 ||
    manifest.learningSensesManifestFileName !== collection.learningSensesManifestFileName ||
    manifest.learningSensesManifestSha256 !== collection.learningSensesManifestSha256 ||
    sha(fixedFile(directory, manifest.learningSensesManifestFileName, 1024 * 1024)) !==
      manifest.learningSensesManifestSha256
  )
    throw new Error('sentence_audio_policy_meaning_pin_mismatch');
  const bytes = fixedFile(directory, manifest.fileName, 4 * 1024 * 1024);
  if (bytes.length !== manifest.bytes || sha(bytes) !== manifest.sha256)
    throw new Error('sentence_audio_policy_checksum');
  const policy = parseSentenceAudioHoldPolicy(bytes);
  const { byIdentity } = policy;
  if (byIdentity.size !== manifest.holdCount)
    throw new Error('sentence_audio_policy_count_mismatch');
  return { entries: policy.entries, byIdentity, manifest, manifestSha256: sha(manifestBytes) };
}

let releasePolicy: SentenceAudioPolicy | undefined;
export function sentenceAudioHeld(textHash: string, accent: string) {
  releasePolicy ??= loadSentenceAudioPolicy();
  return releasePolicy.byIdentity.has(sentenceAudioIdentity(textHash, accent));
}
