import { createHash } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import {
  adminWordEditorUrl,
  adminWordPatch,
  adminWordTarget,
  loadAdminWord,
} from './admin-word-editor';
import { api } from './api';
import type { Word } from './types';

vi.hoisted(() => vi.stubGlobal('window', { __NIGHTSTUDY_CONFIG__: {} }));
vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return { ...actual, api: vi.fn() };
});
const word: Word = {
  id: 'editor-test-word',
  lemma: 'water',
  status: 'draft',
  contentVersion: 'editor-original-v1',
  senses: [
    { id: 'first-paired', pos: 'n.', definitionZh: '水', definitionEn: 'A clear liquid.' },
    { id: 'second-only-zh', pos: 'v.', definitionZh: '浇水', definitionEn: '' },
    { id: 'third-only-en', pos: 'n.', definitionZh: '', definitionEn: 'An area of a lake or sea.' },
    { id: 'fourth-only-zh', pos: 'n.', definitionZh: '  水域\n近海  ', definitionEn: '' },
  ],
};
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
beforeEach(() => {
  vi.mocked(api).mockReset();
  vi.mocked(api).mockResolvedValue({ word });
});

it('loads full raw detail and selects the exact nonfirst sense rather than the summary or first Chinese sense', async () => {
  const signal = new AbortController().signal;
  const result = await loadAdminWord({ wordId: word.id, senseId: 'fourth-only-zh' }, signal);
  expect(api).toHaveBeenCalledExactlyOnceWith(`admin/words/${word.id}`, { signal });
  expect(result.word.senses).toHaveLength(4);
  expect(result.sense?.id).toBe('fourth-only-zh');
  expect(result.sense).not.toBe(word.senses![3]);
  expect(result.sense?.definitionEn).toBe('');
  expect(result.sourceStatus).toBe('unbound');
});

it('does not fall back to the first sense when the candidate sense is not owned by this word', async () => {
  const result = await loadAdminWord({ wordId: word.id, senseId: 'another-word-sense' });
  expect(result.word.id).toBe(word.id);
  expect(result.sense).toBeNull();
  expect(() =>
    adminWordPatch(word, { id: 'another-word-sense', definitionZh: '不属于这个词' }),
  ).toThrow('选择属于该词');
});

it('checks the candidate hash against exact UTF-8 raw source, preserving whitespace and rejecting changed source', async () => {
  const target = {
    wordId: word.id,
    senseId: 'fourth-only-zh',
    sourceField: 'definitionZh' as const,
    sourceHash: sha('  水域\n近海  '),
  };
  expect((await loadAdminWord(target)).sourceStatus).toBe('matched');
  expect((await loadAdminWord({ ...target, sourceHash: sha('水域\n近海') })).sourceStatus).toBe(
    'changed',
  );
  vi.mocked(api).mockResolvedValue({
    word: {
      ...word,
      senses: word.senses!.map((sense) =>
        sense.id === target.senseId ? { ...sense, definitionZh: '新的原义' } : sense,
      ),
    },
  });
  expect((await loadAdminWord(target)).sourceStatus).toBe('changed');
  expect((await loadAdminWord({ ...target, sourceHash: 'invalid' })).sourceStatus).toBe(
    'unverifiable',
  );
});

it('supports English-only senses while retaining draft status and the fresh expected content version', () => {
  const body = adminWordPatch(word, {
    ...word.senses![2]!,
    definitionEn: 'An expanse of sea or lake.',
  });
  expect(body).toEqual({
    status: 'draft',
    expectedContentVersion: 'editor-original-v1',
    senseId: 'third-only-en',
    definitionZh: '',
    definitionEn: 'An expanse of sea or lake.',
    exampleEn: '',
    exampleZh: '',
  });
  expect(word.senses![0]!.definitionEn).toBe('A clear liquid.');
  expect(adminWordPatch({ ...word, status: 'archived' }, word.senses![1]!).status).toBe('archived');
  expect(() =>
    adminWordPatch(word, { ...word.senses![1]!, definitionZh: '', definitionEn: '' }),
  ).toThrow('至少保留一项');
});

it('requires a complete detail version and correct canonical word identity before editing', async () => {
  vi.mocked(api).mockResolvedValue({ word: { ...word, contentVersion: undefined } });
  await expect(loadAdminWord({ wordId: word.id })).rejects.toThrow('完整原始词条');
  vi.mocked(api).mockResolvedValue({ word: { ...word, id: 'other-word' } });
  await expect(loadAdminWord({ wordId: word.id })).rejects.toThrow('完整原始词条');
});

it('round-trips exact candidate navigation without putting generated values into the editor URL', () => {
  const target = {
    wordId: 'word/a+b',
    senseId: 'sense/a+b',
    sourceField: 'definitionZh' as const,
    sourceHash: sha('原义'),
  };
  const url = adminWordEditorUrl(target);
  expect(url).toContain('/admin/words?wordId=word%2Fa%2Bb');
  expect(adminWordTarget(url.slice(url.indexOf('?')))).toEqual(target);
  expect(url).not.toContain('原义');
  expect(adminWordTarget('')).toBeNull();
});
