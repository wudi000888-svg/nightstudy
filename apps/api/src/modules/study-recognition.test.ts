import { describe, expect, it } from 'vitest';
import { createRecognitionQuestion, readRecognitionQuestion } from './study-recognition.js';
import { learningSenseBindingHash, learningSenseTextHash } from './learning-sense-integrity.js';
import { sessionDto } from './study.js';
import type { WordWithSenses } from './shared.js';

function word(lemma: string, zh: string, pos = 'n.'): WordWithSenses {
  const source = {
    id: lemma + '-source',
    wordId: lemma,
    pos,
    definitionZh: zh,
    definitionEn: 'A checked meaning of ' + lemma,
    ordinal: 0,
    exampleEn: '',
    exampleZh: '',
    contentMetadata: {},
  };
  const binding = {
    id: lemma + '-binding',
    wordId: lemma,
    learningSenseId: lemma + '-meaning',
    sourceSenseId: source.id,
    relation: 'exact',
    sourcePosSha256: learningSenseTextHash(pos),
    sourceDefinitionZhSha256: learningSenseTextHash(zh),
    sourceDefinitionEnSha256: learningSenseTextHash(source.definitionEn),
    contentMetadata: {},
    sourceSense: source,
  };
  const sense = {
    id: lemma + '-meaning',
    wordId: lemma,
    pos,
    definitionZh: zh,
    definitionEn: source.definitionEn,
    ordinal: 0,
    status: 'published',
    contentVersion: 'checked-1',
    contentMetadata: {},
    sourceBindings: [binding],
    examples: [],
    bindingHash: '',
  };
  sense.bindingHash = learningSenseBindingHash(sense);
  return {
    id: lemma,
    lemma,
    normalizedLemma: lemma,
    status: 'published',
    senses: [source],
    learningSenses: [sense],
  } as unknown as WordWithSenses;
}
const target = () => word('bridge', '桥梁');
const pool = () => [word('window', '窗户'), word('mountain', '山峰'), word('ticket', '票券')];
describe('fixed recognition questions from reviewed meanings', () => {
  it('issues opaque random IDs while selecting the same checked content independently of input order', () => {
    const a = createRecognitionQuestion(target(), 'bridge-meaning', pool())!;
    expect(a.options).toHaveLength(4);
    expect(new Set(a.options.map((x) => x.id)).size).toBe(4);
    expect(a.options.find((x) => x.id === a.correctOptionId)?.text).toBe('桥梁');
    const b = createRecognitionQuestion(target(), 'bridge-meaning', pool().reverse())!;
    expect(b.options.map((x) => x.text).sort()).toEqual(a.options.map((x) => x.text).sort());
    expect(b.options.every((x) => !a.options.some((previous) => previous.id === x.id))).toBe(true);
  });
  it('never turns raw, held or drifted source meanings into questions', () => {
    const raw = target();
    raw.learningSenses = [];
    expect(createRecognitionQuestion(raw, 'bridge-source', pool())).toBeNull();
    const held = target();
    held.learningSenses![0]!.status = 'held';
    expect(createRecognitionQuestion(held, 'bridge-meaning', pool())).toBeNull();
    const drift = target();
    drift.learningSenses![0]!.sourceBindings[0]!.sourceSense.definitionZh = '改变了的来源';
    expect(createRecognitionQuestion(drift, 'bridge-meaning', pool())).toBeNull();
  });
  it('falls back when there are too few distinct reviewed distractors', () => {
    expect(createRecognitionQuestion(target(), 'bridge-meaning', [pool()[0]!])).toBeNull();
    expect(
      createRecognitionQuestion(target(), 'bridge-meaning', [
        word('fly', '飞翔', 'v.'),
        word('bridges', '桥梁'),
        word('viaduct', '桥梁'),
      ]),
    ).toBeNull();
  });
  it('recognizes legacy source binding identity without accepting another meaning', () => {
    expect(createRecognitionQuestion(target(), 'bridge-source', pool())).not.toBeNull();
    expect(createRecognitionQuestion(target(), 'unknown-meaning', pool())).toBeNull();
  });
  it('rejects duplicate single-character meanings as distractors', () => {
    const head = word('water', '水');
    const choices = [word('aqua', '水'), word('book', '书'), word('voucher', '票')];
    const issued = createRecognitionQuestion(head, 'water-meaning', choices)!;
    expect(issued.options).toHaveLength(3);
    expect(issued.options.filter((option) => option.text === '水')).toHaveLength(1);
    expect(createRecognitionQuestion(head, 'water-meaning', choices.slice(0, 2))).toBeNull();
  });
  it('rejects public lexical synonyms even when their Chinese wording is different', () => {
    const head = word('pliable', '柔韧的', 'adj.');
    const choices = [
      word('pliant', '柔顺易弯的', 'adj.'),
      word('dangerous', '危险的', 'adj.'),
      word('ancient', '古老的', 'adj.'),
    ];
    const question = createRecognitionQuestion(head, 'pliable-meaning', choices)!;
    expect(question.options).toHaveLength(3);
    expect(question.options.some((option) => option.text === '柔顺易弯的')).toBe(false);
    expect(createRecognitionQuestion(head, 'pliable-meaning', choices.slice(0, 2))).toBeNull();
  });
  it('rejects malformed snapshots and choices outside the issued set', () => {
    const value = createRecognitionQuestion(target(), 'bridge-meaning', pool())!;
    expect(readRecognitionQuestion({ ...value, selectedOptionId: 'forged' })).toBeNull();
    expect(readRecognitionQuestion({ ...value, correctOptionId: 'forged' })).toBeNull();
    expect(
      readRecognitionQuestion({
        ...value,
        options: [value.options[0], value.options[0], value.options[1]],
      }),
    ).toBeNull();
    expect(
      readRecognitionQuestion({ ...value, selectedOptionId: value.options[0]!.id })
        ?.selectedOptionId,
    ).toBe(value.options[0]!.id);
  });
  it('withholds the answer until reveal and never emits spelling answers', () => {
    const recognition = createRecognitionQuestion(target(), 'bridge-meaning', pool())!;
    const value = {
      id: 'session',
      bookId: 'book',
      mode: 'daily',
      status: 'in_progress',
      phase: 'recall',
      cursor: 0,
      step: 'prompt',
      revision: 0,
      items: [
        {
          id: 'item',
          wordId: 'bridge',
          ordinal: 0,
          focusSenseId: 'bridge-meaning',
          revealed: false,
          rated: false,
          exerciseDone: false,
          status: 'pending',
          progressRevision: 0,
          contentSnapshot: { id: 'bridge', lemma: 'bridge', senses: [{ definitionZh: '桥梁' }] },
          questionJson: {
            taskBucket: 'new',
            answer: 'bridge',
            recognition: { ...recognition, selectedOptionId: recognition.options[0]!.id },
          },
        },
      ],
    } as unknown as Parameters<typeof sessionDto>[0];
    const before = sessionDto(value);
    expect(before.items[0]?.recognition).toEqual({ options: recognition.options });
    expect(JSON.stringify(before)).not.toContain('correctOptionId');
    expect(JSON.stringify(before)).not.toContain('selectedOptionId');
    value.items[0]!.revealed = true;
    expect(sessionDto(value).items[0]?.recognition).toEqual({
      ...recognition,
      selectedOptionId: recognition.options[0]!.id,
    });
    value.phase = 'practice';
    expect(sessionDto(value).items[0]?.recognition).toBeUndefined();
    expect(JSON.stringify(sessionDto(value))).not.toContain('"answer"');
    value.phase = 'recall';
    value.items[0]!.questionJson = JSON.parse(
      JSON.stringify({ taskBucket: 'review', recognition }),
    );
    expect(sessionDto(value).items[0]?.recognition).toBeUndefined();
  });
});
