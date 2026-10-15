import { beforeEach, expect, it, vi } from 'vitest';
import { usePageLifetime } from './usePageLifetime';

const state = vi.hoisted(() => ({
  scope: 'scope-a',
  active: true,
  cursor: 0,
  refs: [] as { current: unknown }[],
  cleanup: null as null | (() => void),
}));
vi.mock('react', () => ({
  useRef: (initial: unknown) => (state.refs[state.cursor++] ??= { current: initial }),
  useEffect: (setup: () => () => void) => {
    state.cleanup ??= setup();
  },
}));
vi.mock('../AppContext', () => ({ useApp: () => ({ scope: state.scope }) }));
vi.mock('../lib/screen-lifecycle', () => ({ useScreenActive: () => state.active }));
function render(route = 'route-a') {
  state.cursor = 0;
  return usePageLifetime(route);
}
beforeEach(() => {
  state.scope = 'scope-a';
  state.active = true;
  state.cursor = 0;
  state.refs = [];
  state.cleanup = null;
});
it('allows a retained hidden save to settle but rejects its navigation side effect until foreground again', () => {
  const page = render(),
    token = page.capture();
  state.active = false;
  render();
  expect(page.isCurrent(token)).toBe(true);
  expect(page.isForeground(token)).toBe(false);
  state.active = true;
  render();
  expect(page.isCurrent(token)).toBe(true);
  expect(page.isForeground(token)).toBe(true);
});
it('rejects a stale account or route owner and invalidates an unmounted lifetime', () => {
  const page = render(),
    token = page.capture();
  state.scope = 'scope-b';
  render();
  expect(page.isCurrent(token)).toBe(false);
  state.scope = 'scope-a';
  render('route-b');
  expect(page.isCurrent(token)).toBe(false);
  const current = render(),
    currentToken = current.capture();
  state.cleanup!();
  expect(current.isCurrent(currentToken)).toBe(false);
  expect(current.isForeground(currentToken)).toBe(false);
});
