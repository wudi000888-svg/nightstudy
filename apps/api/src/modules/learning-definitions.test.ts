import { describe, expect, it } from 'vitest';
import type { Sense } from '@prisma/client';
import { learningDefinitionView } from './learning-definitions.js';
import { selectLearningSense } from './shared.js';
import { supplementIssuedWord } from './content-presentation.js';
const original = () =>
  ({
    id: 'content-ecdict-92c4f5cfaa686db46c05d31789b89b8fadc15a5e1869731951f35cda20e5b1c6',
    wordId: 'word',
    pos: 'n.',
    definitionZh: '犹太人, 守财奴, 犹太教信徒',
    definitionEn: '',
    exampleEn: '',
    exampleZh: '',
    ordinal: 0,
    contentMetadata: {},
  }) as Sense;
describe('independent source-bound usage guidance without rewriting original data', () => {
  it('shows a neutral authored pair for an exact source record', () => {
    const raw = original(),
      copy = structuredClone(raw),
      view = learningDefinitionView(raw);
    expect(view.definitionZh).toBe('犹太人；犹太教信徒');
    expect(view.definitionEn).toContain('Jewish');
    expect(view.id).toBe(raw.id);
    expect(view.pos).toBe(raw.pos);
    expect(raw).toEqual(copy);
  });
  it('does not shadow admin edits or another sense with similar text', () => {
    const edited = { ...original(), definitionZh: '本站校对文本' },
      other = { ...original(), id: 'another-sense' };
    expect(learningDefinitionView(edited)).toBe(edited);
    expect(learningDefinitionView(other)).toBe(other);
    const englishEdit = {
      ...original(),
      definitionEn: 'A site-authored English meaning.',
      contentMetadata: { definitionEn: { kind: 'site-authored' } },
    };
    expect(learningDefinitionView(englishEdit)).toBe(englishEdit);
  });
  it('uses the authored guidance only in newly created questions and read-only presentation', () => {
    const raw = original();
    expect(selectLearningSense([raw], raw.id)?.definitionZh).not.toContain('守财奴');
    const issued = { id: 'word', senses: [raw], questionJson: { prompt: raw.definitionZh } };
    const saved = structuredClone(issued);
    const current = { id: 'word', status: 'published', senses: [learningDefinitionView(raw)] };
    const view = supplementIssuedWord(issued, current, 'word');
    expect((view.senses as Sense[])[0]!.definitionZh).toBe(raw.definitionZh);
    expect(issued).toEqual(saved);
  });
});
