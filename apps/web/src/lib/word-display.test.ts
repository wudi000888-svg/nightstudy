import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { englishParts, InteractiveEnglish } from '../components/InteractiveEnglish';
import { WordSaveButton, WordView } from '../components/UI';
import { WordCardContent, WordCardSummaryText } from '../components/WordCards';
import { WordCardContext } from './word-cards';
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
  return renderToStaticMarkup(h(WordCardContext.Provider, { value: cardActions }, element));
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

it('renders bilingual definitions and independent word examples with only English columns interactive', () => {
  const markup = render(h(WordView, { word }));
  expect(markup).toContain('中英释义对照');
  expect(markup).toContain('class="meaning-zh"');
  expect(markup).toContain('class="meaning-en"');
  expect(markup).toContain('class="example-en"');
  expect(markup).toContain('class="example-zh"');
  expect(markup).toContain('中文 water 释义');
  expect(markup).toContain('在 window 旁喝水。');
  expect(markup).not.toContain('查词 中文');
  expect(markup).not.toContain('查词 Café');
  const usageStart = markup.indexOf('aria-label="单词用法例句"');
  expect(usageStart).toBeGreaterThan(markup.indexOf('中英释义对照'));
  expect(markup.slice(usageStart)).toContain('河流运送水。');
  expect(markup.slice(0, usageStart)).not.toContain('河流运送水。');
  expect(markup).toContain('class="word-token"');
});

it('word-card content cannot trigger another card even within an active outer context', () => {
  const markup = render(h(WordCardContent, { word }));
  expect(markup).not.toContain('class="word-token"');
  expect(markup).not.toContain('aria-haspopup="dialog"');
  expect(markup).toContain('Water is a clear liquid. Café is unchanged.');
  expect(markup).toContain('Drink water beside the window.');
  expect(markup).toContain('The river carries water.');
  expect((markup.match(/class="audio-button pronunciation-speaker"/g) ?? []).length).toBe(2);
  expect(cardActions.openWord).not.toHaveBeenCalled();
});

it('keeps the plain bilingual summary on the same Chinese sense without exposing field metadata', () => {
  const chineseMetadata = { definitionZh: { kind: 'machine-translation', review: 'pending' } };
  const value: Word = {
    ...word,
    senses: [
      {
        id: 'english-only',
        definitionZh: '',
        definitionEn: 'English meaning.',
        contentMetadata: { definitionEn: { kind: 'machine-translation', review: 'pending' } },
      },
      { id: 'summary', definitionZh: '摘要 water 内容。', contentMetadata: chineseMetadata },
    ],
  };
  const markup = render(h(WordCardSummaryText, { word: value }));
  expect(markup).toContain('摘要 water 内容。');
  expect((markup.match(/class="content-status machine"/g) ?? []).length).toBe(0);
  expect((markup.match(/class="content-status pending"/g) ?? []).length).toBe(0);
  expect(markup).not.toContain('word-token');
  expect(markup).not.toContain('English meaning.');
  expect(markup).not.toContain('暂无英文释义。');
  expect(markup).not.toContain('word-card-summary-en');
  const paired = render(
    h(WordCardSummaryText, {
      word: {
        ...value,
        senses: [
          value.senses![0]!,
          {
            ...value.senses![1]!,
            definitionEn: 'The paired English summary stays plain.',
            contentMetadata: {
              ...chineseMetadata,
              definitionEn: { kind: 'original-authoring', review: 'pending' },
            },
          },
        ],
      },
    }),
  );
  expect(paired).toContain('The paired English summary stays plain.');
  expect(paired).not.toContain('English meaning.');
  expect(paired).not.toContain('word-token');
  expect((paired.match(/class="content-status machine"/g) ?? []).length).toBe(0);
  expect((paired.match(/class="content-status authored"/g) ?? []).length).toBe(0);
  expect((paired.match(/class="content-status pending"/g) ?? []).length).toBe(0);
  const original = render(
    h(WordCardSummaryText, {
      word: {
        ...value,
        senses: [
          value.senses![0]!,
          {
            id: 'original',
            definitionZh: '原文',
            contentMetadata: { definitionEn: { kind: 'machine-translation', review: 'pending' } },
          },
        ],
      },
    }),
  );
  expect(original).not.toContain('content-status');
  const long = render(
    h(WordCardSummaryText, {
      word: {
        ...word,
        senses: [{ id: 'long', definitionZh: '真实中文', definitionEn: 'word '.repeat(50) }],
      },
    }),
  );
  expect(long).toContain(`${'word '.repeat(32)}…`);
  expect(long).not.toContain('word '.repeat(33));
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

it('renders actual single-language content without inventing a paired translation or empty cells', () => {
  const markup = render(
    h(WordView, {
      word: {
        ...word,
        senses: [
          {
            id: 'missing-zh',
            definitionZh: '',
            definitionEn: 'Actual definition',
            exampleEn: 'Actual sentence.',
          },
        ],
        examples: [{ id: 'partial', exampleEn: 'A real independent example.', exampleZh: '' }],
      },
    }),
  );
  expect(markup).not.toContain('暂无中文释义。');
  expect(markup).not.toContain('暂无中文译文。');
  expect(markup).not.toContain('word-example-empty');
  expect(markup).toContain('aria-label="英文例句"');
  expect(markup).toContain('Actual');
  expect(markup).toContain('independent');
  expect(markup).not.toContain('中英例句对照');
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

it('keeps the focused meaning expanded while preserving other complete meanings in closed details', () => {
  const value: Word = {
    ...word,
    senses: [
      { id: 'other', definitionZh: '其他释义', definitionEn: 'Other full definition.' },
      { id: 'focus', definitionZh: '当前重点释义', definitionEn: 'Focused full definition.' },
      { id: 'third', definitionZh: '第三释义', definitionEn: 'Third full definition.' },
    ],
  };
  const markup = render(h(WordView, { word: value, focusSenseId: 'focus' }));
  const firstCollapsed = markup.indexOf('<details class="sense sense-collapsed"');
  expect(markup.indexOf('当前重点释义')).toBeLessThan(firstCollapsed);
  expect((markup.match(/<details class="sense sense-collapsed"/g) ?? []).length).toBe(2);
  expect(markup).not.toMatch(/<details class="sense sense-collapsed"[^>]* open/);
  expect(markup).toContain('Other');
  expect(markup).toContain('Third');
  expect(render(h(WordView, { word: value, hideMeanings: true }))).not.toContain('sense-collapsed');
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
  const summary = render(h(WordCardSummaryText, { word: value }));
  expect(summary).not.toContain('原创翻译');
  expect(summary).not.toContain('机器翻译');
});

it('places independent bilingual examples directly after the focused meaning and before other meanings', () => {
  const value: Word = {
    ...word,
    senses: [
      { id: 'other', definitionZh: '后续义项', definitionEn: 'Another meaning.' },
      { id: 'focus', definitionZh: '重点义项', definitionEn: 'Focused meaning.' },
      { id: 'last', definitionZh: '最后义项', definitionEn: 'Last meaning.' },
    ],
  };
  const markup = render(h(WordView, { word: value, focusSenseId: 'focus' }));
  const focus = markup.indexOf('重点义项');
  const examples = markup.indexOf('aria-label="单词用法例句"');
  const collapsed = markup.indexOf('<details class="sense sense-collapsed"');
  expect(focus).toBeGreaterThan(0);
  expect(examples).toBeGreaterThan(focus);
  expect(collapsed).toBeGreaterThan(examples);
  expect(markup.indexOf('河流运送水。')).toBeLessThan(collapsed);
  expect(markup).not.toContain('word-example-empty');
  const cardMarkup = render(h(WordCardContent, { word: value }));
  expect(cardMarkup).not.toContain('word-token');
  expect(render(h(WordView, { word: value, hideMeanings: true }))).not.toContain('单词用法例句');
});

it('omits an empty example section while retaining actual sense examples', () => {
  const empty: Word = {
    ...word,
    senses: [
      { id: 'one', definitionZh: '第一义项', definitionEn: 'First meaning.' },
      { id: 'two', definitionZh: '第二义项', definitionEn: 'Second meaning.' },
    ],
    examples: [],
  };
  const markup = render(h(WordView, { word: empty }));
  expect(markup).not.toContain('word-example-empty');
  expect(markup).not.toContain('暂无中英对照例句。');
  const withSenseExample = render(
    h(WordView, {
      word: {
        ...empty,
        senses: [
          {
            ...empty.senses![0]!,
            exampleEn: 'A real sense sentence.',
            exampleZh: '义项例句译文。',
            exampleSource: {
              kind: 'original-demo',
              reference: 'test sense source',
              packId: null,
              license: 'MIT',
              sourceUrl: null,
              wordHasSiteEdits: false,
              siteEditVersion: null,
            },
          },
          empty.senses![1]!,
        ],
      },
    }),
  );
  expect(withSenseExample).toContain('义项例句译文。');
  expect(withSenseExample).not.toContain('例句来源 · test sense source · MIT');
  expect(withSenseExample).not.toContain('word-example-empty');
  expect(withSenseExample).not.toContain('单词用法例句');
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

it('keeps independent native English senses separate from a Chinese focus and prioritizes their own POS', () => {
  const value: Word = {
    ...word,
    senses: [
      { id: 'verb', pos: 'v.', definitionZh: '', definitionEn: 'To supply plants with liquid.' },
      { id: 'noun', pos: 'n.', definitionZh: '', definitionEn: 'A transparent natural liquid.' },
      { id: 'focus', pos: 'n.', definitionZh: '水；水域' },
      { id: 'other-chinese', pos: 'v.', definitionZh: '给植物浇水' },
      {
        id: 'non-native',
        pos: 'n.',
        definitionZh: '',
        definitionEn: 'A translated definition.',
        contentMetadata: { definitionEn: { kind: 'machine-translation', sourceLanguage: 'zh' } },
      },
    ],
  };
  const markup = render(h(WordView, { word: value, focusSenseId: 'focus' }));
  const section = markup.indexOf('aria-label="英文解释"');
  const exampleSection = markup.indexOf('aria-label="单词用法例句"');
  const native = markup.slice(section, exampleSection);
  expect(section).toBeGreaterThan(markup.indexOf('水；水域'));
  expect(native.indexOf('transparent')).toBeLessThan(native.indexOf('supply'));
  expect(native).toContain('<span class="sense-pos">n.</span>');
  expect(native).toContain('<span class="sense-pos">v.</span>');
  expect(native).not.toContain('中英释义对照');
  expect(native).not.toContain('translated');
  expect(markup).not.toContain('暂无英文释义');
  expect(render(h(WordCardContent, { word: value }))).not.toContain('word-token');
  const hidden = render(h(WordView, { word: value, hideMeanings: true }));
  expect(hidden).not.toContain('英文解释');
  expect(hidden).not.toContain('transparent');
  expect(hidden).not.toContain('水；水域');
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

it('uses a filled saved star with an accessible remove action and no extra visible bookmark text', () => {
  const markup = render(h(WordSaveButton, { lemma: 'water', saved: true, onClick: () => {} }));
  expect(markup).toContain('aria-label="从生词本移除 water"');
  expect(markup).toContain('aria-pressed="true"');
  expect(markup).toContain('fill="currentColor"');
  expect(markup).not.toContain('已在生词本');
  expect(markup).not.toContain('加入生词本');
  expect(markup).not.toContain('>移除<');
});
