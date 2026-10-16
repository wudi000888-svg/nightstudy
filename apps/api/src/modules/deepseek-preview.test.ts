import { describe, expect, it } from 'vitest';
import type { Sense, WordExample } from '@prisma/client';
import {
  exactLemmaInExample,
  planMissingContent,
  previewMessages,
  sourceHash,
  sourceBoundPreview,
  validateMissingContent,
} from './deepseek-preview.js';

const sense = (extra: Partial<Sense> = {}): Sense => ({
  id: 'rain-zh',
  wordId: 'rain',
  pos: 'n.',
  definitionZh: '雨；雨水 ',
  definitionEn: '',
  exampleEn: '',
  exampleZh: '',
  ordinal: 0,
  contentMetadata: {},
  ...extra,
});
const word = (senses: Sense[] = [sense()], examples: WordExample[] = []) => ({
  id: 'rain',
  lemma: 'rain',
  normalizedLemma: 'rain',
  senses,
  examples,
});
const valid = () => {
  const plan = planMissingContent(word());
  return {
    plan,
    raw: {
      definitions: [
        {
          sourceSenseId: 'rain-zh',
          field: 'definitionEn',
          sourceTextSha256: sourceHash('雨；雨水 '),
          value: 'Water that falls from clouds in drops; rainwater.',
        },
      ],
      examples: [
        {
          sourceSenseId: 'rain-zh',
          sourceTextSha256: sourceHash('雨；雨水 '),
          exampleEn: 'The rain soaked our coats beside the station.',
          exampleZh: '雨水在车站旁打湿了我们的外套。',
        },
      ],
    },
  };
};
describe('DeepSeek missing-content candidates', () => {
  it('plans exact missing languages from each independent sense, without pairing unrelated existing source senses', () => {
    const plan = planMissingContent(
      word([
        sense(),
        sense({
          id: 'rain-en',
          definitionZh: '',
          definitionEn: 'A heavy fall of something.',
          ordinal: 1,
        }),
        sense({
          id: 'paired',
          definitionZh: '已编辑中文',
          definitionEn: 'Existing authored definition',
          ordinal: 2,
        }),
      ]),
    );
    expect(plan.definitions).toHaveLength(2);
    expect(plan.definitions.map((x) => [x.sourceSenseId, x.field])).toEqual([
      ['rain-zh', 'definitionEn'],
      ['rain-en', 'definitionZh'],
    ]);
    expect(plan.definitions[0]?.sourceText).toBe('雨；雨水 ');
    expect(plan.definitions[0]?.sourceTextSha256).not.toBe(sourceHash('雨；雨水'));
    expect(previewMessages(plan)[1]?.content).toContain('rain-zh');
  });
  it('preserves nonempty fields, including whitespace, and recognizes existing bilingual examples', () => {
    const plan = planMissingContent(
      word(
        [sense({ definitionEn: ' ' })],
        [
          {
            id: 'ex',
            wordId: 'rain',
            learningSenseId: null,
            contextLabel: '',
            status: 'candidate',
            contentVersion: '',
            ordinal: 0,
            exampleEn: 'Rain fell on the roof all evening.',
            exampleZh: '整个晚上，雨都落在屋顶上。',
            contentMetadata: {},
          },
        ],
      ),
    );
    expect(plan.definitions).toEqual([]);
    expect(plan.exampleSource).toBeNull();
    expect(
      planMissingContent(
        word([
          sense({
            definitionEn: 'rain',
            exampleEn: 'Rain fell on the roof all evening.',
            exampleZh: '整个晚上，雨都落在屋顶上。',
          }),
        ]),
      ).exampleSource,
    ).toBeNull();
  });
  it('does not use source-hash-bound excluded senses and does not invent content without source meanings', () => {
    const bad = sense({
      contentMetadata: {
        lexicalQuality: {
          excludeFromLearning: true,
          field: 'definitionZh',
          sourceTextSha256: sourceHash('雨；雨水 '),
        },
      },
    });
    expect(() => planMissingContent(word([bad]))).toThrow('没有可用原词义');
    expect(() => planMissingContent(word([sense({ definitionZh: '' })]))).toThrow('没有可用原词义');
    expect(
      planMissingContent(word([{ ...bad, definitionZh: '管理员已纠正中文' }])).definitions,
    ).toHaveLength(1);
  });
  it('does not retranslate a raw stereotype already covered by an exact-source learning view', () => {
    const viewed = sense({
      id: 'content-ecdict-92c4f5cfaa686db46c05d31789b89b8fadc15a5e1869731951f35cda20e5b1c6',
      definitionZh: '犹太人, 守财奴, 犹太教信徒',
    });
    const example: WordExample = {
      id: 'ex',
      wordId: 'rain',
      learningSenseId: null,
      contextLabel: '',
      status: 'candidate',
      contentVersion: '',
      ordinal: 0,
      exampleEn: 'A visitor told our class about his childhood.',
      exampleZh: '一位访客向我们班讲述了他的童年。',
      contentMetadata: {},
    };
    expect(planMissingContent(word([viewed], [example])).definitions).toEqual([]);
    expect(planMissingContent(word([viewed], [example])).exampleSource).toBeNull();
    expect(
      planMissingContent(word([{ ...viewed, definitionZh: '管理员已重新编辑的原义' }], [example]))
        .definitions,
    ).toHaveLength(1);
  });
  it('bounds source lengths and missing sense count before any upstream call', () => {
    expect(() => planMissingContent(word([sense({ definitionZh: '雨'.repeat(1201) })]))).toThrow(
      '原词义过长',
    );
    expect(() =>
      planMissingContent(word(Array.from({ length: 9 }, (_, i) => sense({ id: `s-${i}` })))),
    ).toThrow('缺失义项过多');
  });
  it('accepts only full schema-valid, source-bound pending candidates', () => {
    const { plan, raw } = valid();
    expect(validateMissingContent(plan, JSON.stringify(raw))).toEqual(raw);
  });
  it.each(['sourceSenseId', 'field', 'sourceTextSha256'] as const)(
    'rejects changed %s binding',
    (field) => {
      const { plan, raw } = valid();
      const altered = structuredClone(raw);
      altered.definitions[0]![field] = field === 'sourceTextSha256' ? 'a'.repeat(64) : 'other';
      expect(() => validateMissingContent(plan, JSON.stringify(altered))).toThrow('未通过校验');
    },
  );
  it('rejects omissions, duplicates, unsolicited fields, empty or wrong-language text and malformed JSON', () => {
    const { plan, raw } = valid();
    for (const data of [
      { ...raw, definitions: [] },
      { ...raw, definitions: [...raw.definitions, ...raw.definitions] },
      { ...raw, extra: 'unwanted' },
      { ...raw, definitions: [{ ...raw.definitions[0], value: '只有中文' }] },
      { ...raw, definitions: [{ ...raw.definitions[0], value: 'Rain означает дождь.' }] },
      { ...raw, examples: [{ ...raw.examples[0], exampleZh: 'English only' }] },
      { ...raw, examples: [{ ...raw.examples[0], exampleEn: ' ' }] },
    ])
      expect(() => validateMissingContent(plan, JSON.stringify(data))).toThrow('未通过校验');
    expect(() => validateMissingContent(plan, '{broken')).toThrow('未通过校验');
  });
  it('rejects wrong example senses, hashes, inflections, partial tokens and generic fillers', () => {
    const { plan, raw } = valid();
    for (const patch of [
      { sourceSenseId: 'other' },
      { sourceTextSha256: 'b'.repeat(64) },
      { exampleEn: 'The rains soaked our coats beside the station.' },
      { exampleEn: 'The brain is carefully examined in the nearby laboratory.' },
      { exampleEn: 'This is rain that everyone can use today.' },
    ])
      expect(() =>
        validateMissingContent(
          plan,
          JSON.stringify({ ...raw, examples: [{ ...raw.examples[0], ...patch }] }),
        ),
      ).toThrow('未通过校验');
  });
  it('uses Unicode letter/mark/number/underscore boundaries and supports literal phrases/punctuation', () => {
    expect(exactLemmaInExample('rain', 'The RAIN fell.')).toBe(true);
    for (const text of ['brain', 'rains', 'rain_1', 'rain2', 'érain', 'rain\u0301', '雨rain'])
      expect(exactLemmaInExample('rain', text)).toBe(false);
    expect(exactLemmaInExample('take care of', 'Please take care of our garden.')).toBe(true);
    expect(exactLemmaInExample('c++', 'We chose C++ for this experiment.')).toBe(true);
  });
  it('returns the exact server source snapshot and canonical identity for both source languages', () => {
    const { plan, raw } = valid();
    const candidate = sourceBoundPreview(plan, JSON.stringify(raw));
    expect(candidate).toMatchObject({ wordId: 'rain', lemma: 'rain' });
    for (const item of [...candidate.definitions, ...candidate.examples]) {
      expect(item).toMatchObject({
        sourceText: '雨；雨水 ',
        sourceLanguage: 'zh',
        sourceField: 'definitionZh',
      });
      expect(sourceHash(item.sourceText)).toBe(item.sourceTextSha256);
    }
    const englishPlan = planMissingContent(
      word([sense({ definitionZh: '', definitionEn: '  Water falling from clouds.\n' })]),
    );
    const englishRaw = {
      definitions: [
        {
          sourceSenseId: 'rain-zh',
          field: 'definitionZh',
          sourceTextSha256: sourceHash('  Water falling from clouds.\n'),
          value: '从云中落下的水滴。',
        },
      ],
      examples: [
        { ...raw.examples[0], sourceTextSha256: sourceHash('  Water falling from clouds.\n') },
      ],
    };
    const englishCandidate = sourceBoundPreview(englishPlan, JSON.stringify(englishRaw));
    for (const item of [...englishCandidate.definitions, ...englishCandidate.examples]) {
      expect(item).toMatchObject({
        sourceText: '  Water falling from clouds.\n',
        sourceLanguage: 'en',
        sourceField: 'definitionEn',
      });
      expect(sourceHash(item.sourceText)).toBe(item.sourceTextSha256);
    }
  });
  it('rejects a corrupted server snapshot or a model-supplied word identity/source text', () => {
    const { plan, raw } = valid();
    const changed = structuredClone(plan);
    changed.definitions[0]!.sourceText = '不同原文';
    expect(() => sourceBoundPreview(changed, JSON.stringify(raw))).toThrow('原文快照未通过校验');
    for (const injected of [
      { ...raw, wordId: 'other-word' },
      { ...raw, lemma: 'other' },
      { ...raw, definitions: [{ ...raw.definitions[0], sourceText: '模型伪造的原文' }] },
    ])
      expect(() => sourceBoundPreview(plan, JSON.stringify(injected))).toThrow('未通过校验');
  });
  it('holds any exact-source spelling warning before planning usage, without hardcoding a word', () => {
    const held = sense({
      id: 'another-sense',
      ordinal: 9,
      definitionZh: '  精确原文\n',
      contentMetadata: {
        lexicalWarnings: [
          {
            code: 'source-spelling-unverified',
            message: 'Synthetic source hold only.',
            sourceTextSha256: sourceHash('  精确原文\n'),
          },
        ],
      },
    });
    try {
      planMissingContent(word([sense(), held]));
      throw new Error('Expected source spelling hold');
    } catch (error) {
      expect(error).toMatchObject({
        statusCode: 422,
        code: 'deepseek_source_spelling_unverified',
        message: '词条拼写待核对，请先确认原词形后再预览',
      });
    }
  });
  it('does not hold stale, unbound or meaning-only warnings and hashes exact untrimmed source', () => {
    for (const warning of [
      { code: 'source-spelling-unverified', sourceTextSha256: sourceHash('雨；雨水') },
      { code: 'source-spelling-unverified', sourceTextSha256: sourceHash('管理员已改变的原文') },
      { code: 'source-spelling-unverified', message: 'Legacy unbound warning.' },
      { code: 'source-meaning-unverified', sourceTextSha256: sourceHash('雨；雨水 ') },
    ]) {
      const plan = planMissingContent(
        word([sense({ contentMetadata: { lexicalWarnings: [warning] } })]),
      );
      expect(plan.definitions).toHaveLength(1);
      expect(plan.exampleSource).not.toBeNull();
    }
  });
});
