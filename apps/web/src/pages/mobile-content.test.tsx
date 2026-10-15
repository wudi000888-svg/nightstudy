import React, { type ReactElement, type ReactNode } from 'react';
import { QueryClient } from '@tanstack/react-query';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { HomePage } from './Home';
import { ContentPage } from './Content';
import { NotesPage } from './NotesLibrary';
import { AcademyPage } from './Academy';
import { PreferencesSettings } from './PreferencesSettings';
import { SentenceSaveButton } from '../components/SentenceSaveButton';
import { api, ApiError, post } from '../lib/api';
import type { AcademyAttempt } from '../lib/mobile-content-types';

const state = vi.hoisted(() => {
  vi.stubGlobal('window', { __NIGHTSTUDY_CONFIG__: {} });
  return {
    scope: 'mobile:learner-a',
    user: true,
    slots: [] as unknown[],
    cursor: 0,
    refs: [] as { current: unknown }[],
    refCursor: 0,
    params: new URLSearchParams(),
    remote: {} as Record<string, unknown>,
    batches: {} as Record<string, unknown[]>,
    client: null as QueryClient | null,
    preferences: {
      theme: 'day',
      accent: 'us',
      autoPlay: false,
      spellingEnabled: true,
      fontScale: 1,
      reminderEnabled: false,
      reminderTime: '20:00',
      revision: 3,
    },
    savePreferences: vi.fn(),
    plan: null as unknown,
  };
});
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
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
  useRef: (initial: unknown) => (state.refs[state.refCursor++] ??= { current: initial }),
  useEffect: () => {},
  useId: () => 'mobile-test-dialog',
}));
vi.mock('../AppContext', () => ({
  useApp: () => ({
    user: state.user
      ? { id: 'learner-a', name: '学习者', email: 'fixture@example.test', role: 'user' }
      : null,
    scope: state.scope,
    pending: 0,
    site: { title: '测试自习室' },
  }),
  useRemote: (_key: string, path: string) => ({
    data: state.client?.getQueryData([state.scope, _key, path]) ?? state.remote[path],
    isPending: false,
    isFetching: false,
    error: null,
    refetch: vi.fn().mockResolvedValue({}),
  }),
}));
vi.mock('../LearningPreferences', () => ({
  useLearningPreferences: () => ({
    preferences: state.preferences,
    loaded: true,
    saving: false,
    error: null,
    savePreferences: state.savePreferences,
    resetError: vi.fn(),
    reloadPreferences: vi.fn(),
  }),
}));
vi.mock('../lib/word-cards', () => ({
  useWordCards: () => ({ openWord: vi.fn(), leaveWord: vi.fn() }),
}));
vi.mock('../components/tasks/useBookPlan', () => ({
  useBookPlan: () => ({
    query: { data: state.plan, error: null, isPending: false },
    choose: vi.fn(),
    dialog: null,
  }),
}));
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useSearchParams: () => [
    state.params,
    (next: URLSearchParams | Record<string, string>) => {
      state.params = new URLSearchParams(next);
    },
  ],
  useNavigate: () => vi.fn(),
}));
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => state.client,
  useInfiniteQuery: (options: { queryKey: unknown[] }) => ({
    data: {
      pages: [
        {
          items: state.batches[String(options.queryKey[1])] ?? [],
          page: { total: 0, hasMore: false, nextCursor: null },
        },
      ],
    },
    isPending: false,
    error: null,
    hasNextPage: false,
    isFetchingNextPage: false,
    refetch: vi.fn(),
  }),
}));
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  api: vi.fn(),
  post: vi.fn(),
  newId: () => '19b1a291-d724-46a2-9a3d-af2bbc47e64e',
}));
type Element = ReactElement<Record<string, unknown>>;
function all(node: ReactNode): Element[] {
  if (!React.isValidElement<Record<string, unknown>>(node))
    return Array.isArray(node) ? node.flatMap(all) : [];
  return [node, ...all(node.props.children as ReactNode)];
}
function text(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return React.isValidElement<Record<string, unknown>>(node)
    ? text(node.props.children as ReactNode)
    : '';
}
function find(tree: ReactNode, predicate: (node: Element) => boolean) {
  const found = all(tree).find(predicate);
  if (!found) throw Error('Expected actual control missing');
  return found;
}
function render(component: () => ReactNode) {
  state.cursor = state.refCursor = 0;
  return component();
}
const click = (element: Element) => (element.props.onClick as () => void)();
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
beforeAll(() => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Error('Unexpected network')));
});
beforeEach(() => {
  state.scope = 'mobile:learner-a';
  state.user = true;
  state.slots = [];
  state.refs = [];
  state.cursor = state.refCursor = 0;
  state.params = new URLSearchParams();
  state.remote = {};
  state.batches = {};
  state.plan = null;
  state.client?.clear();
  state.client = new QueryClient();
  vi.mocked(api).mockReset().mockResolvedValue({});
  vi.mocked(post).mockReset().mockResolvedValue({});
  state.savePreferences.mockReset().mockResolvedValue(true);
});
afterAll(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  state.client?.clear();
  vi.unstubAllGlobals();
});

it('keeps the daily unique goal distinct from the group limit and routes both shortcuts into the real daily flow', () => {
  state.plan = {
    plan: {
      localDate: '2026-10-15',
      bookId: null,
      bookTitle: '日常词书',
      dailyTotalGoal: 60,
      completedUnique: 32,
      completedNew: 12,
      completedReview: 20,
      groupSize: 5,
      newRemaining: 8,
      dueNowCount: 4,
    },
    settings: {},
  };
  const tree = render(HomePage);
  expect(text(tree)).toContain('32 / 60');
  expect(text(tree)).toContain('本组上限 5 词');
  expect(text(tree)).not.toContain('32 / 5');
  expect(all(tree).filter((node) => node.props.to === '/learn?start=1')).toHaveLength(1);
  expect(all(tree).filter((node) => node.props.to === '/review?start=1')).toHaveLength(1);
  expect(text(tree)).toContain('先复习，再学新词');
});
it('gives guests a real login destination for their private content and keeps public lookup available', () => {
  state.user = false;
  const tree = render(ContentPage);
  expect(all(tree).filter((node) => node.props.to === '/auth').length).toBeGreaterThanOrEqual(7);
  expect(all(tree).some((node) => node.props.to === '/lookup')).toBe(true);
  expect(text(tree)).not.toContain('516');
});

const sourcePath = 'sentences/status?wordId=word-rain';
function unsaved() {
  state.remote[sourcePath] = {
    wordId: 'word-rain',
    items: [
      { sourceType: 'word-example', sourceId: 'example-rain', saved: false, sentenceId: null },
    ],
  };
  state.client!.setQueryData([state.scope, 'sentences', sourcePath], state.remote[sourcePath]);
}
const saveButton = () =>
  SentenceSaveButton({ wordId: 'word-rain', sourceType: 'word-example', sourceId: 'example-rain' });
it('uses exact sentence status rather than the first page and cancels only the returned saved id', async () => {
  state.remote[sourcePath] = {
    wordId: 'word-rain',
    items: [
      {
        sourceType: 'word-example',
        sourceId: 'example-rain',
        saved: true,
        sentenceId: 'saved-outside-first-page',
      },
    ],
  };
  const tree = render(saveButton);
  const button = find(
    tree,
    (node) => node.type === 'button' && node.props['aria-pressed'] === true,
  );
  click(button);
  await settle();
  expect(api).toHaveBeenCalledWith('sentences/saved-outside-first-page', { method: 'DELETE' });
  expect(post).not.toHaveBeenCalled();
});
it('submits one source-bound sentence on double click and immediately updates its exact state', async () => {
  unsaved();
  vi.mocked(post).mockResolvedValue({
    sentence: {
      id: 'saved-rain',
      wordId: 'word-rain',
      sourceType: 'word-example',
      sourceId: 'example-rain',
    },
  });
  const tree = render(saveButton);
  const button = find(tree, (node) => node.type === 'button');
  click(button);
  click(button);
  await settle();
  expect(post).toHaveBeenCalledTimes(1);
  expect(post).toHaveBeenCalledWith('sentences', {
    wordId: 'word-rain',
    sourceType: 'word-example',
    sourceId: 'example-rain',
  });
  expect(state.client!.getQueryData([state.scope, 'sentences', sourcePath])).toMatchObject({
    items: [{ saved: true, sentenceId: 'saved-rain' }],
  });
  expect(text(render(saveButton))).toContain('已加入句库');
});
it('does not publish an old sentence response into another account scope', async () => {
  unsaved();
  let resolve!: (value: unknown) => void;
  vi.mocked(post).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  click(find(render(saveButton), (node) => node.type === 'button'));
  await settle();
  state.scope = 'mobile:learner-b';
  render(saveButton);
  resolve({
    sentence: {
      id: 'saved-a',
      wordId: 'word-rain',
      sourceType: 'word-example',
      sourceId: 'example-rain',
    },
  });
  await settle();
  expect(state.client!.getQueryData(['mobile:learner-b', 'sentences', sourcePath])).toBeUndefined();
  expect(text(render(saveButton))).not.toContain('已加入句库');
});

it('creates a real note with the selected word and no client-supplied ownership', async () => {
  state.params = new URLSearchParams('wordId=word-rain');
  let tree = render(NotesPage);
  (
    find(tree, (node) => node.type === 'input' && node.props.maxLength === 120).props.onChange as (
      event: unknown,
    ) => void
  )({ target: { value: 'Rain 与 shower' } });
  (find(tree, (node) => node.type === 'textarea').props.onChange as (event: unknown) => void)({
    target: { value: '记录两种雨的语境。' },
  });
  tree = render(NotesPage);
  (
    find(tree, (node) => node.type === 'form' && node.props.className === 'form-stack').props
      .onSubmit as (event: unknown) => void
  )({ preventDefault() {} });
  await settle();
  expect(post).toHaveBeenCalledWith(
    'notes',
    { title: 'Rain 与 shower', body: '记录两种雨的语境。', wordId: 'word-rain' },
    'POST',
  );
  expect(text(render(NotesPage))).toContain('笔记已保存');
});
it('preserves the expected note revision on conflict and requires explicit fresh reading before replacing the draft', async () => {
  const note = {
    id: 'note-1',
    title: '旧标题',
    body: '自己的旧笔记',
    wordId: null,
    revision: 7,
    updatedAt: '2026-10-15T00:00:00Z',
  };
  state.batches.notes = [note];
  let tree = render(NotesPage);
  click(find(tree, (node) => node.props.className === 'mobile-note-open'));
  tree = render(NotesPage);
  vi.mocked(post).mockRejectedValue(new ApiError(409, '笔记已在另一处更新', 'note_conflict'));
  (
    find(tree, (node) => node.type === 'form' && node.props.className === 'form-stack').props
      .onSubmit as (event: unknown) => void
  )({ preventDefault() {} });
  await settle();
  expect(post).toHaveBeenCalledWith(
    'notes/note-1',
    expect.objectContaining({ expectedRevision: 7 }),
    'PATCH',
  );
  tree = render(NotesPage);
  expect(text(tree)).toContain('本次修改未覆盖服务器版本');
  expect(api).not.toHaveBeenCalled();
  vi.mocked(api).mockResolvedValue({ note: { ...note, title: '服务端新标题', revision: 8 } });
  click(
    find(tree, (node) => node.type === 'button' && text(node) === '放弃本地修改并读取最新版本'),
  );
  await settle();
  expect(api).toHaveBeenCalledWith('notes/note-1');
  expect(
    find(render(NotesPage), (node) => node.type === 'input' && node.props.maxLength === 120).props
      .value,
  ).toBe('服务端新标题');
});

const attempt: AcademyAttempt = {
  id: 'attempt-one',
  lessonId: 'lesson-one',
  lessonVersion: '1',
  kind: 'listening',
  status: 'in_progress',
  revision: 4,
  startedAt: '2026-10-15T00:00:00Z',
  completedAt: null,
  lesson: {
    id: 'lesson-one',
    title: '已签发的短课',
    description: '听音练习',
    category: 'listening',
    level: 'starter',
    durationMinutes: 3,
    version: '1',
    original: true,
    license: 'MIT',
    body: [],
    vocabulary: [],
    listeningTargets: ['rain'],
    speech: null,
    completionPolicy: 'objective-listening',
  },
  items: [
    {
      id: 'question-one',
      prompt: '听到的是哪个词？',
      audioUrl: '/api/v2/audio/rain',
      options: [
        { id: 'option-rain', text: '雨' },
        { id: 'option-window', text: '窗' },
      ],
    },
  ],
  result: null,
};
it('submits only canonical listening item ids once and displays the server result', async () => {
  state.params = new URLSearchParams('lesson=lesson-one&attempt=attempt-one');
  state.slots[0] = attempt;
  state.slots[1] = { 'question-one': 'option-rain' };
  state.remote['academy/attempts/attempt-one'] = { attempt };
  vi.mocked(post).mockResolvedValue({
    attempt: {
      ...attempt,
      status: 'completed',
      revision: 5,
      completedAt: '2026-10-15T00:01:00Z',
      result: {
        completed: true,
        score: 100,
        total: 1,
        correct: 1,
        feedback: [],
        assessmentKind: 'objective-listening',
      },
    },
  });
  const tree = render(AcademyPage);
  const submit = find(tree, (node) => node.type === 'button' && text(node) === '提交本组答案');
  click(submit);
  click(submit);
  await settle();
  expect(post).toHaveBeenCalledTimes(1);
  expect(post).toHaveBeenCalledWith('academy/attempts/attempt-one/submit', {
    commandId: expect.any(String),
    expectedRevision: 4,
    answers: [{ itemId: 'question-one', answer: 'option-rain' }],
  });
  expect(text(render(AcademyPage))).toContain('答对 1 / 1 题，得分 100%');
});
it('renders the issued lesson snapshot and never invents a score for completion-only practice', () => {
  const reading = {
    ...attempt,
    kind: 'reading',
    status: 'completed',
    completedAt: '2026-10-15T00:02:00Z',
    lesson: { ...attempt.lesson, category: 'reading', completionPolicy: 'completion-only' },
    items: [],
    result: {
      completed: true,
      score: null,
      total: null,
      correct: null,
      feedback: [],
      assessmentKind: 'completion-only',
    },
  } as AcademyAttempt;
  state.params = new URLSearchParams('lesson=lesson-one&attempt=attempt-one');
  state.slots[0] = reading;
  state.remote['academy/attempts/attempt-one'] = { attempt: reading };
  state.remote['academy/lesson-one'] = { lesson: { ...reading.lesson, title: '新版本的不同标题' } };
  const tree = render(AcademyPage);
  expect(text(tree)).toContain('已签发的短课');
  expect(text(tree)).not.toContain('新版本的不同标题');
  expect(text(tree)).toContain('不提供能力分数');
  expect(text(tree)).not.toContain('0%');
});
it('saves preferences as a revision-free patch through the shared provider and does not claim success for a rejected save', async () => {
  state.savePreferences.mockResolvedValue(false);
  let tree = render(PreferencesSettings);
  (find(tree, (node) => node.type === 'form').props.onSubmit as (event: unknown) => void)({
    preventDefault() {},
  });
  await settle();
  expect(state.savePreferences).toHaveBeenCalledWith(
    expect.objectContaining({ accent: 'us', spellingEnabled: true }),
  );
  expect(state.savePreferences.mock.calls[0]?.[0]).not.toHaveProperty('revision');
  expect(text(render(PreferencesSettings))).not.toContain('学习偏好已保存');
});
