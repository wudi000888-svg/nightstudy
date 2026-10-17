import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Sense } from '@prisma/client';
import { selectWordLearningSense, type WordWithSenses } from './shared.js';
import type { AtomicLearningSense } from './learning-sense-view.js';
import { learningSenseBindingHash, learningSenseTextHash } from './learning-sense-integrity.js';
import {
  builtInDefaultBooks,
  isBuiltInDefaultBook,
  loadAcceptedReviewFocusIds,
} from './study-learning-focus.js';

const source = (id: string, zh: string): Sense => ({
  id,
  wordId: 'grammar',
  pos: 'n.',
  definitionZh: zh,
  definitionEn: 'Original synthetic ' + id,
  ordinal: 0,
  exampleEn: '',
  exampleZh: '',
  contentMetadata: {},
});
const legacy = source('grammar-old-source', '语法学；语法书');
const common = source('grammar-original-source', '语言结构规则体系');
function meaning(id: string, ordinal: number, raw: Sense): AtomicLearningSense {
  const binding = {
    id: id + '-binding',
    wordId: 'grammar',
    learningSenseId: id,
    sourceSenseId: raw.id,
    relation: 'narrower',
    sourcePosSha256: learningSenseTextHash(raw.pos),
    sourceDefinitionZhSha256: learningSenseTextHash(raw.definitionZh),
    sourceDefinitionEnSha256: learningSenseTextHash(raw.definitionEn),
    contentMetadata: {},
    sourceSense: raw,
  };
  const value = {
    id,
    wordId: 'grammar',
    pos: 'n.',
    definitionZh: raw.definitionZh,
    definitionEn: raw.definitionEn,
    ordinal,
    status: 'published',
    contentVersion: 'synthetic-reviewed',
    contentMetadata: {},
    bindingHash: '',
    sourceBindings: [binding],
    examples: [],
  };
  return { ...value, bindingHash: learningSenseBindingHash(value) };
}
function word(): WordWithSenses {
  return {
    id: 'grammar',
    lemma: 'grammar',
    normalizedLemma: 'grammar',
    phonetic: '',
    phoneticUs: '',
    phoneticUk: '',
    phoneticSource: '',
    goalTags: [],
    difficulty: 1,
    status: 'published',
    sourceRef: 'Original synthetic fixture',
    contentVersion: 'synthetic',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    senses: [legacy, common],
    learningSenses: [meaning('grammar-book', 1, legacy), meaning('grammar-rules', 0, common)],
  };
}

describe('reviewed first-meaning selection without rewriting explicit choices', () => {
  it('uses explicit ordinal/id order and skips legacy-source mapping only for a proven built-in default', () => {
    const value = word();
    expect(selectWordLearningSense(value)?.id).toBe('grammar-rules');
    expect(selectWordLearningSense(value, legacy.id)?.id).toBe('grammar-book');
    expect(selectWordLearningSense(value, legacy.id, { focusPolicy: 'built-in-default' })?.id).toBe(
      'grammar-rules',
    );
    expect(value.learningSenses?.map((sense) => sense.id)).toEqual([
      'grammar-book',
      'grammar-rules',
    ]);
    value.learningSenses = [meaning('z-meaning', 0, common), meaning('a-meaning', 0, common)];
    expect(selectWordLearningSense(value)?.id).toBe('a-meaning');
  });
  it('preserves exact reviewed atomic choices even in a built-in book', () => {
    expect(
      selectWordLearningSense(word(), 'grammar-book', { focusPolicy: 'built-in-default' })?.id,
    ).toBe('grammar-book');
  });
  it('does not revive held or drifted meaning evidence and keeps the dictionary fallback when no atomics exist', () => {
    const value = word();
    value.learningSenses![1]!.sourceBindings[0]!.sourceSense = {
      ...common,
      definitionZh: 'changed',
    };
    expect(selectWordLearningSense(value, null, { focusPolicy: 'built-in-default' })?.id).toBe(
      'grammar-book',
    );
    value.learningSenses![0]!.status = 'held';
    expect(selectWordLearningSense(value, legacy.id, { focusPolicy: 'built-in-default' })?.id).toBe(
      legacy.id,
    );
    expect(selectWordLearningSense(word(), 'no-longer-valid')?.id).toBe('grammar-rules');
  });
});

describe('exact built-in registration and bounded review lookup', () => {
  it('matches exactly the 18 books and complete pins in the actual immutable manifests', () => {
    const read = (name: string) =>
      JSON.parse(fs.readFileSync(new URL('../../../../data/' + name, import.meta.url), 'utf8'));
    const d = read('content-ecdict.manifest.json'),
      p = read('phrase-books.manifest.json'),
      e = read('exam-books.manifest.json');
    const pin = (pack: { id: string; version: string; sha256: string }) => ({
      packId: pack.id,
      packVersion: pack.version,
      packSha256: pack.sha256,
    });
    const expected = [
      ...Object.keys(d.statistics.bookCounts).map((goal) => {
        const id = 'content-' + d.id + '-' + goal;
        return { id, slug: id, kind: 'vocabulary', goal, version: d.id, ...pin(d) };
      }),
      ...Object.keys(p.bookCounts).map((slug) => ({
        id: 'content-' + p.id + '-' + slug,
        slug,
        goal: slug.split('-')[0],
        kind: 'phrases',
        version: p.version,
        ...pin(p),
      })),
      ...e.books.map((book: { id: string; goal: string; kind: string }) => {
        const id = 'content-' + e.id + '-' + book.id;
        return { id, slug: id, goal: book.goal, kind: book.kind, version: e.id, ...pin(e) };
      }),
    ].sort((a, b) => a.id.localeCompare(b.id));
    expect(builtInDefaultBooks).toHaveLength(18);
    expect([...builtInDefaultBooks].sort((a, b) => a.id.localeCompare(b.id))).toEqual(expected);
  });
  it('requires a complete public unimported book identity and the ready installed pack pin, without prefix guesses or lasting cache', async () => {
    const book = vi.fn().mockResolvedValue({ id: 'synthetic' });
    const pack = vi.fn().mockResolvedValue({ id: 'synthetic' });
    const db = {
      book: { findFirst: book },
      contentPack: { findFirst: pack },
    } as unknown as Parameters<typeof isBuiltInDefaultBook>[0];
    expect(await isBuiltInDefaultBook(db, 'content-exam-books-v1-similar')).toBe(false);
    expect(book).not.toHaveBeenCalled();
    const registered = builtInDefaultBooks[0]!;
    expect(await isBuiltInDefaultBook(db, registered.id)).toBe(true);
    const { packId, packVersion, packSha256, ...identity } = registered;
    expect(book).toHaveBeenLastCalledWith({
      where: { ...identity, ownerId: null, status: 'published', imports: { none: {} } },
      select: { id: true },
    });
    expect(pack).toHaveBeenLastCalledWith({
      where: { id: packId, version: packVersion, sha256: packSha256, status: 'ready' },
      select: { id: true },
    });
    pack.mockResolvedValueOnce(null);
    expect(await isBuiltInDefaultBook(db, registered.id)).toBe(false);
    book.mockResolvedValueOnce(null);
    expect(await isBuiltInDefaultBook(db, registered.id)).toBe(false);
  });
  it('never queries an empty scope and rejects more than one group of review words', async () => {
    const query = vi.fn().mockResolvedValue([]);
    const db = { studyProgress: { findMany: query } } as unknown as Parameters<
      typeof loadAcceptedReviewFocusIds
    >[0];
    expect(await loadAcceptedReviewFocusIds(db, 'user', [])).toEqual(new Map());
    expect(query).not.toHaveBeenCalled();
    await expect(loadAcceptedReviewFocusIds(db, '', ['word'])).rejects.toThrow(
      'invalid_review_focus_scope',
    );
    await expect(
      loadAcceptedReviewFocusIds(
        db,
        'user',
        Array.from({ length: 21 }, (_, i) => String(i)),
      ),
    ).rejects.toThrow('invalid_review_focus_scope');
  });
  it('reads only indexed user/word pointers and ignores incomplete or impossible revisions', async () => {
    const valid = {
      wordId: 'valid',
      reviewFocusSenseId: 'reviewed-focus',
      reviewFocusRevision: 2,
      revision: 3,
      firstLearnedAt: new Date(0),
      lastReviewAt: new Date(0),
    };
    const query = vi
      .fn()
      .mockResolvedValue([
        valid,
        { ...valid, wordId: 'unrated', reviewFocusRevision: 0 },
        { ...valid, wordId: 'future', reviewFocusRevision: 4 },
        { ...valid, wordId: 'blank', reviewFocusSenseId: ' ' },
        { ...valid, wordId: 'unlearned', firstLearnedAt: null },
      ]);
    const db = { studyProgress: { findMany: query } } as unknown as Parameters<
      typeof loadAcceptedReviewFocusIds
    >[0];
    expect(await loadAcceptedReviewFocusIds(db, 'reader', ['valid', 'valid'])).toEqual(
      new Map([['valid', 'reviewed-focus']]),
    );
    expect(query).toHaveBeenCalledExactlyOnceWith({
      where: { userId: 'reader', wordId: { in: ['valid'] } },
      select: {
        wordId: true,
        reviewFocusSenseId: true,
        reviewFocusRevision: true,
        revision: true,
        firstLearnedAt: true,
        lastReviewAt: true,
      },
    });
  });
});
