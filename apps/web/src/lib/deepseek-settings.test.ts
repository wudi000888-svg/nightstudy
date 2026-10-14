import React, { type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  DeepSeekPreview,
  DeepSeekSettings,
  type DeepSeekCandidate,
  type DeepSeekConfig,
} from '../components/DeepSeekSettings';
import { AdminConfirm } from '../components/AdminConfirm';
import { AdminPage } from '../pages/Admin';
import { Dialog } from '../components/UI';
import { adminWordEditorUrl } from './admin-word-editor';
import { api, ApiError, post } from './api';
import type { Word } from './types';

const state = vi.hoisted(() => {
  vi.stubGlobal('window', { __NIGHTSTUDY_CONFIG__: {} });
  return {
    scope: 'deepseek-ui:admin-a',
    role: 'admin',
    config: null as DeepSeekConfig | null,
    slots: [] as unknown[],
    cursor: 0,
    refs: [] as { current: unknown }[],
    refCursor: 0,
    remoteCalls: [] as unknown[][],
    effects: [] as (() => unknown)[],
    location: { pathname: '/admin/content', search: '' },
    summary: null as Word | null,
  };
});
// A small hook harness exercises actual form handlers in Node without a DOM,
// browser effect, provider call or additional test dependency.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = state.cursor++;
      if (!(index in state.slots))
        state.slots[index] = typeof initial === 'function' ? initial() : initial;
      return [
        state.slots[index],
        (value: unknown) => {
          state.slots[index] = typeof value === 'function' ? value(state.slots[index]) : value;
        },
      ];
    },
    useRef: (initial: unknown) => {
      const index = state.refCursor++;
      return (state.refs[index] ??= { current: initial });
    },
    useEffect: (effect: () => unknown) => {
      state.effects.push(effect);
    },
  };
});
vi.mock('../AppContext', () => ({
  useApp: () => ({
    scope: state.scope,
    user: { id: 'admin-a', role: state.role },
    site: { title: '测试自习室', version: 'test' },
  }),
  useRemote: (...args: unknown[]) => {
    state.remoteCalls.push(args);
    return {
      data:
        args[0] === 'admin-deepseek'
          ? state.config
          : args[0] === 'admin-words'
            ? {
                items: state.summary ? [state.summary] : [],
                page: { total: 1, hasMore: false, nextCursor: null },
              }
            : undefined,
      isPending: false,
      error: null,
      refetch: vi.fn().mockResolvedValue({}),
    };
  },
}));
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useLocation: () => state.location };
});
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    cancelQueries: vi.fn().mockResolvedValue(undefined),
    setQueryData: (_key: unknown, value: DeepSeekConfig) => {
      state.config = value;
    },
  }),
}));
vi.mock('../components/AdminConfirm', () => ({ AdminConfirm: () => null }));
vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return { ...actual, api: vi.fn(), post: vi.fn() };
});

const config: DeepSeekConfig = {
  enabled: true,
  assessmentEnabled: false,
  configured: true,
  model: 'deepseek-flash',
  models: ['deepseek-flash', 'deepseek-v4-pro'],
  baseUrl: 'https://api.deepseek.com',
  keyPreview: 'redacted-preview-only-1234',
  updatedAt: '2026-10-14T00:00:00Z',
};
const word: Word = {
  id: 'deepseek-ui-water',
  lemma: 'water',
  senses: [{ id: 'water-noun', pos: 'n.', definitionZh: '水', definitionEn: '' }],
};
const candidate: DeepSeekCandidate = {
  preview: {
    wordId: word.id,
    lemma: word.lemma,
    definitions: [
      {
        sourceSenseId: 'water-noun',
        field: 'definitionEn',
        sourceTextSha256: 'a'.repeat(64),
        sourceText: '水',
        sourceField: 'definitionZh',
        sourceLanguage: 'zh',
        value: 'A clear liquid.',
        contentMetadata: { kind: 'machine-translation', review: 'pending' },
      },
    ],
    examples: [
      {
        sourceSenseId: 'water-noun',
        sourceTextSha256: 'a'.repeat(64),
        sourceText: '水',
        sourceField: 'definitionZh',
        sourceLanguage: 'zh',
        exampleEn: 'She poured water into the clean glass.',
        exampleZh: '她把水倒进干净的杯子里。',
        contentMetadata: { exampleEn: { kind: 'generated', review: 'pending' } },
      },
    ],
    review: 'pending',
    applied: false,
  },
  usage: { promptTokens: 20, completionTokens: 40, totalTokens: 60 },
};
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (!React.isValidElement<Record<string, unknown>>(node)) {
    return Array.isArray(node) ? node.flatMap(elements) : [];
  }
  return [node, ...elements(node.props.children as ReactNode)];
}
function renderContent() {
  state.cursor = 0;
  state.refCursor = 0;
  const wrapper = DeepSeekSettings()!;
  return (wrapper.type as () => ReactElement)();
}
function renderAdmin() {
  state.cursor = 0;
  state.refCursor = 0;
  const wrapper = AdminPage();
  return (wrapper.type as () => ReactElement)();
}
function find(tree: ReactNode, predicate: (element: Element) => boolean) {
  const element = elements(tree).find(predicate);
  if (!element) throw new Error('Expected UI element is missing');
  return element;
}
function text(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return React.isValidElement<{ children: ReactNode }>(node) ? text(node.props.children) : '';
}
function button(tree: ReactNode, label: string) {
  return find(tree, (element) => element.type === 'button' && text(element).includes(label));
}
function change(element: Element, value: string) {
  (element.props.onChange as (event: unknown) => void)({ target: { value } });
}
async function click(element: Element) {
  await (element.props.onClick as () => void | Promise<void>)();
}
function submit(element: Element) {
  (element.props.onSubmit as (event: unknown) => void)({ preventDefault: vi.fn() });
}
beforeAll(() => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unexpected paid/network request')));
});
beforeEach(() => {
  state.scope = 'deepseek-ui:admin-a';
  state.role = 'admin';
  state.config = { ...config };
  state.slots = [];
  state.refs = [];
  state.remoteCalls = [];
  state.effects = [];
  state.location = { pathname: '/admin/content', search: '' };
  state.summary = null;
  vi.mocked(api).mockReset();
  vi.mocked(post).mockReset();
});
afterAll(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

it('reads only saved configuration automatically and never fills the password input with its preview', () => {
  const tree = renderContent();
  const markup = renderToStaticMarkup(React.createElement(MemoryRouter, null, tree));
  expect(state.remoteCalls).toEqual([['admin-deepseek', 'admin/ai/deepseek']]);
  expect(post).not.toHaveBeenCalled();
  expect(api).not.toHaveBeenCalled();
  expect(markup).toContain('type="password"');
  const input = find(tree, (element) => element.props.name === 'deepseek-api-key');
  expect(input.props.value).toBe('');
  expect(input.props.autoComplete).toBe('off');
  expect(markup).toMatch(/<input[^>]*name="deepseek-api-key"[^>]*value=""/);
  expect(markup).toContain('尾号 1234');
  expect(markup).not.toContain(config.keyPreview);
  expect(markup).toContain('会使用 API 额度');
});

it('requires saving the independent assessment switch and does not call the provider while configuring it', async () => {
  const label = find(
    renderContent(),
    (element) => element.type === 'label' && text(element).startsWith('水平测试智能分析'),
  );
  const select = find(label, (element) => element.type === 'select');
  expect(select.props.value).toBe('disabled');
  change(select, 'enabled');
  const tree = renderContent();
  expect(button(tree, '检测连接').props.disabled).toBe(true);
  expect(post).not.toHaveBeenCalled();
  vi.mocked(post).mockResolvedValue({ ...config, assessmentEnabled: true });
  submit(find(tree, (element) => element.type === 'form'));
  await vi.waitFor(() =>
    expect(post).toHaveBeenCalledExactlyOnceWith(
      'admin/ai/deepseek',
      { enabled: true, assessmentEnabled: true, model: config.model },
      'PUT',
    ),
  );
  expect(api).not.toHaveBeenCalled();
});

it('preserves an empty key and only sends strict settings fields; saving a new key clears the input', async () => {
  vi.mocked(post).mockResolvedValue(config);
  submit(find(renderContent(), (element) => element.type === 'form'));
  await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  expect(post).toHaveBeenLastCalledWith(
    'admin/ai/deepseek',
    { enabled: true, assessmentEnabled: false, model: 'deepseek-flash' },
    'PUT',
  );
  await vi.waitFor(() => expect(state.slots[2]).toBe(null));
  change(
    find(renderContent(), (element) => element.props.name === 'deepseek-api-key'),
    'sk-ui-test-only',
  );
  let tree = renderContent();
  expect(button(tree, '检测连接').props.disabled).toBe(true);
  submit(find(tree, (element) => element.type === 'form'));
  await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2));
  expect(post).toHaveBeenLastCalledWith(
    'admin/ai/deepseek',
    { enabled: true, assessmentEnabled: false, model: 'deepseek-flash', apiKey: 'sk-ui-test-only' },
    'PUT',
  );
  await vi.waitFor(() => expect(state.slots[2]).toBe(null));
  tree = renderContent();
  expect(find(tree, (element) => element.props.name === 'deepseek-api-key').props.value).toBe('');
});

it('requires explicit confirmation to delete the saved key and disables the provider afterwards', async () => {
  vi.mocked(post).mockResolvedValue({
    ...config,
    configured: false,
    enabled: false,
    keyPreview: null,
  });
  await click(button(renderContent(), '删除密钥'));
  expect(post).not.toHaveBeenCalled();
  const confirmation = find(renderContent(), (element) => element.type === AdminConfirm).props
    .action as { message: string; run: () => Promise<void> };
  expect(confirmation.message).toContain('AI 服务会同时关闭');
  await confirmation.run();
  expect(post).toHaveBeenCalledExactlyOnceWith('admin/ai/deepseek', { removeKey: true }, 'PUT');
  expect(button(renderContent(), '检测连接').props.disabled).toBe(true);
});

it('rejects nonexact lookup results and generates only a manually requested candidate for the exact word', async () => {
  vi.mocked(api).mockResolvedValue({
    word,
    queried: 'wat',
    matchedLemma: 'water',
    matchType: 'inflection',
  });
  let tree = renderContent();
  change(
    find(tree, (element) => element.props.placeholder === '输入完整词形，精确查找'),
    'wat',
  );
  submit(
    find(
      renderContent(),
      (element) => element.type === 'form' && text(element).includes('精确查词'),
    ),
  );
  await vi.waitFor(() => expect(state.slots[2]).toBe(null));
  expect(api).toHaveBeenLastCalledWith('dictionary/resolve?text=wat');
  expect(text(renderContent())).toContain('没有找到准确匹配');
  expect(post).not.toHaveBeenCalled();
  vi.mocked(api).mockResolvedValue({
    word,
    queried: 'water',
    matchedLemma: 'water',
    matchType: 'exact',
  });
  change(
    find(renderContent(), (element) => element.props.placeholder === '输入完整词形，精确查找'),
    'water',
  );
  submit(
    find(
      renderContent(),
      (element) => element.type === 'form' && text(element).includes('精确查词'),
    ),
  );
  await vi.waitFor(() => expect(state.slots[2]).toBe(null));
  expect(post).not.toHaveBeenCalled();
  vi.mocked(post).mockResolvedValue(candidate);
  await click(button(renderContent(), '生成补全预览'));
  expect(post).toHaveBeenCalledExactlyOnceWith('admin/ai/deepseek/preview', { wordId: word.id });
  tree = renderContent();
  expect(elements(tree).some((element) => element.type === DeepSeekPreview)).toBe(true);
  const markup = renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(DeepSeekPreview, { candidate, word, onCopy: () => {} }),
    ),
  );
  expect(markup).toContain('待校对 · 尚未保存到词库');
  expect(markup).toContain('A clear liquid.');
  expect(markup).toContain('她把水倒进干净的杯子里。');
  expect(markup).not.toContain('word-token');
  expect(post).toHaveBeenCalledTimes(1);
});

it('uses the manual test endpoint and shows only the safe API message on failure', async () => {
  vi.mocked(post).mockRejectedValue(
    new ApiError(402, 'DeepSeek 账户余额不足，请自行检查账户', 'deepseek_insufficient_balance', {
      rawUpstream: 'private-test-sentinel-never-render',
    }),
  );
  await click(button(renderContent(), '检测连接'));
  expect(post).toHaveBeenCalledExactlyOnceWith('admin/ai/deepseek/test', {});
  const markup = renderToStaticMarkup(React.createElement(MemoryRouter, null, renderContent()));
  expect(markup).toContain('DeepSeek 账户余额不足');
  expect(markup).not.toContain('private-test-sentinel-never-render');
  expect(post).toHaveBeenCalledTimes(1);
});

it('does not create duplicate paid requests when the same rendered button is clicked twice', async () => {
  let complete!: (value: unknown) => void;
  vi.mocked(post).mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const target = button(renderContent(), '检测连接');
  const first = click(target);
  await click(target);
  expect(post).toHaveBeenCalledTimes(1);
  complete({ ok: true, provider: 'deepseek', model: config.model, usage: null });
  await first;
  expect(post).toHaveBeenCalledTimes(1);
});

it('drops the private subtree on account scope changes and does not render it for learners', () => {
  const key = DeepSeekSettings()!.key;
  state.scope = 'deepseek-ui:admin-b';
  expect(DeepSeekSettings()!.key).not.toBe(key);
  state.role = 'user';
  expect(DeepSeekSettings()).toBeNull();
  expect(state.remoteCalls).toEqual([]);
});

it('shows the server-bound source rather than stale lookup text and links to the exact candidate sense', () => {
  const updated = {
    ...candidate,
    preview: {
      ...candidate.preview,
      definitions: candidate.preview.definitions.map((definition) => ({
        ...definition,
        sourceSenseId: 'nonfirst-sense',
        sourceText: '服务端本次使用的原义',
      })),
    },
  };
  const staleWord = { ...word, senses: [{ ...word.senses![0]!, definitionZh: '旧的查词缓存' }] };
  const markup = renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(DeepSeekPreview, {
        candidate: updated,
        word: staleWord,
        onCopy: () => {},
      }),
    ),
  );
  expect(markup).toContain('服务端本次使用的原义');
  expect(markup).not.toContain('旧的查词缓存');
  expect(markup).toContain(
    `wordId=${word.id}&amp;senseId=nonfirst-sense&amp;sourceField=definitionZh&amp;sourceHash=${'a'.repeat(64)}`,
  );
  expect(markup).toContain('当前内容编辑器只保存所选义项的例句');
});

it('discards preview responses for a different canonical word before rendering or copying', async () => {
  vi.mocked(api).mockResolvedValue({
    word,
    queried: 'water',
    matchedLemma: 'water',
    matchType: 'exact',
  });
  change(
    find(renderContent(), (element) => element.props.placeholder === '输入完整词形，精确查找'),
    'water',
  );
  submit(
    find(
      renderContent(),
      (element) => element.type === 'form' && text(element).includes('精确查词'),
    ),
  );
  await vi.waitFor(() => expect(state.slots[2]).toBe(null));
  vi.mocked(post).mockResolvedValue({
    ...candidate,
    preview: { ...candidate.preview, wordId: 'wrong-word' },
  });
  await click(button(renderContent(), '生成补全预览'));
  const tree = renderContent();
  expect(elements(tree).some((element) => element.type === DeepSeekPreview)).toBe(false);
  expect(elements(tree).some((element) => element.type === 'textarea')).toBe(false);
  const markup = renderToStaticMarkup(React.createElement(MemoryRouter, null, tree));
  expect(markup).toContain('候选与当前选择的词不一致');
});

const rawWord: Word = {
  ...word,
  status: 'draft',
  contentVersion: 'ui-editor-version-one',
  senses: [
    { id: 'first', pos: 'n.', definitionZh: '水', definitionEn: 'A clear liquid.' },
    { id: 'second', pos: 'v.', definitionZh: '浇水', definitionEn: '' },
    { id: 'third', pos: 'n.', definitionZh: '', definitionEn: 'An area of sea.' },
    { id: 'fourth', pos: 'n.', definitionZh: '水域', definitionEn: '' },
  ],
};
function senseSelect(tree: ReactNode) {
  const label = find(
    tree,
    (element) => element.type === 'label' && text(element).startsWith('选择原始义项'),
  );
  return find(label, (element) => element.type === 'select');
}
function labelledTextarea(tree: ReactNode, labelText: string) {
  const label = find(tree, (element) => element.type === 'label' && text(element) === labelText);
  return find(label, (element) => element.type === 'textarea');
}

it('the actual editor loads full detail, selects all raw senses and saves an English-only sense without changing the first one', async () => {
  state.summary = { ...rawWord, senses: rawWord.senses!.slice(0, 1) };
  vi.mocked(api).mockResolvedValue({ word: rawWord });
  await click(button(renderAdmin(), '编辑'));
  await vi.waitFor(() =>
    expect(
      elements(senseSelect(renderAdmin())).filter((element) => element.type === 'option'),
    ).toHaveLength(5),
  );
  expect(api).toHaveBeenCalledExactlyOnceWith(`admin/words/${rawWord.id}`, {
    signal: expect.any(AbortSignal),
  });
  change(senseSelect(renderAdmin()), 'third');
  let tree = renderAdmin();
  expect(labelledTextarea(tree, '中文释义').props.required).not.toBe(true);
  expect(labelledTextarea(tree, '中文释义').props.value).toBe('');
  expect(labelledTextarea(tree, '英文释义').props.value).toBe('An area of sea.');
  change(labelledTextarea(tree, '英文释义'), 'An expanse of sea.');
  vi.mocked(post).mockResolvedValue({});
  tree = renderAdmin();
  submit(
    find(tree, (element) => element.type === 'form' && text(element).includes('人工保存内容')),
  );
  await vi.waitFor(() =>
    expect(find(renderAdmin(), (element) => element.type === Dialog).props.open).toBe(false),
  );
  expect(post).toHaveBeenCalledExactlyOnceWith(
    `admin/words/${rawWord.id}`,
    {
      status: 'draft',
      expectedContentVersion: 'ui-editor-version-one',
      senseId: 'third',
      definitionZh: '',
      definitionEn: 'An expanse of sea.',
      exampleEn: '',
      exampleZh: '',
    },
    'PATCH',
  );
  expect(rawWord.senses![0]!.definitionEn).toBe('A clear liquid.');
});

it('the exact candidate route opens the nonfirst sense and warns when its fresh source differs', async () => {
  const url = adminWordEditorUrl({
    wordId: rawWord.id,
    senseId: 'fourth',
    sourceField: 'definitionZh',
    sourceHash: 'a'.repeat(64),
  });
  state.location = { pathname: '/admin/words', search: url.slice(url.indexOf('?')) };
  vi.mocked(api).mockResolvedValue({ word: rawWord });
  renderAdmin();
  state.effects.splice(0).forEach((effect) => effect());
  await vi.waitFor(() => expect(senseSelect(renderAdmin()).props.value).toBe('fourth'));
  expect(text(renderAdmin())).toContain('候选依据的原义已改变，请重新生成预览');
  expect(labelledTextarea(renderAdmin(), '英文释义').props.value).toBe('');
  expect(post).not.toHaveBeenCalled();
});

it('a content-version conflict keeps the manual draft and prevents another write until explicit reload', async () => {
  state.summary = { ...rawWord, senses: rawWord.senses!.slice(0, 1) };
  vi.mocked(api).mockResolvedValue({ word: rawWord });
  await click(button(renderAdmin(), '编辑'));
  await vi.waitFor(() => expect(senseSelect(renderAdmin()).props.value).toBe('first'));
  change(labelledTextarea(renderAdmin(), '英文释义'), 'Unsaved manual text.');
  vi.mocked(post).mockRejectedValue(
    new ApiError(409, '词条已被更新，请重新载入后校对', 'word_content_changed'),
  );
  submit(
    find(
      renderAdmin(),
      (element) => element.type === 'form' && text(element).includes('人工保存内容'),
    ),
  );
  await vi.waitFor(() => expect(button(renderAdmin(), '人工保存内容').props.disabled).toBe(true));
  expect(labelledTextarea(renderAdmin(), '英文释义').props.value).toBe('Unsaved manual text.');
  submit(
    find(
      renderAdmin(),
      (element) => element.type === 'form' && text(element).includes('人工保存内容'),
    ),
  );
  expect(post).toHaveBeenCalledTimes(1);
  await vi.waitFor(() =>
    expect(button(renderAdmin(), '重新载入原义项').props.disabled).toBe(false),
  );
  await click(button(renderAdmin(), '重新载入原义项'));
  await vi.waitFor(() =>
    expect(labelledTextarea(renderAdmin(), '英文释义').props.value).toBe('A clear liquid.'),
  );
  expect(button(renderAdmin(), '人工保存内容').props.disabled).toBe(false);
  expect(post).toHaveBeenCalledTimes(1);
});
