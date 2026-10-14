import { describe, expect, it } from 'vitest';
import {
  contentCoverage,
  summarySenses,
  supplementIssuedWord,
  senseLexicalWarnings,
} from './content-presentation.js';
import { sessionDto } from './study.js';
import { wordDto } from './shared.js';

const machine = {
  kind: 'machine-translation',
  review: 'pending',
  model: 'Original synthetic model fixture',
};
const current = (senses: unknown[], examples: unknown[] = []) => ({
  id: 'word',
  status: 'published',
  contentVersion: 'unchanged-original-source',
  senses,
  examples,
});
describe('bilingual content presentation without changing issued learning identity', () => {
  it('deduplicates source quality warnings and exposes only the public code and message', () => {
    const warning = {
      code: 'source-spelling-unverified',
      message: '源词条待校对',
      senseId: 'sense',
      sourceTextSha256: '0'.repeat(64),
    };
    const senses = [
      { contentMetadata: { lexicalWarnings: [warning, null, { code: 'missing-message' }] } },
      { contentMetadata: { lexicalWarnings: [{ ...warning, senseId: 'another-sense' }] } },
      {
        contentMetadata: {
          lexicalWarnings: [{ code: 'source-meaning-unverified', message: '原释义待校对' }],
        },
      },
    ];
    const before = JSON.stringify(senses);
    expect(senseLexicalWarnings(senses)).toEqual([
      { code: warning.code, message: warning.message },
      { code: 'source-meaning-unverified', message: '原释义待校对' },
    ]);
    expect(JSON.stringify(senses)).toBe(before);
  });
  it('passes source warnings through canonical words and revealed snapshots while hiding them before reveal', () => {
    const warning = { code: 'source-spelling-unverified', message: '源词条待校对' };
    const word = wordDto({
      id: 'word',
      lemma: 'sourceword',
      status: 'published',
      contentVersion: 'source-v1',
      senses: [
        {
          id: 'sense',
          definitionZh: '原义',
          definitionEn: '',
          pos: 'n.',
          contentMetadata: { lexicalWarnings: [warning] },
        },
      ],
    } as unknown as Parameters<typeof wordDto>[0]);
    expect(word.lexicalWarnings).toEqual([warning]);
    const snapshot = {
      id: 'word',
      lemma: 'sourceword',
      senses: [{ id: 'sense', pos: 'n.', definitionZh: '原义', definitionEn: '' }],
    };
    const original = JSON.stringify(snapshot);
    const view = supplementIssuedWord(snapshot, word, 'word');
    expect(view.lexicalWarnings).toEqual([warning]);
    expect(view.contentView).toMatchObject({ supplemented: true });
    expect(JSON.stringify(snapshot)).toBe(original);
    const fixture = {
      id: 'session',
      mode: 'learn',
      status: 'in_progress',
      phase: 'recall',
      cursor: 0,
      step: 'prompt',
      revision: 0,
      items: [
        {
          id: 'item',
          wordId: 'word',
          ordinal: 0,
          revealed: false,
          rated: false,
          exerciseDone: false,
          contentSnapshot: snapshot,
          questionJson: { answer: 'sourceword', prompt: '隐藏的题目' },
        },
      ],
    } as unknown as Parameters<typeof sessionDto>[0];
    const hidden = sessionDto(fixture, [], null, new Map([['word', word]]));
    expect(hidden.items[0]!.word).not.toHaveProperty('lexicalWarnings');
    expect(JSON.stringify(hidden)).not.toContain('源词条待校对');
    expect(JSON.stringify(hidden)).not.toContain('隐藏的题目');
    fixture.items[0]!.revealed = true;
    expect(sessionDto(fixture, [], null, new Map([['word', word]])).items[0]!.word).toMatchObject({
      lexicalWarnings: [warning],
    });
    expect(
      supplementIssuedWord({ ...snapshot, lexicalWarnings: [warning] }, word, 'word')
        .lexicalWarnings,
    ).toEqual([warning]);
  });
  it('reports real language coverage without pairing independent senses', () => {
    const senses = [
      { definitionZh: '甲', definitionEn: '' },
      { definitionZh: '', definitionEn: 'A' },
    ];
    expect(contentCoverage(senses)).toEqual({
      definitionZh: true,
      definitionEn: true,
      exampleEn: false,
      exampleZh: false,
      bilingualSenseCount: 0,
      bilingualExampleCount: 0,
    });
    expect(
      summarySenses([
        ...senses.slice(0, 1),
        { definitionZh: '乙' },
        { definitionZh: '丙' },
        senses[1]!,
      ]),
    ).toContain(senses[1]);
  });
  it('fills missing fields only on the same sense identity and retains original text and provenance', () => {
    const snapshot = {
      id: 'word',
      lemma: 'original',
      senses: [
        {
          id: 'sense',
          pos: 'n.',
          definitionZh: '雨',
          definitionEn: '',
          exampleEn: 'Rain falls.',
          exampleZh: '',
          contentMetadata: { definitionZh: { kind: 'dictionary', review: 'source' } },
        },
      ],
    };
    const before = JSON.stringify(snapshot);
    const fresh = current([
      {
        id: 'sense',
        pos: 'n.',
        definitionZh: '雨',
        definitionEn: 'Rain.',
        exampleEn: 'Rain falls.',
        exampleZh: '下雨了。',
        contentMetadata: { definitionEn: machine, exampleZh: machine, packId: 'bilingual-v1' },
      },
    ]);
    const view = supplementIssuedWord(snapshot, fresh, 'word');
    expect(view.senses).toMatchObject([
      {
        id: 'sense',
        definitionZh: '雨',
        definitionEn: 'Rain.',
        exampleZh: '下雨了。',
        contentMetadata: {
          definitionZh: { kind: 'dictionary' },
          definitionEn: machine,
          exampleZh: machine,
        },
      },
    ]);
    expect(view.lemma).toBe('original');
    expect(JSON.stringify(snapshot)).toBe(before);
    expect(view.contentView).toMatchObject({ supplemented: true });
  });
  it('does not combine an edited meaning or changed English sentence with an old Chinese-only or English-only snapshot', () => {
    const snapshot = {
      id: 'word',
      senses: [
        {
          id: 'sense',
          pos: 'n.',
          definitionZh: '旧义',
          definitionEn: '',
          exampleEn: 'Original sentence.',
          exampleZh: '',
        },
      ],
    };
    const view = supplementIssuedWord(
      snapshot,
      current([
        {
          id: 'sense',
          pos: 'n.',
          definitionZh: '新义',
          definitionEn: 'Different meaning.',
          exampleEn: 'Different sentence.',
          exampleZh: '新例句。',
        },
      ]),
      'word',
    );
    expect(view.senses).toEqual(snapshot.senses);
    const sameMeaning = supplementIssuedWord(
      snapshot,
      current([
        {
          id: 'sense',
          pos: 'n.',
          definitionZh: '旧义',
          definitionEn: 'Compatible definition.',
          exampleEn: 'Different sentence.',
          exampleZh: '新例句。',
        },
      ]),
      'word',
    );
    expect(sameMeaning.senses).toMatchObject([
      { definitionEn: 'Compatible definition.', exampleEn: 'Original sentence.', exampleZh: '' },
    ]);
  });
  it('does not reuse live translation provenance for a merely normalized match of the source text', () => {
    const snapshot = {
      id: 'word',
      senses: [{ id: 'sense', pos: 'n.', definitionEn: 'Ａ glass opening. ', definitionZh: '' }],
    };
    const fresh = current([
      {
        id: 'sense',
        pos: 'n.',
        definitionEn: 'A glass opening.',
        definitionZh: '玻璃开口。',
        contentMetadata: { definitionEn: machine, definitionZh: machine },
      },
    ]);
    expect(supplementIssuedWord(snapshot, fresh, 'word').senses).toEqual(snapshot.senses);
    const exact = supplementIssuedWord(
      { ...snapshot, senses: [{ ...snapshot.senses[0], definitionEn: 'A glass opening.' }] },
      fresh,
      'word',
    );
    expect(exact.senses).toMatchObject([
      {
        definitionZh: '玻璃开口。',
        contentMetadata: { definitionEn: machine, definitionZh: machine },
      },
    ]);
  });
  it('appends independent senses and word-level usage without replacing an existing example', () => {
    const snapshot = {
      id: 'word',
      senses: [{ id: 'old', definitionZh: '旧义' }],
      examples: [{ id: 'pair', exampleEn: 'Old usage.', exampleZh: '旧用例。' }],
    };
    const view = supplementIssuedWord(
      snapshot,
      current(
        [{ id: 'new', definitionZh: '', definitionEn: 'Independent sense.' }],
        [
          { id: 'pair', exampleEn: 'Changed usage.', exampleZh: '新用例。' },
          {
            id: 'new-pair',
            exampleEn: 'New independent usage.',
            exampleZh: '新独立用例。',
            contentMetadata: { exampleEn: { kind: 'corpus' } },
          },
        ],
      ),
      'word',
    );
    expect(view.senses).toEqual([
      ...snapshot.senses,
      { id: 'new', definitionZh: '', definitionEn: 'Independent sense.' },
    ]);
    expect(view.examples).toMatchObject([snapshot.examples[0]!, { id: 'new-pair' }]);
    expect(JSON.stringify(view.examples)).not.toContain('senseId');
  });
  it('never supplements from a different identity or unpublished catalog word', () => {
    const snapshot = { id: 'word', senses: [] };
    expect(
      supplementIssuedWord(
        snapshot,
        { ...current([{ id: 'new', definitionZh: '秘密草稿' }]), status: 'draft' },
        'word',
      ),
    ).toBe(snapshot);
    expect(
      supplementIssuedWord(
        snapshot,
        { ...current([{ id: 'new', definitionZh: '其他词' }]), id: 'other' },
        'word',
      ),
    ).toBe(snapshot);
    expect(supplementIssuedWord({ ...snapshot, id: 'corrupt-other' }, current([]), 'word').id).toBe(
      'corrupt-other',
    );
  });
});
