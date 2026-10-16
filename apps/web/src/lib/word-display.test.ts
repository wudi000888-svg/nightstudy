import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { englishParts, InteractiveEnglish } from '../components/InteractiveEnglish';
import { WordSaveButton, WordView } from '../components/UI';
import { WordCardContent } from '../components/WordCards';
import { WordCardContext } from './word-cards';
import { definitionPreview } from '../components/BilingualDefinition';
import type { Word } from './types';

vi.hoisted(() => {
  vi.stubGlobal('window', { __NIGHTSTUDY_CONFIG__: {} });
});
vi.mock('../AppContext', () => ({
  useApp: () => ({ user: null, scope: 'component-test:guest' }),
  useRemote: () => ({ data: undefined, error: null, isFetching: false }),
}));
const cardActions = { openWord: vi.fn(), leaveWord: vi.fn() };
const h = React.createElement;
const word: Word = {
  id: 'component-test-word',
  lemma: 'water',
  phoneticUs: '/test-us/',
  phoneticUk: '/test-uk/',
  senses: [
    {
      id: 'sense-1',
      pos: 'n.',
      definitionZh: '中文 water 释义',
      definitionEn: 'Water is a clear liquid. Café is unchanged.',
      exampleEn: 'Drink water beside the window.',
      exampleZh: '在 window 旁喝水。',
      examples: [
        {
          id: 'sense-example-1',
          learningSenseId: 'sense-1',
          contextLabel: '饮水',
          exampleEn: 'Drink water beside the window.',
          exampleZh: '在 window 旁喝水。',
        },
      ],
    },
  ],
  examples: [
    {
      id: 'usage-1',
      exampleEn: 'The river carries water.',
      exampleZh: '河流运送水。',
    },
  ],
};
function render(element: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    return renderToStaticMarkup(
      h(
        QueryClientProvider,
        { client },
        h(MemoryRouter, null, h(WordCardContext.Provider, { value: cardActions }, element)),
      ),
    );
  } finally {
    client.clear();
  }
}
beforeAll(() => {
  // The Node-only suite renders markup; it never mounts browser effects or fetches.
  vi.stubGlobal('React', React);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unexpected component network')));
});
afterAll(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

it('accepts complete ASCII English words without slicing accented or mixed words', () => {
  const text =
    "Don't forget well-known words. café naïve Cafe\u0301 ﬂow rain123 水rain under_score don’t rain‐water.";
  const parts = englishParts(text);
  expect(parts.filter((part) => part.word).map((part) => part.text)).toEqual([
    "Don't",
    'forget',
    'well-known',
    'words',
    'don’t',
  ]);
  expect(parts.map((part) => part.text).join('')).toBe(text);
  for (const part of parts)
    expect(text.slice(part.offset, part.offset + part.text.length)).toBe(part.text);
});

it('renders only English word buttons while preserving punctuation and non-English text', () => {
  const markup = render(
    h(InteractiveEnglish, { text: "Café, naïve — don't forget well-known words." }),
  );
  expect((markup.match(/class="word-token"/g) ?? []).length).toBe(4);
  expect(markup).toContain('aria-label="查词 don&#x27;t"');
  expect(markup).toContain('aria-label="查词 well-known"');
  expect(markup).not.toContain('查词 Caf');
  expect(markup).not.toContain('查词 naïve');
  expect(markup).toContain('Café');
  expect(markup).toContain('aria-haspopup="dialog"');
});

it('accepts English curly apostrophes intact without admitting accented words or Unicode hyphens', () => {
  const text = 'we’re don’t teacher’s café naïve Cafe\u0301 rain123 rain‐water rain‑water';
  expect(
    englishParts(text)
      .filter((part) => part.word)
      .map((part) => part.text),
  ).toEqual(['we’re', 'don’t', 'teacher’s']);
  const markup = render(h(InteractiveEnglish, { text }));
  expect((markup.match(/class="word-token"/g) ?? []).length).toBe(3);
  for (const token of ['we’re', 'don’t', 'teacher’s']) {
    expect(markup).toContain(`aria-label="查词 ${token}"`);
    expect(markup).toContain(`>${token}</button>`);
  }
  expect(markup).not.toContain('查词 Caf');
  expect(markup).not.toContain('查词 rain');
});

it('keeps text plain when interaction is explicitly disabled or no card context exists', () => {
  expect(render(h(InteractiveEnglish, { text: 'Water & rain.', enabled: false }))).toBe(
    'Water &amp; rain.',
  );
  expect(renderToStaticMarkup(h(InteractiveEnglish, { text: 'Water & rain.' }))).toBe(
    'Water &amp; rain.',
  );
});

it('renders the selected bilingual meaning and only its own context with English interaction', () => {
  const markup = render(h(WordView, { word }));
  for (const text of [
    '中英释义对照',
    'class="meaning-zh"',
    'class="meaning-en"',
    'class="example-en"',
    'class="example-zh"',
    '中文 water 释义',
    '在 window 旁喝水。',
    '饮水',
  ])
    expect(markup).toContain(text);
  expect(markup).not.toContain('河流运送水。');
  expect(markup).not.toContain('查词 中文');
  expect(markup).not.toContain('查词 Café');
  expect(markup).toContain('class="word-token"');
});

it('word-card content cannot trigger another card even within an active outer context', () => {
  const markup = render(h(WordCardContent, { word }));
  expect(markup).not.toContain('class="word-token"');
  expect(markup).not.toContain('aria-haspopup="dialog"');
  expect(markup).toContain('Water is a clear liquid. Café is unchanged.');
  expect(markup).toContain('Drink water beside the window.');
  expect(markup).not.toContain('The river carries water.');
  expect((markup.match(/class="audio-button pronunciation-speaker"/g) ?? []).length).toBe(2);
  expect(cardActions.openWord).not.toHaveBeenCalled();
});

it('shows a real definition empty state even when the optional senses field is absent', () => {
  const value: Word = { id: 'no-senses', lemma: 'water', examples: [] };
  const markup = render(h(WordView, { word: value }));
  expect(markup).toContain('暂无释义。');
  expect(markup).not.toContain('word-example-empty');
  const hidden = render(h(WordView, { word: value, hideMeanings: true }));
  expect(hidden).not.toContain('释义');
  expect(hidden).not.toContain('word-example-empty');
});

it('retains a single-language definition without treating an unbound sentence as its context', () => {
  const markup = render(
    h(WordView, {
      word: {
        ...word,
        senses: [
          {
            id: 'missing-zh',
            definitionZh: '',
            definitionEn: 'Actual definition',
            exampleEn: 'Unreviewed sentence.',
          },
        ],
        examples: [{ id: 'partial', exampleEn: 'A real independent example.', exampleZh: '' }],
      },
    }),
  );
  expect(markup).toContain('Actual');
  expect(markup).toContain('本义项暂无例句。');
  expect(markup).not.toContain('Unreviewed sentence');
  expect(markup).not.toContain('independent');
  expect(markup).not.toContain('中英释义对照');
});

it('keeps model and review metadata out of learning definitions without inventing missing text', () => {
  const markup = render(
    h(WordView, {
      word: {
        ...word,
        contentVersion: 'bilingual-v1',
        senses: [
          {
            ...word.senses![0]!,
            contentMetadata: {
              definitionEn: {
                kind: 'machine-translation',
                review: 'pending',
                model: 'test-model',
                license: 'test-license',
              },
              exampleZh: {
                kind: 'corpus',
                review: 'source',
                sourceUrl: 'https://example.test/actual-source',
              },
            },
          },
        ],
      },
    }),
  );
  expect((markup.match(/class="content-status machine"/g) ?? []).length).toBe(0);
  expect((markup.match(/class="content-status pending"/g) ?? []).length).toBe(0);
  expect(markup).not.toContain('机器翻译');
  expect(markup).not.toContain('模型 · test-model');
  expect(markup).not.toContain('生成例句');
  const original = render(h(WordView, { word: { ...word, contentVersion: 'bilingual-v1' } }));
  expect(original).not.toContain('class="content-status');
  const missing = render(
    h(WordView, {
      word: {
        ...word,
        senses: [
          {
            id: 'missing',
            definitionZh: '原文',
            definitionEn: '',
            contentMetadata: { definitionEn: { kind: 'machine-translation', review: 'pending' } },
          },
        ],
        examples: [],
      },
    }),
  );
  expect(missing).not.toContain('class="content-status');
});

it('keeps actual word-level examples plain and hides their generation metadata', () => {
  const markup = render(
    h(WordCardContent, {
      word: {
        ...word,
        examples: [
          {
            ...word.examples![0]!,
            contentMetadata: {
              exampleEn: { kind: 'generated', review: 'pending', model: 'test-generation-model' },
              exampleZh: {
                kind: 'machine-translation',
                review: 'pending',
                sourceUrl: 'https://example.test/translation',
                license: 'test-license',
              },
            },
          },
        ],
      },
    }),
  );
  expect((markup.match(/class="content-status machine"/g) ?? []).length).toBe(0);
  expect((markup.match(/class="content-status pending"/g) ?? []).length).toBe(0);
  expect(markup).not.toContain('生成例句');
  expect(markup).not.toContain('机器翻译');
  expect(markup).not.toContain('例句来源');
  expect(markup).not.toContain('test-generation-model');
  expect(markup).not.toContain('class="word-token"');
});

it('selects the requested meaning while offering a compact directory for other meanings', () => {
  const value: Word = {
    ...word,
    senses: [
      { id: 'other', definitionZh: '其他释义', definitionEn: 'Other full definition.' },
      { id: 'focus', definitionZh: '当前重点释义', definitionEn: 'Focused full definition.' },
      { id: 'third', definitionZh: '第三释义', definitionEn: 'Third full definition.' },
    ],
  };
  const markup = render(h(WordView, { word: value, focusSenseId: 'focus' }));
  expect(markup).toContain('aria-label="选择词义"');
  expect(markup).toContain('aria-pressed="true"');
  expect(markup).toContain('Focused');
  expect(markup).not.toContain('Other full');
  expect(markup).not.toContain('Third full');
  expect(markup).toContain('第三释义');
  expect(render(h(WordView, { word: value, hideMeanings: true }))).not.toContain('选择词义');
});

it('keeps source quality notes outside learning while retaining actual meanings', () => {
  const value: Word = {
    ...word,
    lexicalWarnings: [
      { code: 'source-spelling-unverified', message: '原词 water 的来源用法尚未核验。' },
    ],
    examples: [],
  };
  const markup = render(h(WordView, { word: value }));
  const note = markup.slice(markup.indexOf('<aside'), markup.indexOf('</aside>'));
  expect(note).not.toContain('源词条待校对');
  expect(note).not.toContain('原词 water 的来源用法尚未核验。');
  expect(note).not.toContain('word-token');
  expect(markup).toContain('中文 water 释义');
  expect(markup).not.toContain('word-example-empty');
  expect(render(h(WordView, { word: value, hideMeanings: true }))).not.toContain('源词条待校对');
});

it('keeps attribution outside the word card without removing the learning text', () => {
  const markup = render(
    h(WordCardContent, {
      word: {
        ...word,
        senses: [
          {
            ...word.senses![0]!,
            contentMetadata: {
              definitionEn: {
                kind: 'machine-translation',
                review: 'pending',
                model: 'test-model',
                modelAuthor: 'Fixture model author',
                modelLicense: 'Apache-2.0',
                modelUrl: 'https://example.test/model',
              },
            },
          },
        ],
        examples: [
          {
            ...word.examples![0]!,
            contentMetadata: {
              exampleEn: {
                kind: 'corpus',
                review: 'source',
                originalAuthor: 'Fixture original author',
                author: 'Fixture translator',
                sourceSentenceId: 123,
              },
            },
          },
        ],
      },
    }),
  );
  expect(markup).not.toContain('模型作者 · Fixture model author');
  expect(markup).not.toContain('模型许可 · Apache-2.0');
  expect(markup).not.toContain('href="https://example.test/model"');
  expect(markup).not.toContain('原作者 · Fixture original author');
  expect(markup).not.toContain('作者 · Fixture translator');
  expect(markup).not.toContain('来源句编号 · 123');
  expect(markup).not.toMatch(/<details class="sense-sources"[^>]* open/);
  expect(markup).not.toContain('word-token');
});

it('keeps correction and historical model metadata out of the learning surface', () => {
  const correction = {
    kind: 'original-authoring',
    review: 'pending',
    author: 'NightStudy contributors',
    authoringMethod: 'Codex-assisted bilingual correction',
    license: 'MIT',
    correctionOf: {
      kind: 'machine-translation',
      model: 'Qwen historical model',
      outputSha256: 'historical-output-sha',
    },
  };
  const value: Word = {
    ...word,
    senses: [{ ...word.senses![0]!, contentMetadata: { definitionZh: correction } }],
    examples: [
      {
        ...word.examples![0]!,
        contentMetadata: {
          exampleEn: {
            kind: 'corpus',
            review: 'source',
            author: 'Fixture original author',
            sourceSentenceId: 123,
            sourceUrl: 'https://example.test/123',
            license: 'CC-BY-2.0-FR',
          },
          exampleZh: {
            ...correction,
            author: 'Fixture original author',
            translationAuthor: 'NightStudy contributors',
            sourceSentenceId: 123,
            sourceUrl: 'https://example.test/123',
            license: 'CC-BY-2.0-FR',
          },
        },
      },
    ],
  };
  const markup = render(h(WordCardContent, { word: value }));
  expect((markup.match(/class="content-status authored"/g) ?? []).length).toBe(0);
  expect((markup.match(/class="content-status pending"/g) ?? []).length).toBe(0);
  expect(markup).not.toContain('原创翻译');
  expect(markup).not.toContain('译文作者 · NightStudy contributors');
  expect(markup).not.toContain('编写方式 · Codex-assisted bilingual correction');
  expect(markup).not.toContain('作者 · Fixture original author');
  expect(markup).not.toContain('来源句编号 · 123');
  expect(markup).not.toContain('CC-BY-2.0-FR');
  expect(markup).not.toContain('href="https://example.test/123"');
  expect(markup).not.toContain('Qwen historical model');
  expect(markup).not.toContain('historical-output-sha');
  expect(markup).not.toContain('机器翻译');
  expect(markup).not.toContain('word-token');
});

it('keeps examples inside the selected meaning instead of sharing word-level candidates', () => {
  const value: Word = {
    ...word,
    senses: [
      { id: 'other', definitionZh: '后续义项', definitionEn: 'Another meaning.' },
      {
        id: 'focus',
        definitionZh: '重点义项',
        definitionEn: 'Focused meaning.',
        examples: [
          {
            id: 'bound',
            learningSenseId: 'focus',
            contextLabel: '真实场景',
            exampleEn: 'This is the focused example.',
            exampleZh: '这是重点义项例句。',
          },
        ],
      },
    ],
  };
  const markup = render(h(WordView, { word: value, focusSenseId: 'focus' }));
  expect(markup).toContain('这是重点义项例句。');
  expect(markup).toContain('真实场景');
  expect(markup).not.toContain('河流运送水。');
  expect(markup).not.toContain('Another');
  expect(render(h(WordView, { word: value, hideMeanings: true }))).not.toContain('例句');
});

it('states a meaning-specific gap until a bilingual example is actually bound', () => {
  const empty: Word = {
    ...word,
    senses: [{ id: 'one', definitionZh: '第一义项', definitionEn: 'First meaning.' }],
    examples: word.examples,
  };
  expect(render(h(WordView, { word: empty }))).toContain('本义项暂无例句。');
  const prepared = render(
    h(WordView, {
      word: {
        ...empty,
        senses: [
          {
            ...empty.senses![0]!,
            examples: [
              {
                id: 'prepared',
                learningSenseId: 'one',
                exampleEn: 'A real sense sentence.',
                exampleZh: '义项例句译文。',
              },
            ],
          },
        ],
      },
    }),
  );
  expect(prepared).toContain('义项例句译文。');
  expect(prepared).not.toContain('本义项暂无例句。');
  expect(prepared).not.toContain('河流运送水。');
});

it('keeps all meanings, examples and provenance hidden until the study reveal', () => {
  const markup = render(
    h(WordView, {
      word: {
        ...word,
        contentView: { snapshotVersion: 'old', currentVersion: 'new', supplemented: true },
      },
      hideMeanings: true,
    }),
  );
  for (const hidden of [
    '中文 water 释义',
    'clear liquid',
    'Drink',
    '河流运送水',
    '中英对照',
    '单词用法例句',
    '旧任务内容已补全',
  ])
    expect(markup).not.toContain(hidden);
  expect(markup).toContain('water');
});

it('keeps independent dictionary meanings selectable without pairing them by shared POS', () => {
  const value: Word = {
    ...word,
    senses: [
      { id: 'focus', pos: 'n.', definitionZh: '水；水域' },
      { id: 'native', pos: 'n.', definitionZh: '', definitionEn: 'An independent explanation.' },
    ],
  };
  const markup = render(h(WordView, { word: value, focusSenseId: 'focus' }));
  const body = markup.slice(markup.indexOf('class="study-meaning-copy"'));
  expect(body).toContain('水；水域');
  expect(body).not.toContain('independent');
  expect(body).not.toContain('中英释义对照');
  const selected = render(h(WordView, { word: value, focusSenseId: 'native', interactive: false }));
  expect(selected).toContain('An independent explanation.');
  expect(selected).not.toContain('中英释义对照');
});

it('keeps complete long bilingual meanings behind a readable preview and preserves sentence context', () => {
  const english = 'A complete explanation with several useful meanings and examples. '
    .repeat(12)
    .trim();
  const value: Word = {
    ...word,
    senses: [
      {
        id: 'long',
        pos: 'n.',
        definitionZh: '雨；降雨',
        definitionEn: english,
        exampleEn: 'The rain has stopped.',
        exampleZh: '雨已经停了。',
        examples: [
          {
            id: 'rain-stopped',
            learningSenseId: 'long',
            exampleEn: 'The rain has stopped.',
            exampleZh: '雨已经停了。',
          },
        ],
      },
    ],
    examples: [],
  };
  const markup = render(h(WordCardContent, { word: value }));
  expect(markup).toContain('aria-label="中英释义对照"');
  expect(markup).toContain('<details class="definition-disclosure">');
  expect(markup).not.toContain('<details class="definition-disclosure" open');
  expect(markup).toContain(english);
  expect(markup).toContain('展开完整英文释义');
  expect(markup).toContain('The rain has stopped.');
  expect(markup).toContain('雨已经停了。');
  expect(markup).not.toContain('word-token');
  expect(Array.from(definitionPreview(english, 'en')).length).toBeLessThanOrEqual(181);
  expect(definitionPreview('雨'.repeat(200), 'zh-CN')).toBe('雨'.repeat(72) + '…');
});

it('opens the current bilingual context in study without importing another meaning', () => {
  const value: Word = {
    ...word,
    senses: [
      {
        id: 'focus',
        pos: 'n.',
        definitionZh: '水；水域',
        examples: [
          {
            id: 'own',
            learningSenseId: 'focus',
            exampleEn: 'The river carries water.',
            exampleZh: '河流运送水。',
          },
        ],
      },
      {
        id: 'native',
        pos: 'n.',
        definitionZh: '',
        definitionEn: 'An independent dictionary explanation.',
      },
    ],
  };
  const markup = render(h(WordView, { word: value, presentation: 'study', interactive: false }));
  expect(markup).toContain('<details class="study-context-card" open="">');
  expect(markup).toContain('The river carries water.');
  expect(markup).toContain('河流运送水。');
  expect(markup).not.toContain('independent dictionary');
  expect(markup).not.toContain('中英释义对照');
});

it('renders only real collocations and keeps them plain in cards and absent before reveal', () => {
  const value: Word = {
    ...word,
    collocations: [
      {
        id: 'phrase',
        lemma: 'running water',
        pos: 'n.',
        definitionZh: '流动的水',
        definitionEn: 'Water flowing through a pipe.',
        wordId: 'phrase-word',
      },
    ],
  };
  const body = render(h(WordView, { word: value }));
  expect(body).toContain('aria-label="词组搭配"');
  expect(body).toContain('查词 running');
  expect(body).toContain('流动的水');
  const card = render(h(WordCardContent, { word: value }));
  expect(card).toContain('running water');
  expect(card).toContain('Water flowing through a pipe.');
  expect(card).not.toContain('word-token');
  expect(render(h(WordView, { word: value, hideMeanings: true }))).not.toContain('词组搭配');
  expect(render(h(WordView, { word }))).not.toContain('常用搭配');
});

it('shows two real US and UK audio controls without per-word source or device panels', () => {
  const value: Word = {
    ...word,
    dictionaryName: 'ECDICT',
    audio: (['US', 'UK'] as const).map((accent) => ({
      id: `test-audio-${accent}`,
      accent,
      kind: 'synthesized',
      url: `/api/v2/pronunciation/${word.id}/audio/${accent}`,
      status: 'ready',
      sourceName: 'Fixture provider',
      sourceUrl: 'https://example.test/audio',
      license: 'Fixture license',
      attribution: 'Fixture attribution',
      mimeType: 'audio/wav',
    })),
  };
  const markup = render(h(WordView, { word: value }));
  expect((markup.match(/class="audio-button pronunciation-speaker"/g) ?? []).length).toBe(2);
  expect(markup).toContain('aria-label="播放 water 美式发音"');
  expect(markup).toContain('aria-label="播放 water 英式发音"');
  expect(markup).toContain('/test-us/');
  expect(markup).toContain('/test-uk/');
  expect(markup).toContain('ECDICT');
  for (const text of [
    'Fixture provider',
    'Fixture license',
    'Fixture attribution',
    '服务器合成',
    '设备备用',
  ])
    expect(markup).not.toContain(text);
  expect(markup).not.toMatch(/class="audio-button pronunciation-speaker"[^>]* disabled/);
});

it('uses a filled saved star with an immediate functional hover and keyboard hint', () => {
  const markup = render(h(WordSaveButton, { lemma: 'water', saved: true, onClick: () => {} }));
  expect(markup).toContain('aria-label="从生词本移除 water"');
  expect(markup).toContain('aria-pressed="true"');
  expect(markup).toContain('fill="currentColor"');
  expect(markup).not.toContain('已在生词本');
  expect(markup).not.toContain('加入生词本');
  expect(markup).toContain('class="icon-action-tooltip" role="tooltip">移出生词本');
  const unsaved = render(h(WordSaveButton, { lemma: 'water', saved: false, onClick: () => {} }));
  expect(unsaved).toContain('aria-label="加入生词本 water"');
  expect(unsaved).toContain('role="tooltip">加入生词本');
  const consolidated = render(
    h(WordSaveButton, { lemma: 'water', saved: true, consolidated: true, onClick: () => {} }),
  );
  expect(consolidated).toContain('aria-label="移除 water 已巩固收藏"');
  expect(consolidated).toContain('role="tooltip">移除已巩固收藏');
  expect(consolidated).toContain('aria-pressed="true"');
  expect(consolidated).not.toContain('加入生词本');
});

it('uses raw dictionary definitions only when no prepared learning meanings exist', () => {
  const value: Word = {
    ...word,
    dictionarySenses: [
      { id: 'raw', pos: 'v.', definitionZh: '', definitionEn: 'To supply plants with liquid.' },
    ],
  };
  expect(render(h(WordView, { word: value }))).not.toContain('supply');
  const raw = render(h(WordView, { word: { ...value, senses: [] }, interactive: false }));
  expect(raw).toContain('To supply plants with liquid.');
  expect(raw).toContain('本义项暂无例句。');
  expect(raw).not.toContain('在 window 旁喝水。');
});

it('offers raw dictionary explanations beside prepared meanings only in reading mode', () => {
  const value: Word = {
    ...word,
    senses: [{ ...word.senses![0]!, kind: 'learning' }],
    dictionarySenses: [
      {
        id: 'raw-other',
        pos: 'v.',
        definitionZh: '浇水',
        definitionEn: 'To supply plants with liquid.',
      },
    ],
  };
  expect(render(h(WordView, { word: value }))).toContain('更多词典释义');
  expect(render(h(WordCardContent, { word: value }))).toContain('更多词典释义');
  expect(render(h(WordView, { word: value, presentation: 'study' }))).not.toContain('更多词典释义');
  expect(render(h(WordView, { word: value, hideMeanings: true }))).not.toContain('更多词典释义');
  expect(render(h(WordView, { word: { ...value, senses: [] } }))).not.toContain('更多词典释义');
});

it('deduplicates bound bilingual examples without reintroducing duplicate word-level candidates', () => {
  const example = word.senses![0]!.examples![0]!;
  const value: Word = {
    ...word,
    senses: [{ ...word.senses![0]!, examples: [example, { ...example, id: 'same-pair' }] }],
    examples: [example, ...word.examples!],
  };
  const markup = render(h(WordView, { word: value }));
  expect(markup.split('在 window 旁喝水。').length - 1).toBe(1);
  expect(markup).not.toContain('河流运送水。');
});
