import fs from 'node:fs';
import { createHash } from 'node:crypto';
import type { Sense, Prisma } from '@prisma/client';
import { z } from 'zod';
const schema = z
  .array(
    z.object({
      normalizedLemma: z.string(),
      senseId: z.string(),
      sourceTextSha256: z.string().regex(/^[a-f0-9]{64}$/),
      definitionZh: z.string().min(1),
      definitionEn: z.string().min(1),
      author: z.literal('NightStudy contributors'),
      license: z.literal('MIT'),
      kind: z.literal('original-authoring'),
      review: z.literal('pending'),
      authoringMethod: z.string(),
      reason: z.string(),
      usageEvidenceUrl: z.string().url(),
    }),
  )
  .max(100);
const views = schema.parse(
  JSON.parse(
    fs.readFileSync(new URL('../../../../data/learning-definitions.json', import.meta.url), 'utf8'),
  ),
);
const byId = new Map(views.map((view) => [view.senseId, view]));
if (byId.size !== views.length) throw new Error('duplicate_learning_usage_view');
export function learningDefinitionView(sense: Sense): Sense {
  const view = byId.get(sense.id);
  if (
    !view ||
    typeof sense.definitionZh !== 'string' ||
    createHash('sha256').update(sense.definitionZh, 'utf8').digest('hex') !== view.sourceTextSha256
  )
    return sense;
  const source =
    sense.contentMetadata &&
    typeof sense.contentMetadata === 'object' &&
    !Array.isArray(sense.contentMetadata)
      ? sense.contentMetadata
      : {};
  if (
    (typeof sense.definitionEn === 'string' && sense.definitionEn !== '') ||
    [source.definitionEn, source.definitionZh].some(
      (value) =>
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        value.kind === 'site-authored',
    )
  )
    return sense;
  const metadata = {
    kind: view.kind,
    review: view.review,
    author: view.author,
    license: view.license,
    authoringMethod: view.authoringMethod,
    sourceLanguage: 'zh',
    sourceTextSha256: view.sourceTextSha256,
    usageEvidenceUrl: view.usageEvidenceUrl,
    reason: view.reason,
  };
  return {
    ...sense,
    definitionZh: view.definitionZh,
    definitionEn: view.definitionEn,
    contentMetadata: {
      ...source,
      definitionZh: metadata,
      definitionEn: metadata,
      learningUsageView: true,
    } as Prisma.JsonObject,
  };
}
