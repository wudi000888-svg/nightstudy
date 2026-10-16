import { describe, expect, it } from 'vitest';
import type { Sense, WordAudio, WordExample } from '@prisma/client';
import { wordDto, type WordWithSenses } from './shared.js';
import { catalogWordDto } from './content.js';
import {
  atomicSenseView,
  verifiedLearningSenses,
  type AtomicLearningSense,
} from './learning-sense-view.js';
import { learningSenseBindingHash, learningSenseTextHash } from './learning-sense-integrity.js';
import { supplementIssuedWord } from './content-presentation.js';

const source: Sense = {
  id: 'bank-source',
  wordId: 'bank',
  pos: 'n.',
  definitionZh: '银行；河岸',
  definitionEn: 'Source meanings for a financial organization and the side of a river.',
  ordinal: 0,
  exampleEn: 'An unreviewed source example must remain hidden.',
  exampleZh: '这条未绑定源句必须隐藏。',
  contentMetadata: {},
};
const example = (
  id: string,
  learningSenseId: string | null = 'bank-finance',
  extra: Partial<WordExample> = {},
): WordExample => ({
  id,
  wordId: 'bank',
  learningSenseId,
  status: 'published',
  contentVersion: 'atomic-v1',
  contextLabel: '办理账户',
  ordinal: 0,
  exampleEn: 'She opened an account at the bank.',
  exampleZh: '她在这家银行开了一个账户。',
  contentMetadata: {},
  ...extra,
});
function meaning(
  id = 'bank-finance',
  extra: Partial<AtomicLearningSense> = {},
): AtomicLearningSense {
  const binding = {
    id: `${id}-binding`,
    wordId: 'bank',
    learningSenseId: id,
    sourceSenseId: source.id,
    relation: 'narrower',
    sourcePosSha256: learningSenseTextHash(source.pos),
    sourceDefinitionZhSha256: learningSenseTextHash(source.definitionZh),
    sourceDefinitionEnSha256: learningSenseTextHash(source.definitionEn),
    contentMetadata: {},
    sourceSense: structuredClone(source),
  };
  const sense = {
    id,
    wordId: 'bank',
    pos: 'n.',
    definitionZh: '银行',
    definitionEn: 'an organization that keeps and lends money',
    ordinal: 0,
    status: 'published',
    contentVersion: 'atomic-v1',
    bindingHash: '',
    contentMetadata: {},
    sourceBindings: [binding],
    examples: [example(`${id}-example`, id)],
    ...extra,
  };
  return { ...sense, bindingHash: learningSenseBindingHash(sense) };
}
const audio = (accent: string): WordAudio => ({
  id: `bank-${accent}`,
  wordId: 'bank',
  accent,
  kind: 'recorded',
  status: 'ready',
  sourceName: 'Synthetic metadata fixture',
  sourceUrl: 'https://example.test/audio',
  license: 'MIT',
  attribution: 'Test fixture',
  fileKey: `files/${'d'.repeat(64)}.wav`,
  fileSha256: 'd'.repeat(64),
  mimeType: 'audio/wav',
  createdAt: new Date(0),
  updatedAt: new Date(0),
});
function word(learningSenses: AtomicLearningSense[] = [meaning()]): WordWithSenses {
  return {
    id: 'bank',
    lemma: 'bank',
    normalizedLemma: 'bank',
    phonetic: 'source-ipa',
    phoneticUs: 'us-ipa',
    phoneticUk: 'uk-ipa',
    phoneticSource: 'Original test metadata',
    difficulty: 1,
    status: 'published',
    goalTags: [],
    sourceRef: 'Original test fixture',
    contentVersion: 'dictionary-v1',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    senses: [structuredClone(source)],
    learningSenses,
    audio: [audio('US'), audio('UK')],
    examples: [
      example('candidate', null, {
        learningSenseId: null,
        status: 'candidate',
        exampleEn: 'A global candidate must never become an atomic example.',
        exampleZh: '全词候选句不得冒充义项例句。',
      }),
    ],
  };
}

describe('atomic learning evidence and publication boundaries', () => {
  it('accepts matching raw bytes and rejects drift independently in POS and both source languages', () => {
    expect(verifiedLearningSenses(word()).map((sense) => sense.id)).toEqual(['bank-finance']);
    for (const field of ['pos', 'definitionZh', 'definitionEn'] as const) {
      const bad = meaning();
      bad.sourceBindings[0]!.sourceSense[field] += ' ';
      expect(verifiedLearningSenses(word([bad]))).toEqual([]);
    }
  });
  it('rejects different word identities, source identities, empty evidence and binding hash drift', () => {
    const variants = [meaning(), meaning(), meaning(), meaning(), meaning(), meaning()];
    variants[0]!.wordId = 'other';
    variants[1]!.sourceBindings[0]!.wordId = 'other';
    variants[2]!.sourceBindings[0]!.learningSenseId = 'other';
    variants[3]!.sourceBindings[0]!.sourceSense.id = 'other';
    variants[4]!.sourceBindings = [];
    variants[5]!.bindingHash = 'f'.repeat(64);
    for (const bad of variants) expect(verifiedLearningSenses(word([bad]))).toEqual([]);
  });
  it('rejects changed semantic text or content version even while source hashes still match', () => {
    for (const field of ['pos', 'definitionZh', 'definitionEn', 'contentVersion'] as const) {
      const bad = meaning();
      bad[field] += ' changed';
      expect(verifiedLearningSenses(word([bad]))).toEqual([]);
    }
    for (const status of ['candidate', 'pending', 'held', 'superseded'])
      expect(verifiedLearningSenses(word([meaning('bank-finance', { status })]))).toEqual([]);
  });
  it('exposes only complete published examples attached to the same word and atomic sense', () => {
    const sense = meaning();
    sense.examples = [
      example('valid'),
      example('different-sense', 'river'),
      example('different-word', undefined, { wordId: 'river' }),
      example('candidate', undefined, { status: 'candidate' }),
      example('held', undefined, { status: 'held' }),
      example('old-version', undefined, { contentVersion: 'atomic-v0' }),
      example('empty-en', undefined, { exampleEn: ' ' }),
      example('empty-zh', undefined, { exampleZh: ' ' }),
      example('empty-context', undefined, { contextLabel: '' }),
    ];
    expect(atomicSenseView(sense).examples.map((entry) => entry.id)).toEqual(['valid']);
    const view = wordDto(word([sense]));
    expect(view.senses[0]!.examples.map((entry) => entry.id)).toEqual(['valid']);
    expect(JSON.stringify(view)).not.toContain('A global candidate must never');
    expect(JSON.stringify(view)).not.toContain('An unreviewed source example');
    expect(view).not.toHaveProperty('examples');
  });
  it('keeps financial and river examples separate and never uses unbound global usages in dictionary fallback', () => {
    const river = meaning('bank-river', {
      definitionZh: '河岸',
      definitionEn: 'the land beside a river',
      ordinal: 1,
      examples: [
        example('river-example', 'bank-river', {
          contextLabel: '河边休息',
          exampleEn: 'We sat on the river bank.',
          exampleZh: '我们坐在河岸上。',
        }),
      ],
    });
    const view = wordDto(word([meaning(), river]));
    expect(view.senses.map((sense) => sense.examples.map((entry) => entry.id))).toEqual([
      ['bank-finance-example'],
      ['river-example'],
    ]);
    const fallback = wordDto(word([]));
    expect(fallback.senses[0]!.kind).toBe('dictionary');
    expect(fallback.senses[0]!.examples).toEqual([]);
    expect(fallback.contentCoverage.bilingualExampleCount).toBe(0);
  });
  it('suppresses all ordinary phonetics and word audio when a verified meaning marks an incompatible pronunciation', () => {
    const safe = wordDto(word());
    expect(safe.audio).toHaveLength(2);
    expect(safe.phoneticUs).toBe('us-ipa');
    for (const status of ['published', 'held']) {
      const ambiguous = word([
        meaning('bank-finance', {
          status,
          contentMetadata: { pronunciation: { wordAudioCompatible: false } },
        }),
      ]);
      for (const dto of [wordDto(ambiguous), catalogWordDto(ambiguous)]) {
        expect(dto).toMatchObject({
          phonetic: '',
          phoneticUs: '',
          phoneticUk: '',
          audio: [],
          pronunciationCompatible: false,
        });
        if ('phonetics' in dto) expect(dto.phonetics).toEqual([]);
      }
    }
  });
  it('preserves signed snapshot identity and existing example text when current examples or evidence differ', () => {
    const snapshot = wordDto(word());
    const before = structuredClone(snapshot);
    const altered = word();
    altered.learningSenses![0]!.examples[0]!.exampleEn = 'A changed live sentence.';
    altered.learningSenses![0]!.examples.push(
      example('new-extra', 'bank-finance', {
        contextLabel: '贷款',
        exampleEn: 'The bank approved her loan.',
        exampleZh: '银行批准了她的贷款。',
      }),
    );
    const view = supplementIssuedWord(
      snapshot as unknown as Record<string, unknown>,
      wordDto(altered) as unknown as Record<string, unknown>,
      'bank',
    );
    expect(
      (view.senses as typeof snapshot.senses)[0]!.examples.map((entry) => entry.exampleEn),
    ).toEqual(['She opened an account at the bank.', 'The bank approved her loan.']);
    expect(snapshot).toEqual(before);
    const drift = word();
    drift.learningSenses![0]!.bindingHash = 'e'.repeat(64);
    expect(
      supplementIssuedWord(
        snapshot as unknown as Record<string, unknown>,
        wordDto(drift) as unknown as Record<string, unknown>,
        'bank',
      ).senses,
    ).toEqual(snapshot.senses);
  });
});
