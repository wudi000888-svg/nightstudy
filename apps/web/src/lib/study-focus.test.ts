import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { StudySessionView, type StudySessionViewProps } from '../components/study/StudySessionView';
import { studyExamples } from '../components/study/StudyWordDetails';
import { WordView } from '../components/UI';
import { WordCardContent } from '../components/WordCards';
import { WordCardContext } from './word-cards';
import type { StudySession, Word } from './types';

vi.hoisted(() => vi.stubGlobal('window', { __NIGHTSTUDY_CONFIG__: {} }));
vi.mock('../AppContext', () => ({
  useApp: () => ({ user: { id: 'study-ui-user' }, scope: 'study-ui:user' }),
  useRemote: (key: string) => ({
    data: key === 'wordbook-entry' ? { item: null } : undefined,
    isFetching: false,
    error: null,
  }),
}));

const word: Word = {
  id: 'study-ui-water',
  lemma: 'water',
  phoneticUs: 'ˈwɔtɚ',
  phoneticUk: 'ˈwɔːtə',
  senses: [
    {
      id: 'water-noun',
      pos: 'n.',
      definitionZh: '保密名词水义',
      definitionEn: 'A clear liquid for drinking.',
      exampleEn: 'She poured water into a cup.',
      exampleZh: '她把水倒进杯子里。',
    },
    {
      id: 'water-verb',
      pos: 'v.',
      definitionZh: '保密动词浇水义',
      definitionEn: 'To give a plant water.',
      exampleEn: 'We water the plants every morning.',
      exampleZh: '我们每天早上给植物浇水。',
    },
  ],
  examples: [
    { id: 'word-usage', exampleEn: 'Cold water filled the basin.', exampleZh: '冷水装满了盆。' },
  ],
  collocations: [
    {
      id: 'cold-water',
      lemma: 'cold water',
      definitionZh: '冷水',
      definitionEn: 'Water at a low temperature.',
      pos: 'n.',
      wordId: 'study-ui-cold-water',
    },
  ],
};
const session: StudySession = {
  id: 'study-ui-session',
  bookId: 'study-ui-book',
  bookTitle: '我的学习词书',
  mode: 'daily',
  phase: 'recall',
  status: 'in_progress',
  revision: 0,
  cursor: 0,
  step: 'recall',
  currentItemId: 'study-ui-item',
  planId: 'study-ui-plan',
  taskKind: 'daily',
  pausedAt: null,
  deferredUntil: null,
  learningDate: '2026-10-15',
  timeZone: 'Asia/Shanghai',
  items: [
    {
      id: 'study-ui-item',
      wordId: word.id,
      ordinal: 0,
      word,
      progressRevision: 0,
      revealed: false,
      rated: false,
      exerciseDone: false,
      status: 'pending',
      bucket: 'new',
      focusSenseId: 'water-verb',
    },
  ],
};
const actions = {
  onAnswer: vi.fn(),
  onAct: vi.fn(),
  onState: vi.fn(),
  onRead: vi.fn(),
  onBack: vi.fn(),
  onNext: vi.fn(),
  onFeedbackDone: vi.fn(),
};
function render(element: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    return renderToStaticMarkup(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(
          MemoryRouter,
          null,
          React.createElement(
            WordCardContext.Provider,
            { value: { openWord: vi.fn(), leaveWord: vi.fn() } },
            element,
          ),
        ),
      ),
    );
  } finally {
    client.clear();
  }
}
function view(patch: Partial<StudySessionViewProps> = {}) {
  return render(
    React.createElement(StudySessionView, {
      session,
      busy: false,
      waitingSync: false,
      answer: '',
      ...actions,
      ...patch,
    }),
  );
}
beforeAll(() => {
  vi.stubGlobal('React', React);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockRejectedValue(new Error('unexpected study component network')),
  );
});
afterAll(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  for (const action of Object.values(actions)) expect(action).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

it('shows a focused recall surface without leaking any enriched meanings, examples or collocations before reveal', () => {
  const markup = view();
  expect(markup).toContain('aria-label="专注学习"');
  expect(markup).toContain('看答案');
  expect(markup).toContain('water');
  for (const secret of [
    '保密名词水义',
    '保密动词浇水义',
    'clear liquid',
    'Cold water',
    'cold water',
    '语境',
    'study-rating-actions',
  ])
    expect(markup).not.toContain(secret);
  expect((markup.match(/class="audio-button pronunciation-speaker"/g) ?? []).length).toBe(2);
  expect(markup).not.toContain('给今天');
});

it('keeps the server focus sense first, two thumb actions and the two precise ratings in the tools menu', () => {
  const revealed = { ...session, items: [{ ...session.items[0]!, revealed: true }] };
  const markup = view({ session: revealed });
  expect(markup).toContain('保密动词浇水义');
  expect(markup).not.toContain('保密名词水义');
  expect(markup).toContain('To');
  expect(markup).toContain('下一义项');
  expect(markup).toContain('本义项例句');
  expect(markup).toContain('下一条例句');
  for (const rating of ['again', 'hard', 'good', 'easy'])
    expect(markup).toContain(`class="study-rating-${rating}"`);
  expect(markup).toContain('记错了，安排巩固');
  expect(markup).toContain('记住了，下一词');
  expect(markup).toContain('study-rating-primary');
  const queued = view({ session: revealed, waitingSync: true });
  for (const rating of ['again', 'hard', 'good', 'easy'])
    expect(queued).toMatch(new RegExp(`class="study-rating-${rating}"[^>]*disabled`));
});

it('binds the thumb submit button to the real spelling form and never renders answer-bearing word content', () => {
  const spelling: StudySession = {
    ...session,
    phase: 'practice',
    items: [
      {
        ...session.items[0]!,
        revealed: true,
        rated: true,
        question: { id: 'study-spelling', type: 'spelling', prompt: '根据这个意思写出单词：水' },
      },
    ],
  };
  const markup = view({ session: spelling, answer: 'wat' });
  const form = markup.match(/<form id="([^"]+)"/);
  expect(form).not.toBeNull();
  expect(markup).toContain(`form="${form![1]}"`);
  expect(markup).toContain('type="submit"');
  expect(markup).toContain('value="wat"');
  expect(markup).toContain('enterKeyHint="done"');
  expect(markup).not.toContain('word-title');
  expect(markup).not.toContain('clear liquid');
  expect(markup).not.toContain('pronunciation-speaker');
});

it('uses only the selected sense example and real word-level usage without inventing a sense alignment', () => {
  const examples = studyExamples(word, word.senses![1]);
  expect(examples.map((row) => row.english)).toEqual([
    'We water the plants every morning.',
    'Cold water filled the basin.',
  ]);
  expect(examples.map((row) => row.origin)).toEqual(['sense', 'word']);
  expect(examples.map((row) => row.sourceId)).toEqual(['water-verb', 'word-usage']);
  expect(examples.map((row) => row.id)).not.toContain('sense:water-noun');
  expect(
    studyExamples(
      {
        ...word,
        examples: [
          { id: 'same', exampleEn: examples[0]!.english, exampleZh: examples[0]!.chinese },
        ],
      },
      word.senses![1],
    ),
  ).toHaveLength(1);
});

it('describes a server-completed group with spelling disabled without inventing spelling evidence', () => {
  const completed: StudySession = {
    ...session,
    phase: 'completed',
    status: 'completed',
    spellingEnabled: false,
    currentItemId: null,
    items: [{ ...session.items[0]!, rated: true, revealed: true, exerciseDone: false }],
  };
  const markup = view({ session: completed });
  expect(markup).toContain('本组未安排拼写');
  expect(markup).not.toContain('次拼写');
  expect(markup).not.toContain('你的拼写');
  expect(markup).toContain('继续今日任务');
});

it('keeps unrelated English definitions independent and preserves completely plain floating-card contents', () => {
  const value: Word = {
    ...word,
    senses: [
      { id: 'zh-only', pos: 'n.', definitionZh: '独立中文义' },
      {
        id: 'en-only',
        pos: 'v.',
        definitionZh: '',
        definitionEn: 'Independent English explanation.',
      },
    ],
  };
  const markup = render(React.createElement(WordView, { word: value, presentation: 'study' }));
  expect(markup).toContain('这个词的独立英文解释');
  expect(markup).toContain('v.');
  expect(markup).not.toContain('中英释义对照');
  const card = render(React.createElement(WordCardContent, { word }));
  expect(card).not.toContain('word-token');
  expect(card).not.toContain('aria-haspopup="dialog"');
  expect(card).toContain('She poured water into a cup.');
});

it('keeps spelling feedback on the real spelling count instead of the completed recall count', () => {
  const items = Array.from({ length: 3 }, (_, index) => ({
    ...session.items[0]!,
    id: `feedback-item-${index}`,
    ordinal: index,
    revealed: true,
    rated: true,
    exerciseDone: index === 0,
  }));
  const first = view({
    session: { ...session, phase: 'practice', cursor: 1, items, currentItemId: items[1]!.id },
    feedback: { correct: true, correctAnswer: 'water', explanation: '', position: 1 },
  });
  expect(first).toMatch(/aria-label="本组拼写进度"[^>]*aria-valuemax="3"[^>]*aria-valuenow="1"/);
  expect(first).toContain('width:33.33333333333333%');
  expect(first).not.toContain('本组回忆评价进度');
  expect(first).not.toContain('你的拼写');
  const last = view({
    session: {
      ...session,
      phase: 'completed',
      status: 'completed',
      items: items.map((item) => ({ ...item, exerciseDone: true })),
      currentItemId: null,
    },
    feedback: { correct: true, correctAnswer: 'water', explanation: '', position: 3 },
  });
  expect(last).toMatch(/aria-label="本组拼写进度"[^>]*aria-valuemax="3"[^>]*aria-valuenow="3"/);
});
