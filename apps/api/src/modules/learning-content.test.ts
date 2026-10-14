import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Sense } from '@prisma/client';
import {
  displayPos,
  learningSense,
  selectLearningSense,
  wordDto,
  type WordWithSenses,
} from './shared.js';
import { supplementIssuedWord } from './content-presentation.js';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const sense = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 's',
    wordId: 'w',
    pos: '',
    definitionZh: '不知底细',
    definitionEn: '',
    exampleEn: '',
    exampleZh: '',
    ordinal: 0,
    contentMetadata: {},
    ...overrides,
  }) as unknown as Sense;
const exclusion = {
  excludeFromLearning: true,
  field: 'definitionZh',
  sourceTextSha256: hash('不知底细'),
};
describe('source-bound learning corrections and real phrase display', () => {
  it('holds only the exact rejected source text and restores an edited sense', () => {
    expect(learningSense(sense({ contentMetadata: { lexicalQuality: exclusion } }))).toBe(false);
    expect(
      learningSense(
        sense({ definitionZh: '不可能的', contentMetadata: { lexicalQuality: exclusion } }),
      ),
    ).toBe(true);
    expect(
      learningSense(sense({ contentMetadata: { lexicalQuality: { ...exclusion, field: 'pos' } } })),
    ).toBe(true);
  });
  it('uses the corrected meaning in newly created tasks while preserving an ordinary requested focus', () => {
    const held = sense({ contentMetadata: { lexicalQuality: exclusion } });
    const corrected = sense({
      id: 'correct',
      definitionZh: '不可能的',
      definitionEn: 'impossible',
    });
    expect(selectLearningSense([held, corrected], held.id)?.id).toBe('correct');
    expect(selectLearningSense([corrected, sense({ id: 'ordinary' })], 'ordinary')?.id).toBe(
      'ordinary',
    );
  });
  it('keeps actual source POS and uses reviewed author provenance only for empty POS', () => {
    const metadata = {
      authoredDisplayPos: 'adj. phr.',
      authoredDisplayPosSource: { kind: 'original-authoring' },
    };
    expect(displayPos(sense({ pos: 'vt.', contentMetadata: metadata }))).toBe('vt.');
    expect(displayPos(sense({ contentMetadata: metadata }))).toBe('adj. phr.');
    expect(displayPos(sense({ contentMetadata: { authoredDisplayPos: 'adj. phr.' } }))).toBe('');
  });
  it('separates source records from learning and only includes real canonical collocations', () => {
    const corrected = sense({
      id: 'correct',
      pos: 'adj. phr.',
      definitionZh: '不可能的',
      definitionEn: 'impossible',
    });
    const word = {
      id: 'w',
      lemma: 'question',
      normalizedLemma: 'question',
      sourceRef: 'pack:ecdict-base',
      phoneticSource: '',
      senses: [sense({ contentMetadata: { lexicalQuality: exclusion } }), corrected],
      collocations: [
        {
          wordId: 'w',
          phraseId: 'p',
          ordinal: 0,
          phrase: { id: 'p', lemma: 'out of the question', senses: [corrected] },
        },
      ],
    } as unknown as WordWithSenses;
    expect(wordDto(word).senses.map((item) => item.id)).toEqual(['correct']);
    expect(wordDto(word).collocations[0]).toMatchObject({
      wordId: 'p',
      lemma: 'out of the question',
      pos: 'adj. phr.',
    });
    expect(wordDto(word, true).senses).toHaveLength(2);
  });
  it('supplements issued presentation without altering the issued source or accepting an unrelated exclusion', () => {
    const issued = { id: 'w', senses: [sense()], contentVersion: 'old' };
    const original = structuredClone(issued);
    const fresh = {
      id: 'w',
      status: 'published',
      senses: [sense({ id: 'correct', definitionZh: '不可能的', definitionEn: 'impossible' })],
      learningExclusions: [{ id: 's', ...exclusion }],
      collocations: [{ wordId: 'p', lemma: 'out of the question' }],
    };
    const display = supplementIssuedWord(issued, fresh, 'w');
    expect((display.senses as Sense[]).map((item) => item.id)).toEqual(['correct']);
    expect(display.collocations).toEqual(fresh.collocations);
    expect(issued).toEqual(original);
    const edited = { ...issued, senses: [sense({ definitionZh: '后台已校对' })] };
    expect((supplementIssuedWord(edited, fresh, 'w').senses as Sense[])[0]!.definitionZh).toBe(
      '后台已校对',
    );
  });
});
