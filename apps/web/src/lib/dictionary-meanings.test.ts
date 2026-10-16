import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import { DictionaryMeanings } from '../components/DictionaryMeanings';
import { WordCardContext } from './word-cards';
import type { Sense } from './types';

const state = vi.hoisted(() => {
  vi.stubGlobal('window', { __NIGHTSTUDY_CONFIG__: {} });
  return { open: false };
});
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: () => [state.open, (open: boolean) => (state.open = open)],
}));
const senses: Sense[] = [
  {
    id: 'bilingual-row',
    pos: 'n.',
    definitionZh: '中文原行',
    definitionEn: 'A paired source explanation.',
    exampleEn: 'An unbound source sentence must stay hidden.',
    exampleZh: '旧内嵌例句不可展示。',
    contentMetadata: { definitionEn: { model: 'hidden-model', license: 'hidden-license' } },
    examples: [{ id: 'unbound', exampleEn: 'Another unsafe sentence.', exampleZh: '不安全句。' }],
  },
  { id: 'zh-only', pos: 'v.', definitionZh: '独立中文行' },
  { id: 'en-only', pos: 'v.', definitionZh: '', definitionEn: 'An independent English row.' },
  { id: 'empty', definitionZh: '', definitionEn: '' },
];
const h = React.createElement;
function tree(interactive = false) {
  return DictionaryMeanings({ senses, interactive });
}
function markup() {
  return renderToStaticMarkup(
    h(WordCardContext.Provider, { value: { openWord: vi.fn(), leaveWord: vi.fn() } }, tree()),
  );
}
function toggle(open: boolean) {
  const node = tree()!;
  const target = { open };
  node.props.onToggle({ target, currentTarget: target });
}
beforeEach(() => {
  state.open = false;
  vi.stubGlobal('React', React);
});

it('mounts raw definitions only while the user opens the disclosure', () => {
  expect(markup()).toContain('更多词典释义');
  expect(markup()).toContain('dictionary-meanings-count">3');
  expect(markup()).not.toContain('中文原行');
  toggle(true);
  expect(markup()).toContain('中文原行');
  toggle(false);
  expect(markup()).not.toContain('中文原行');
  const node = tree()!;
  node.props.onToggle({ target: { open: true }, currentTarget: { open: false } });
  expect(state.open).toBe(false);
});

it('keeps each source row independent and excludes examples, metadata and recursive cards', () => {
  toggle(true);
  const value = markup();
  expect(value).toContain('A paired source explanation.');
  expect(value).toContain('独立中文行');
  expect(value).toContain('An independent English row.');
  expect((value.match(/aria-label="中英释义对照"/g) ?? []).length).toBe(1);
  expect(value).toContain('aria-label="中文释义"');
  expect(value).toContain('aria-label="英文释义"');
  expect((value.match(/以下释义暂无配套例句。/g) ?? []).length).toBe(1);
  for (const hidden of [
    'unbound',
    '旧内嵌例句',
    'Another unsafe',
    'hidden-model',
    'hidden-license',
    'word-token',
  ])
    expect(value).not.toContain(hidden);
});
