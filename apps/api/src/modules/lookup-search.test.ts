import { describe, expect, it } from 'vitest';
import { HttpError, type RequestContext } from '../context.js';
import {
  adjacentTranspositions,
  canUseContains,
  literalLike,
  lookupQuery,
  lookupScope,
  readLookupCursor,
  signLookupCursor,
  spellingDistance,
} from './lookup-search.js';

const context = {
  instanceId: 'instance-a',
  siteId: 'site-a',
  basePath: '/english',
  fleetSecret: 'synthetic-test-secret',
  user: { id: 'learner-a', name: 'Test', email: 'test@example.test', role: 'user' },
} satisfies Partial<RequestContext>;
const query = { q: 'sys', match: 'smart' as const, sort: 'relevance' as const };
const revision = { catalog: '112', collection: '38' };
const scope = lookupScope(context, false, query);
const value = {
  v: 1 as const,
  scope,
  revision,
  expires: 10000,
  after: { normalizedLemma: 'system', id: 'word-system', tier: 1 },
};
function errorCode(action: () => unknown) {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    return (error as HttpError).code;
  }
  throw new Error('Expected an HttpError');
}

describe('bounded dictionary matching helpers', () => {
  it('escapes every LIKE metacharacter without interpreting user wildcard text', () => {
    expect(literalLike('100%_a\\b')).toBe('100\\%\\_a\\\\b');
    expect(literalLike('system')).toBe('system');
  });
  it('uses prefix-only for short and punctuation-only smart queries', () => {
    expect(canUseContains('sy')).toBe(false);
    expect(canUseContains('%__\\')).toBe(false);
    expect(canUseContains('a%b')).toBe(false);
    expect(canUseContains('sys')).toBe(true);
  });
  it('finds short adjacent transpositions even when trigram similarity cannot recall them', () => {
    expect(adjacentTranspositions('systme')).toContain('system');
    expect(adjacentTranspositions('bnak')).toContain('bank');
    expect(adjacentTranspositions('aaaa')).toEqual([]);
    expect(adjacentTranspositions('in case')).toEqual([]);
    expect(adjacentTranspositions('a'.repeat(33))).toEqual([]);
    expect(adjacentTranspositions('ab')).toEqual([]);
  });
  it('checks candidate edits, transpositions and length bounds', () => {
    expect(spellingDistance('systme', 'system')).toBe(1);
    expect(spellingDistance('bnak', 'bank')).toBe(1);
    expect(spellingDistance('system', 'systems')).toBe(1);
    expect(spellingDistance('system', 'sysem')).toBe(1);
    expect(spellingDistance('system', 'syntax')).toBeGreaterThan(2);
    expect(spellingDistance('system', 'ecosystem')).toBe(3);
  });
  it('rejects unknown fields, excessive input and unsupported enum values', () => {
    for (const input of [
      { q: 'a'.repeat(161) },
      { q: 'sys\0tem' },
      { limit: 101 },
      { limit: 1.5 },
      { match: 'semantic' },
      { sort: 'recently-added' },
      { userId: 'another-user' },
      { cursor: '' },
    ])
      expect(lookupQuery.safeParse(input).success).toBe(false);
  });
});

describe('signed lookup cursors', () => {
  it('round-trips every key while permitting page size changes', () => {
    expect(
      readLookupCursor(context, signLookupCursor(context, value), scope, revision, 9999),
    ).toEqual(value.after);
    expect(readLookupCursor(context, undefined, scope, revision, 9999)).toBeNull();
  });
  it('rejects body/signature mutation and encoded unsigned legacy cursors', () => {
    const token = signLookupCursor(context, value);
    const [body, signature] = token.split('.');
    const modified = Buffer.from(
      JSON.stringify({ ...value, after: { ...value.after, id: 'another-word' } }),
    ).toString('base64url');
    for (const invalid of [
      `${modified}.${signature}`,
      `${body}.AAAA`,
      body!,
      '!',
      `${token}.extra`,
    ])
      expect(errorCode(() => readLookupCursor(context, invalid, scope, revision, 9999))).toBe(
        'invalid_cursor',
      );
  });
  it('binds trusted instance/site/account/base path and every search condition', () => {
    const token = signLookupCursor(context, value);
    const variants = [
      lookupScope({ ...context, instanceId: 'instance-b' }, false, query),
      lookupScope({ ...context, siteId: 'site-b' }, false, query),
      lookupScope({ ...context, basePath: '/another' }, false, query),
      lookupScope({ ...context, user: { ...context.user, id: 'learner-b' } }, false, query),
      lookupScope({ ...context, user: null }, false, query),
      lookupScope(context, true, query),
      lookupScope(context, false, { ...query, q: 'bank' }),
      lookupScope(context, false, { ...query, match: 'prefix' }),
      lookupScope(context, false, { ...query, sort: 'za' }),
      lookupScope(context, true, { ...query, status: 'consolidated' }),
    ];
    for (const otherScope of variants)
      expect(errorCode(() => readLookupCursor(context, token, otherScope, revision, 9999))).toBe(
        'invalid_cursor',
      );
    expect(
      errorCode(() =>
        readLookupCursor({ fleetSecret: 'different-secret' }, token, scope, revision, 9999),
      ),
    ).toBe('invalid_cursor');
  });
  it('distinguishes expiration from catalog and private collection changes', () => {
    const token = signLookupCursor(context, value);
    expect(errorCode(() => readLookupCursor(context, token, scope, revision, 10000))).toBe(
      'cursor_expired',
    );
    expect(
      errorCode(() =>
        readLookupCursor(context, token, scope, { ...revision, catalog: '113' }, 9999),
      ),
    ).toBe('list_changed');
    expect(
      errorCode(() =>
        readLookupCursor(context, token, scope, { ...revision, collection: '39' }, 9999),
      ),
    ).toBe('list_changed');
  });
});
