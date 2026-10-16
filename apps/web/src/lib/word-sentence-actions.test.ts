import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { WordView } from '../components/UI';
import { WordCardContent } from '../components/WordCards';
import { WordCardContext } from './word-cards';
import type { Word } from './types';

vi.hoisted(() => vi.stubGlobal('window', { __NIGHTSTUDY_CONFIG__: {} }));
vi.mock('../AppContext', () => ({
  useApp: () => ({ user: null, scope: 'sentence-render:guest' }),
  useRemote: () => ({ data: undefined, error: null }),
}));
vi.mock('../components/SentenceSaveButton', () => ({
  SentenceSaveButton: (props: { wordId: string; sourceType: string; sourceId: string }) =>
    React.createElement(
      'button',
      {
        'data-sentence-word': props.wordId,
        'data-sentence-source': `${props.sourceType}:${props.sourceId}`,
      },
      '收藏这句',
    ),
}));
const word: Word = {
  id: 'sentence-word',
  lemma: 'rain',
  senses: [
    {
      id: 'sense-bilingual',
      definitionZh: '雨',
      definitionEn: 'Water falling from clouds.',
      exampleEn: 'The rain stopped before dawn.',
      exampleZh: '雨在黎明前停了。',
      examples: [
        {
          id: 'meaning-example',
          learningSenseId: 'sense-bilingual',
          exampleEn: 'The rain stopped before dawn.',
          exampleZh: '雨在黎明前停了。',
          contextLabel: '天气',
        },
      ],
    },
    {
      id: 'sense-en-only',
      definitionZh: '',
      definitionEn: 'To fall from clouds.',
      exampleEn: 'It may rain tomorrow.',
      exampleZh: '',
    },
  ],
  examples: [
    {
      id: 'word-bilingual',
      exampleEn: 'Rain covered the empty street.',
      exampleZh: '雨笼罩着空荡荡的街道。',
    },
    { id: 'word-one-language', exampleEn: 'Heavy rain delayed the train.', exampleZh: '' },
  ],
};
function render(element: React.ReactElement) {
  return renderToStaticMarkup(
    React.createElement(
      WordCardContext.Provider,
      { value: { openWord: vi.fn(), leaveWord: vi.fn() } },
      element,
    ),
  );
}
beforeAll(() => vi.stubGlobal('React', React));
afterAll(() => vi.unstubAllGlobals());
it('binds the current meaning example to its own stable canonical example ID', () => {
  for (const presentation of ['reading', 'study'] as const) {
    const markup = render(React.createElement(WordView, { word, presentation }));
    expect((markup.match(/data-sentence-word="sentence-word"/g) ?? []).length).toBe(1);
    expect(markup).toContain('data-sentence-source="word-example:meaning-example"');
    expect(markup).not.toContain('word-example:word-bilingual');
    expect(markup).not.toContain('sense:sense-bilingual');
  }
  const missing = render(
    React.createElement(WordView, {
      word: { ...word, senses: word.senses!.map((sense) => ({ ...sense, examples: [] })) },
    }),
  );
  expect(missing).not.toContain('data-sentence-');
  expect(missing).toContain('本义项暂无例句');
});
it('keeps unrevealed content and noninteractive floating-card text free of sentence actions', () => {
  const hidden = render(
    React.createElement(WordView, { word, presentation: 'study', hideMeanings: true }),
  );
  const card = render(React.createElement(WordCardContent, { word }));
  expect(hidden).not.toContain('data-sentence-');
  expect(hidden).not.toContain('黎明');
  expect(card).not.toContain('data-sentence-');
  expect(card).not.toContain('class="word-token"');
});
