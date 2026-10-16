import { describe, expect, it } from 'vitest';
import {
  contentCoverage,
  summarySenses,
  supplementIssuedWord,
  senseLexicalWarnings,
} from './content-presentation.js';

const sentence = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  learningSenseId: 'finance',
  contentVersion: 'sense-v1',
  contextLabel: '开户',
  exampleEn: 'She opened an account at the bank.',
  exampleZh: '她在银行开了一个账户。',
  ...extra,
});
const meaning = (extra: Record<string, unknown> = {}) => ({
  id: 'finance',
  kind: 'learning',
  pos: 'n.',
  definitionZh: '银行',
  definitionEn: 'an organization that keeps and lends money',
  contentVersion: 'sense-v1',
  bindingHash: 'a'.repeat(64),
  examples: [],
  ...extra,
});
const word = (senses: unknown[]) => ({
  id: 'bank',
  status: 'published',
  contentVersion: 'dictionary-v1',
  senses,
});

describe('version-bound issued meaning presentation', () => {
  it('does not claim independent language senses form bilingual definitions', () => {
    const senses = [
      { definitionZh: '甲', definitionEn: '' },
      { definitionZh: '', definitionEn: 'A' },
    ];
    expect(contentCoverage(senses)).toMatchObject({
      definitionZh: true,
      definitionEn: true,
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
  it('deduplicates public warnings without exposing private provenance fields', () => {
    const warning = {
      code: 'source-quality',
      message: '释义待校对',
      sourceTextSha256: 'private-detail',
    };
    expect(
      senseLexicalWarnings([
        { contentMetadata: { lexicalWarnings: [warning] } },
        { contentMetadata: { lexicalWarnings: [warning] } },
      ]),
    ).toEqual([{ code: warning.code, message: warning.message }]);
  });
  it('appends only examples bound to the same signed meaning, version and binding hash', () => {
    const snapshot = word([meaning()]);
    const before = structuredClone(snapshot);
    const current = word([
      meaning({
        examples: [
          sentence('account'),
          sentence('wrong', { learningSenseId: 'river' }),
          sentence('version', { contentVersion: 'sense-v2' }),
        ],
      }),
    ]);
    const view = supplementIssuedWord(snapshot, current, 'bank');
    expect((view.senses as { examples: unknown[] }[])[0]!.examples).toEqual([sentence('account')]);
    expect(view.contentView).toMatchObject({ supplemented: true });
    expect(snapshot).toEqual(before);
  });
  it.each(['bindingHash', 'contentVersion', 'definitionZh', 'definitionEn', 'pos'])(
    'rejects meaning drift in %s',
    (field) => {
      const snapshot = word([meaning()]);
      const current = word([meaning({ [field]: 'changed', examples: [sentence('new')] })]);
      expect(supplementIssuedWord(snapshot, current, 'bank').senses).toEqual(snapshot.senses);
    },
  );
  it('never appends a new meaning or a word-level usage into an issued question', () => {
    const snapshot = { ...word([meaning({ kind: 'dictionary' })]), examples: [sentence('old')] };
    const current = {
      ...word([meaning({ id: 'river', examples: [sentence('new')] })]),
      examples: [sentence('global')],
    };
    const view = supplementIssuedWord(snapshot, current, 'bank');
    expect(view.senses).toEqual(snapshot.senses);
    expect(view.examples).toEqual(snapshot.examples);
  });
  it('retains the exact text of an already collected or issued example', () => {
    const snapshot = word([meaning({ examples: [sentence('same')] })]);
    const current = word([
      meaning({ examples: [sentence('same', { exampleEn: 'Changed sentence.' })] }),
    ]);
    expect(supplementIssuedWord(snapshot, current, 'bank').senses).toEqual(snapshot.senses);
  });
  it('does not supplement legacy or unbound source meanings', () => {
    const snapshot = word([{ id: 'finance', pos: 'n.', definitionZh: '银行', definitionEn: '' }]);
    expect(
      supplementIssuedWord(snapshot, word([meaning({ examples: [sentence('new')] })]), 'bank')
        .senses,
    ).toEqual(snapshot.senses);
  });
  it('never reads unpublished or other-word content into a snapshot', () => {
    const snapshot = word([meaning()]);
    expect(supplementIssuedWord(snapshot, { ...word([]), id: 'other' }, 'bank')).toBe(snapshot);
    expect(supplementIssuedWord(snapshot, { ...word([]), status: 'draft' }, 'bank')).toBe(snapshot);
    expect(supplementIssuedWord({ ...snapshot, id: 'other' }, word([]), 'bank').id).toBe('other');
  });
  it('withdraws unsafe word audio from an issued view without rewriting the question or meaning', () => {
    const snapshot = {
      ...word([meaning()]),
      pronunciationCompatible: true,
      phonetic: '/old/',
      phoneticUs: '/old/',
      phoneticUk: '/old/',
      audio: [{ id: 'old-audio' }],
      question: { answer: 'bank' },
    };
    const before = structuredClone(snapshot);
    const view = supplementIssuedWord(
      snapshot,
      { ...word([]), pronunciationCompatible: false },
      'bank',
    );
    expect(view).toMatchObject({
      pronunciationCompatible: false,
      phonetic: '',
      phoneticUs: '',
      phoneticUk: '',
      audio: [],
    });
    expect(view.senses).toEqual(snapshot.senses);
    expect(view.question).toEqual(snapshot.question);
    expect(snapshot).toEqual(before);
  });
});
