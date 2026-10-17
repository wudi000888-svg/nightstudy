import { describe, expect, it } from 'vitest';
import { wordDto, type WordWithSenses } from './shared.js';
import { reviewedSenseDisplayLemma } from './learning-sense-view.js';
import { learningSenseBindingHash, learningSenseTextHash } from './learning-sense-integrity.js';
import { sessionDto, spellingQuestion, studyWordSnapshot } from './study.js';
import { supplementIssuedWord } from './content-presentation.js';

const orthography = (displayLemma: string, normalizedLemma = displayLemma.toLowerCase()) => ({
  displayLemma,
  normalizedLemma,
  displayLemmaSha256: learningSenseTextHash(displayLemma),
  decision: 'publish',
  reviewer: 'Codex',
  expertCertified: false,
  reason: 'The spelling has been explicitly reviewed for this particular atomic meaning.',
});
function fixture(lemma = 'Polish', normalizedLemma = 'polish'): WordWithSenses {
  const senses = ['polish', 'Polish'].map((displayLemma, ordinal) => {
    const source = {
      id: 'source-' + ordinal,
      wordId: 'case-word',
      pos: ordinal ? 'adj.' : 'v.',
      definitionZh: ordinal ? '波兰的' : '擦亮',
      definitionEn: ordinal ? 'Relating to Poland.' : 'To make a surface shiny.',
      contentMetadata: {},
      ordinal,
      exampleEn: '',
      exampleZh: '',
    };
    const binding = {
      id: 'binding-' + ordinal,
      wordId: source.wordId,
      learningSenseId: 'meaning-' + ordinal,
      sourceSenseId: source.id,
      relation: 'exact',
      sourcePosSha256: learningSenseTextHash(source.pos),
      sourceDefinitionZhSha256: learningSenseTextHash(source.definitionZh),
      sourceDefinitionEnSha256: learningSenseTextHash(source.definitionEn),
      sourceSense: source,
      contentMetadata: {},
    };
    const sense = {
      id: binding.learningSenseId,
      wordId: source.wordId,
      pos: source.pos,
      definitionZh: source.definitionZh,
      definitionEn: source.definitionEn,
      contentVersion: 'case-test',
      status: 'published',
      ordinal,
      contentMetadata: { orthography: orthography(displayLemma) },
      sourceBindings: [binding],
      examples: [],
      bindingHash: '',
    };
    sense.bindingHash = learningSenseBindingHash(sense);
    return sense;
  });
  return {
    id: 'case-word',
    lemma,
    normalizedLemma,
    status: 'published',
    contentVersion: 'case-test',
    goalTags: [],
    senses: senses.map((sense) => sense.sourceBindings[0]!.sourceSense),
    learningSenses: senses,
  } as unknown as WordWithSenses;
}
describe('explicit per-meaning spelling', () => {
  it('keeps dictionary identity while exposing only reviewed case variants on the appropriate sense', () => {
    const word = fixture(),
      before = structuredClone(word),
      dto = wordDto(word);
    expect(dto.lemma).toBe('Polish');
    expect(dto).not.toHaveProperty('displayLemma');
    expect(dto.senses.map((sense) => sense.displayLemma)).toEqual(['polish', 'Polish']);
    expect(word).toEqual(before);
    expect(studyWordSnapshot(dto, 'meaning-0')).toMatchObject({
      lemma: 'Polish',
      displayLemma: 'polish',
    });
    expect(studyWordSnapshot(dto, 'source-1')).toMatchObject({
      lemma: 'Polish',
      displayLemma: 'Polish',
    });
    expect(studyWordSnapshot(dto, 'missing-focus')).not.toHaveProperty('displayLemma');
    expect(spellingQuestion(dto, 'meaning-0').answer).toBe('Polish');
  });
  it('supports AM/am and ordinary names without inferring any spelling from examples or POS', () => {
    for (const [display, canonical] of [
      ['am', 'AM'],
      ['AM', 'AM'],
      ['William', 'william'],
    ]) {
      expect(
        reviewedSenseDisplayLemma(
          { contentMetadata: { orthography: orthography(display!) } },
          canonical!,
        ),
      ).toBe(display);
    }
    const word = fixture();
    word.learningSenses![0]!.contentMetadata = {};
    word.learningSenses![0]!.examples = [
      {
        exampleEn: 'Polish happens to be the first word in this example.',
      },
    ] as unknown as NonNullable<WordWithSenses['learningSenses']>[number]['examples'];
    expect(wordDto(word).senses[0]).not.toHaveProperty('displayLemma');
  });
  it('rejects noncase aliases, partial review, added fields, wrong hashes and uncanonical whitespace', () => {
    const valid = orthography('Polish');
    for (const patch of [
      { displayLemma: 'Poland', displayLemmaSha256: learningSenseTextHash('Poland') },
      { displayLemma: ' Polish', displayLemmaSha256: learningSenseTextHash(' Polish') },
      { displayLemma: 'Ｐｏｌｉｓｈ', displayLemmaSha256: learningSenseTextHash('Ｐｏｌｉｓｈ') },
      { normalizedLemma: 'other' },
      { displayLemmaSha256: 'f'.repeat(64) },
      { decision: 'pending' },
      { reviewer: 'automatic' },
      { expertCertified: true },
      { reason: 'short' },
      { definitionZh: 'Must not become an orthography hint.' },
    ]) {
      expect(
        reviewedSenseDisplayLemma(
          { contentMetadata: { orthography: { ...valid, ...patch } } },
          'Polish',
        ),
      ).toBeUndefined();
    }
    const word = fixture();
    word.learningSenses![0]!.contentMetadata = {
      orthography: { ...valid, displayLemma: 'Poland' },
    };
    expect(wordDto(word).senses[0]).not.toHaveProperty('displayLemma');
  });
  it('freezes focus spelling before reveal and exposes neither definitions nor editorial metadata in a hidden DTO', () => {
    const snapshot = studyWordSnapshot(wordDto(fixture()), 'meaning-0');
    const session = {
      id: 'case-session',
      status: 'in_progress',
      phase: 'recall',
      items: [
        {
          id: 'case-item',
          wordId: snapshot.id,
          focusSenseId: 'meaning-0',
          revealed: false,
          contentSnapshot: snapshot,
          questionJson: { answer: 'Polish', taskBucket: 'new' },
        },
      ],
    } as unknown as Parameters<typeof sessionDto>[0];
    const before = structuredClone(session),
      hidden = sessionDto(session).items[0]!.word;
    expect(hidden).toMatchObject({ id: 'case-word', lemma: 'Polish', displayLemma: 'polish' });
    for (const key of ['senses', 'contentMetadata', 'orthography', 'definitionZh', 'definitionEn'])
      expect(JSON.stringify(hidden)).not.toContain(key);
    expect(JSON.stringify(hidden)).not.toContain('擦亮');
    expect(session).toEqual(before);
    const current = wordDto(fixture());
    current.senses[0]!.displayLemma = 'POLISH';
    expect(supplementIssuedWord(snapshot, current, snapshot.id).displayLemma).toBe('polish');
    session.items[0]!.revealed = true;
    expect(
      sessionDto(session, [], null, new Map([[snapshot.id, current]])).items[0]!.word,
    ).toMatchObject({ displayLemma: 'polish' });
  });
});
