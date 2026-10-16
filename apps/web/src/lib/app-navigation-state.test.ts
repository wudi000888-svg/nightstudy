import { describe, expect, it } from 'vitest';
import type { Location } from 'react-router-dom';
import {
  AppNavigationState,
  AppScreenCache,
  committedHistoryIndex,
  type NavigationAction,
} from './app-navigation-state';
import { screenIdentity } from './navigation';

function location(href: string, key: string): Location {
  const url = new URL(href, 'https://navigation.test');
  return { pathname: url.pathname, search: url.search, hash: url.hash, state: null, key };
}
function visit(
  state: AppNavigationState,
  href: string,
  index: number,
  action: NavigationAction = 'PUSH',
  restore = false,
) {
  const route = location(href, `${index}:${href}`);
  state.visit(route, action, index, restore);
  return route;
}

describe('H5 module navigation state', () => {
  it('keeps a proven lookup detail as a subpage for header, page and native back', () => {
    for (const path of ['/lookup', '/wordbook']) {
      const state = new AppNavigationState();
      const list = visit(state, `${path}?q=sys&match=contains&sort=za`, 0, 'POP');
      const detail = {
        ...location(`${path}?q=sys&match=contains&sort=za&entry=system`, 'detail'),
        state: { lookupListKey: list.key },
      };
      state.visit(detail, 'PUSH', 1);
      expect(state.previous('content')).toEqual(list);
      expect(state.canPopTo(list, 1)).toBe(true);
      const sense = { ...detail, search: detail.search + '&sense=noun', key: 'sense' };
      state.visit(sense, 'REPLACE', 1);
      expect(state.previous('content')).toEqual(list);
      expect(state.destinationLocation('content').state).toEqual({ lookupListKey: list.key });
      state.visit(list, 'POP', 0);
      expect(state.destination('content')).toBe(`${path}?q=sys&match=contains&sort=za`);
      expect(state.previous('content')?.pathname).not.toBe(path);
    }
  });
  it('does not invent a lookup list on a direct entry or treat mismatched conditions as list history', () => {
    const deep = new AppNavigationState();
    visit(deep, '/lookup?q=sys&entry=system', 0, 'POP');
    expect(deep.previous('content')).toBeUndefined();
    expect(deep.homeDistance(0)).toBeNull();
    const state = new AppNavigationState();
    const list = visit(state, '/wordbook?q=bank&sort=az', 0, 'POP');
    state.visit(
      {
        ...location('/wordbook?q=sys&sort=za&entry=system', 'mismatched'),
        state: { lookupListKey: list.key },
      },
      'PUSH',
      1,
    );
    expect(state.previous('content')?.key).not.toBe(list.key);
  });
  it('keeps the committed route index during a cancelled pop and realigns a remounted scope after restoration', () => {
    const learning = location('/learning?section=plan', 'learning');
    const previous = { location: learning, index: 2 };
    expect(
      committedHistoryIndex(previous, learning, { index: 1, href: '/school/' }, '/school'),
    ).toBe(2);
    expect(
      committedHistoryIndex(
        previous,
        learning,
        { index: 2, href: '/school/learning?section=plan' },
        '/school',
      ),
    ).toBe(2);
    const remounted = { location: learning, index: 1 };
    expect(
      committedHistoryIndex(
        remounted,
        learning,
        { index: 2, href: '/school/learning?section=plan' },
        '/school',
      ),
    ).toBe(2);
    expect(
      committedHistoryIndex(
        previous,
        location('/', 'home'),
        { index: 1, href: '/school/' },
        '/school',
      ),
    ).toBe(1);
  });
  it('bounds retained screens while protecting module roots and editing surfaces, and never caches arbitrary paths', () => {
    const cache = new AppScreenCache(location('/', 'home'));
    for (const [index, href] of [
      '/',
      '/learning',
      '/content',
      '/academy',
      '/me',
      '/notes',
      '/books/import',
      '/wordbook',
      '/books',
      '/books/mine',
      '/lookup',
      '/dictionary',
      '/known',
      '/assessment',
      '/memory',
      '/stats',
      '/library',
      '/sentences',
    ].entries()) {
      cache.visit(location(href, `cache-${index}`));
    }
    expect(cache.locations.size).toBe(12);
    for (const id of [
      'home',
      '/learning',
      '/content',
      '/academy',
      '/me',
      '/notes',
      '/books/import',
      '/wordbook',
    ])
      expect(cache.locations.has(id)).toBe(true);
    for (const href of ['/admin', '/admin/users', '/auth', '/learn', '/review', '/unknown']) {
      expect(cache.retains(href)).toBe(false);
      cache.visit(location(href, href));
    }
    expect(cache.locations.size).toBe(12);
    cache.visit(location('/sentences?search=water', 'sentences-query'));
    expect(cache.locations.size).toBe(12);
    expect(cache.locations.get('/sentences')?.search).toBe('?search=water');
  });

  it('reopens a module at its last child with the internal stack preserved after closing to home', () => {
    const state = new AppNavigationState();
    visit(state, '/', 0, 'POP');
    const content = visit(state, '/content', 1);
    visit(state, '/notes?search=rain#draft', 2);
    expect(state.homeDistance(2)).toBe(2);
    visit(state, '/', 0, 'POP');
    expect(state.destination('content')).toBe('/notes?search=rain#draft');
    visit(state, state.destination('content'), 1, 'PUSH', true);
    expect(state.previous('content')).toEqual(content);
    expect(state.canPopTo(content, 1)).toBe(false);
    const previous = state.takePrevious('content')!;
    state.visit({ ...previous, key: 'reopened-parent' }, 'REPLACE', 1, true);
    expect(state.destination('content')).toBe('/content');
    expect(state.previous('content')).toBeUndefined();
    expect(state.homeDistance(1)).toBe(1);
  });

  it('uses actual browser history for internal back and handles a direct deep link without inventing a sentinel', () => {
    const state = new AppNavigationState();
    const parent = visit(state, '/content', 0, 'POP');
    visit(state, '/wordbook?entry=water', 1);
    expect(state.canPopTo(parent, 1)).toBe(true);
    expect(state.homeDistance(1)).toBeNull();
    state.visit(parent, 'POP', 0);
    expect(state.previous('content')).toBeUndefined();
    const deep = new AppNavigationState();
    visit(deep, '/notes?note=private', 0, 'POP');
    expect(deep.previous('content')?.pathname).toBe('/content');
    expect(deep.homeDistance(0)).toBeNull();
    expect(deep.history.size).toBe(1);
  });

  it('does not grow a child stack for query changes or restore another module state into a fresh account', () => {
    const state = new AppNavigationState();
    visit(state, '/academy', 0, 'POP');
    for (let index = 1; index <= 40; index++)
      visit(state, `/academy?lesson=lesson-${index}`, index);
    expect(state.modules.get('academy')).toHaveLength(1);
    expect(state.destination('academy')).toBe('/academy?lesson=lesson-40');
    expect(state.destination('content')).toBe('/content');
    expect(new AppNavigationState().destination('academy')).toBe('/academy');
    expect(screenIdentity('/learn')).toBe(screenIdentity('/review'));
    expect(screenIdentity('/notes')).not.toBe(screenIdentity('/sentences'));
  });

  it('keeps administration outside personal-centre module memory', () => {
    const state = new AppNavigationState();
    visit(state, '/me?section=preferences', 0, 'POP');
    visit(state, '/admin/ai', 1);
    expect(state.destination('account')).toBe('/me?section=preferences');
    expect(state.modules.get('account')).toHaveLength(1);
    visit(state, '/unknown-page', 2);
    expect(state.destination('content')).toBe('/content');
  });

  it('discards stale forward history after a new branch and retains separate module destinations', () => {
    const state = new AppNavigationState();
    const home = visit(state, '/', 0, 'POP');
    visit(state, '/learning?section=calendar', 1);
    visit(state, '/memory', 2);
    state.visit(home, 'POP', 0);
    visit(state, '/academy', 1);
    expect(state.history.has(2)).toBe(false);
    expect(state.destination('learning')).toBe('/memory');
    expect(state.destination('academy')).toBe('/academy');
    expect(state.homeDistance(1)).toBe(1);
  });
});
