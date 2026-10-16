import React, { type ReactElement, type ReactNode } from 'react';
import { QueryClient } from '@tanstack/react-query';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { HomePage, homeEntryDestination } from './Home';
import { H5LearningPage } from './H5Learning';
import { LearningCalendar } from './HomeLearning';
import type { H5HomeSummary, H5HomeEntry } from '../lib/h5-home-types';
import { ContentPage } from './Content';
import { authReturnPath } from './Account';
import { NotesPage } from './NotesLibrary';
import { SentencesPage } from './SentenceLibrary';
import { LearningLibraryPage } from './LearningLibrary';
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
    active: true,
    infiniteOptions: [] as { queryKey: unknown[]; enabled?: boolean }[],
    fetchNextPage: vi.fn(),
    pending: 0,
    conflicts: [] as unknown[],
    navigate: vi.fn(),
    openModule: vi.fn(),
    remotePaths: [] as string[],
    effects: [] as (() => unknown)[],
    refetch: vi.fn(),
    slots: [] as unknown[],
    cursor: 0,
    refs: [] as { current: unknown }[],
    refCursor: 0,
    params: new URLSearchParams(),
    remote: {} as Record<string, unknown>,
    fetching: false,
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
  useEffect: (setup: () => unknown) => {
    state.effects.push(setup);
  },
  useId: () => 'mobile-test-dialog',
}));
vi.mock('../AppContext', () => ({
  useApp: () => ({
    user: state.user
      ? { id: 'learner-a', name: '学习者', email: 'fixture@example.test', role: 'user' }
      : null,
    scope: state.scope,
    pending: state.pending,
    conflicts: state.conflicts,
    site: { title: '测试自习室' },
  }),
  useRemote: (_key: string, path: string) => {
    state.remotePaths.push(path);
    return {
      data: state.client?.getQueryData([state.scope, _key, path]) ?? state.remote[path],
      isPending: false,
      isFetching: state.fetching,
      error: null,
      refetch: state.refetch,
    };
  },
}));
vi.mock('../lib/screen-lifecycle', async (original) => ({
  ...(await original<typeof import('../lib/screen-lifecycle')>()),
  useScreenActive: () => state.active,
}));
vi.mock('../components/AppNavigation', () => ({
  useAppNavigation: () => ({ openModule: state.openModule }),
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
  useNavigate: () => state.navigate,
}));
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => state.client,
  useInfiniteQuery: (options: { queryKey: unknown[]; enabled?: boolean }) => {
    state.infiniteOptions.push(options);
    return {
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
      hasNextPage: true,
      isFetchingNextPage: false,
      fetchNextPage: state.fetchNextPage,
      refetch: vi.fn(),
    };
  },
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
  state.active = true;
  state.infiniteOptions = [];
  state.fetchNextPage.mockReset();
  state.pending = 0;
  state.fetching = false;
  state.conflicts = [];
  state.navigate.mockReset();
  state.openModule.mockReset();
  state.remotePaths = [];
  state.effects = [];
  state.refetch.mockReset().mockResolvedValue({});
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

function homeEntry(
  state: H5HomeEntry['state'],
  count = 0,
  sessionId: string | null = null,
): H5HomeEntry {
  return { state, count, sessionId, sessionRevision: null, phase: null, availableAt: null };
}
function homeSummary(): H5HomeSummary {
  return {
    asOf: '2026-10-15T04:00:00.000Z',
    localDate: '2026-10-15',
    timeZone: 'Asia/Shanghai',
    startsAt: '2026-10-14T20:00:00.000Z',
    endsAt: '2026-10-15T20:00:00.000Z',
    checkedIn: false,
    dailyGoalComplete: false,
    plan: {
      id: 'daily-plan',
      revision: 2,
      bookId: 'book-rain',
      bookTitle: '词书',
      dailyTotalGoal: 60,
      completedUnique: 32,
      completedNew: 12,
      completedReview: 20,
      newRemaining: 8,
      reviewRemaining: 4,
      pendingSpellingCount: 0,
      pendingConsolidationCount: 0,
      nextDueAt: null,
    },
    learn: homeEntry('ready', 8),
    review: homeEntry('ready', 4),
    calendar: {
      days: [{ localDate: '2026-10-15', checkedIn: false, completedGroups: 0 }],
      streak: 0,
    },
  };
}
it.each(['day', 'due'] as const)(
  'reconciles a still-fresh home snapshot when returning after its %s boundary',
  (kind) => {
    const summary = homeSummary();
    if (kind === 'due') {
      summary.review.availableAt = '2026-10-15T04:00:05.000Z';
    }
    state.remote['app/home'] = summary;
    const boundary = kind === 'day' ? summary.endsAt : summary.review.availableAt!;
    const now = vi.spyOn(Date, 'now').mockReturnValue(new Date(boundary).getTime() + 1000);
    try {
      state.active = false;
      render(HomePage);
      for (const setup of state.effects) setup();
      expect(state.refetch).not.toHaveBeenCalled();
      state.effects = [];
      state.active = true;
      render(HomePage);
      for (const setup of state.effects) setup();
      expect(state.refetch).toHaveBeenCalledOnce();
    } finally {
      now.mockRestore();
    }
  },
);
it('keeps the single-screen home to four areas and reads both action counts from one server snapshot', () => {
  state.remote['app/home'] = homeSummary();
  state.plan = { plan: { newRemaining: 99, dueNowCount: 88 }, settings: {} };
  const tree = render(HomePage);
  expect(state.remotePaths).toEqual(['app/home']);
  expect(all(tree).filter((node) => node.type === 'button')).toHaveLength(7);
  expect(all(tree).some((node) => node.type === 'h1' || node.type === 'header')).toBe(false);
  expect(text(tree)).not.toContain('书架');
  expect(text(tree)).not.toContain('99');
  const learn = find(tree, (node) => node.props['aria-label'] === 'Learn，开始，8词');
  const review = find(tree, (node) => node.props['aria-label'] === 'Review，开始，4词');
  click(learn);
  click(review);
  expect(state.navigate.mock.calls).toEqual([['/learn?start=1'], ['/review?start=1']]);
  expect(post).not.toHaveBeenCalled();
});
it('opens the three retained modules and avatar as overlays rather than ordinary page links', () => {
  const tree = render(HomePage);
  for (const label of ['个人中心', '英语学堂', '我的内容', '我的学习'])
    click(find(tree, (node) => node.props['aria-label'] === label));
  expect(state.openModule.mock.calls).toEqual([
    ['account'],
    ['academy'],
    ['content'],
    ['learning'],
  ]);
  expect(state.navigate).not.toHaveBeenCalled();
});
it('preserves a visitor’s exact learning intention through login', () => {
  state.user = false;
  const tree = render(HomePage);
  click(find(tree, (node) => node.props['aria-label'] === 'Review，开始学习'));
  expect(state.navigate).toHaveBeenCalledWith('/auth?next=%2Freview%3Fstart%3D1');
  expect(
    all(tree)
      .filter((node) => node.props.className === 'h5-home-count')
      .map((node) => text(node)),
  ).toEqual(['—', '—']);
});
it('restores only known internal app destinations after authentication', () => {
  expect(authReturnPath('/review?start=1')).toBe('/review?start=1');
  expect(authReturnPath('/learning?section=calendar')).toBe('/learning?section=calendar');
  expect(authReturnPath('/books/import')).toBe('/books/import');
  for (const target of [
    'https://example.test/books',
    '//example.test/books',
    '/books/../../admin',
    '/auth?next=/review',
    'javascript:alert(1)',
    null,
  ])
    expect(authReturnPath(target)).toBe('/');
});
it('keeps unsynchronized or conflicting actions from issuing another task', () => {
  state.pending = 2;
  state.remote['app/home'] = homeSummary();
  const tree = render(HomePage);
  click(find(tree, (node) => node.props['aria-label'] === 'Learn，记录待同步，8词'));
  expect(state.navigate).toHaveBeenCalledWith('/learning?section=tasks');
  expect(text(tree)).toContain('2 条记录等待同步');
  expect(post).not.toHaveBeenCalled();
});
it('routes resume, review-first, wait and complete states without manufacturing empty groups', () => {
  expect(homeEntryDestination(homeEntry('resume', 1, 'saved/task'), 'review')).toBe(
    '/review?session=saved%2Ftask',
  );
  expect(homeEntryDestination(homeEntry('other_task', 1, 'active'), 'learn')).toBe(
    '/learn?session=active',
  );
  expect(homeEntryDestination(homeEntry('review_first', 0), 'learn')).toBe('/review?start=1');
  for (const phase of ['waiting', 'empty'] as const)
    expect(homeEntryDestination(homeEntry(phase), 'learn')).toBe('/learning?section=tasks');
  expect(homeEntryDestination(homeEntry('complete'), 'learn')).toBe('/learning?section=results');
  expect(homeEntryDestination(homeEntry('setup'), 'learn')).toBe('/books');
});
it('displays check-in only from the completed-group calendar, independent of legacy duration statistics', () => {
  const summary = homeSummary();
  summary.checkedIn = true;
  state.remote['app/home'] = summary;
  state.remote.stats = { today: { checkedIn: false } };
  const tree = render(HomePage);
  click(find(tree, (node) => node.props['aria-label'] === '今日已签到，查看学习日历'));
  expect(text(tree)).toContain('已签到');
  expect(state.navigate).toHaveBeenCalledWith('/learning?section=calendar');
  const calendar = render(() =>
    LearningCalendar({
      calendar: summary.calendar,
      localDate: summary.localDate,
      timeZone: summary.timeZone,
    }),
  );
  expect(text(calendar)).toContain('还没有完成的学习组');
  expect(text(calendar)).toContain('完成当天一组学习，自动签到');
  expect(text(calendar)).not.toContain('5分钟');
});
it('keeps learning and preferences in one URL-backed segmented module', () => {
  const tree = render(H5LearningPage);
  click(find(tree, (node) => node.type === 'button' && text(node) === '学习偏好'));
  expect(state.params.get('section')).toBe('preferences');
  const preferences = render(H5LearningPage);
  expect(all(preferences).some((node) => node.type === PreferencesSettings)).toBe(true);
  expect(text(preferences)).not.toContain('签到日历');
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
it('settles an in-flight note save while retained offscreen and releases its busy state', async () => {
  state.params = new URLSearchParams('wordId=word-rain');
  let tree = render(NotesPage);
  (
    find(tree, (node) => node.type === 'input' && node.props.maxLength === 120).props.onChange as (
      event: unknown,
    ) => void
  )({ target: { value: 'Hidden save' } });
  (find(tree, (node) => node.type === 'textarea').props.onChange as (event: unknown) => void)({
    target: { value: 'A saved thought.' },
  });
  let resolve!: (value: unknown) => void;
  vi.mocked(post).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  tree = render(NotesPage);
  (
    find(tree, (node) => node.type === 'form' && node.props.className === 'form-stack').props
      .onSubmit as (event: unknown) => void
  )({ preventDefault() {} });
  state.active = false;
  render(NotesPage);
  resolve({});
  await settle();
  state.active = true;
  tree = render(NotesPage);
  expect(text(tree)).toContain('笔记已保存');
  expect(
    find(tree, (node) => node.type === 'button' && text(node).includes('写笔记')).props.disabled,
  ).toBe(false);
  expect(post).toHaveBeenCalledTimes(1);
});
it('disables hidden infinite observers and stops manual pagination from retained library controls', () => {
  state.active = false;
  for (const page of [LearningLibraryPage, NotesPage, SentencesPage, AcademyPage]) {
    state.slots = [];
    state.refs = [];
    state.infiniteOptions = [];
    const tree = render(page);
    expect(state.infiniteOptions.length).toBeGreaterThan(0);
    expect(state.infiniteOptions.every((option) => option.enabled === false)).toBe(true);
    const more = all(tree).find((node) => node.type === 'button' && text(node) === '加载更多');
    if (more) click(more);
  }
  expect(state.fetchNextPage).not.toHaveBeenCalled();
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
it('keeps a late academy start in its retained screen without navigating over another module', async () => {
  state.params = new URLSearchParams('lesson=lesson-one');
  state.remote['academy/lesson-one'] = { lesson: attempt.lesson };
  let resolve!: (value: unknown) => void;
  vi.mocked(post).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  let tree = render(AcademyPage);
  click(find(tree, (node) => node.type === 'button' && text(node).includes('开始听力练习')));
  state.active = false;
  render(AcademyPage);
  resolve({ attempt });
  await settle();
  expect(state.params.get('attempt')).toBeNull();
  expect(
    state.client!.getQueryData([state.scope, 'academy-attempt', `academy/attempts/${attempt.id}`]),
  ).toEqual({ attempt });
  state.active = true;
  tree = render(AcademyPage);
  expect(text(tree)).toContain('提交本组答案');
  expect(post).toHaveBeenCalledTimes(1);
});
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

it('does not reopen cached old task entries while the Home snapshot is refreshing', () => {
  const summary = homeSummary();
  summary.learn = homeEntry('resume', 6, 'ended-old-book');
  state.remote['app/home'] = summary;
  state.fetching = true;
  const tree = render(HomePage);
  const learn = find(
    tree,
    (node) => node.type === 'button' && String(node.props['aria-label']).startsWith('Learn，'),
  );
  expect(learn.props.disabled).toBe(true);
  expect(learn.props['aria-busy']).toBe(true);
  expect(text(learn)).toContain('正在更新');
  // Exercise the handler too: a retained element cannot navigate even if invoked directly.
  click(learn);
  expect(state.navigate).not.toHaveBeenCalled();
});

it('labels a resumed Home number as the current group, separate from unassigned new-word quota', () => {
  const summary = homeSummary();
  summary.learn = homeEntry('resume', 6, 'current-task');
  summary.plan.newRemaining = 21;
  state.remote['app/home'] = summary;
  const tree = render(HomePage);
  const learn = find(
    tree,
    (node) => node.type === 'button' && String(node.props['aria-label']).startsWith('Learn，'),
  );
  expect(text(learn)).toContain('继续本组 6 词');
  expect(text(learn)).not.toContain('21');
});

it('does not mix old-book Home state into the new-book task dashboard and explains retained conflicts', () => {
  const oldHome = homeSummary();
  oldHome.dailyGoalComplete = true;
  state.remote['app/home'] = oldHome;
  state.plan = {
    plan: {
      ...oldHome.plan,
      bookId: 'book-after-switch',
      revision: 9,
      localDate: oldHome.localDate,
    },
    settings: {},
  };
  state.slots[0] = true;
  state.pending = 1;
  state.conflicts = [{ id: 'old-command', code: 'task_cancelled' }];
  const tree = render(H5LearningPage);
  expect(text(tree)).not.toContain('今天的总目标已经完成');
  expect(text(tree)).toContain('原任务已在切书后结束');
  expect(text(tree)).toContain('未保存的本地操作需要逐条核对处理');
  expect(
    all(tree).some((node) => node.props.to === '/learn' && text(node).includes('处理旧任务')),
  ).toBe(true);
});
