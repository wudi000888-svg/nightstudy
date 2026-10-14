import { Children, type ReactElement, type ReactNode } from 'react';
import { createMemoryRouter, type Location } from 'react-router-dom';
import { afterAll, expect, it, vi } from 'vitest';
import { App } from '../App';
import { linkStudySession } from './study-navigation';

const route = vi.hoisted(() => {
  vi.stubGlobal('window', { __NIGHTSTUDY_CONFIG__: {} });
  return { location: { pathname: '/learn' } as Location };
});
vi.mock('react-router-dom', async (original) => ({
  ...(await original<typeof import('react-router-dom')>()),
  useLocation: () => route.location,
}));
afterAll(() => vi.unstubAllGlobals());

// Inspect the actual page boundary element rendered by App's route, rather than
// reproducing its key selection in a test helper. Equal keys preserve React page
// state; changing a key remounts the entire subtree, including its query hooks.
function pageBoundaryKey() {
  const app = App();
  const shell = Children.only(app.props.children) as ReactElement<{ children: ReactNode }>;
  const page = Children.toArray(shell.props.children)[0] as ReactElement<{
    element: ReactElement;
  }>;
  const outlet = page.props.element.type as () => ReactElement;
  return outlet().key;
}

it('preserves the mounted page boundary across session and query navigation', async () => {
  const router = createMemoryRouter([{ path: '*', element: null }], {
    initialEntries: ['/learn'],
  });
  try {
    route.location = router.state.location;
    const initialKey = pageBoundaryKey();
    const navigationKey = router.state.location.key;
    await router.navigate('/learn?session=saved-task');
    route.location = router.state.location;
    expect(router.state.location.key).not.toBe(navigationKey);
    expect(pageBoundaryKey()).toBe(initialKey);
    await router.navigate('/learn?session=another-task#meaning');
    route.location = router.state.location;
    expect(pageBoundaryKey()).toBe(initialKey);
    await router.navigate('/lookup?q=water');
    route.location = router.state.location;
    expect(pageBoundaryKey()).not.toBe(initialKey);
  } finally {
    router.dispose();
  }
});

it('links a started task once and does not navigate again when loading the same saved task', async () => {
  const router = createMemoryRouter([{ path: '*', element: null }], {
    initialEntries: ['/learn'],
  });
  const navigations: Promise<void>[] = [];
  const write = vi.fn((next: Record<string, string>) => {
    navigations.push(router.navigate(`/learn?${new URLSearchParams(next)}`));
  });
  const link = (sessionId: string | null) =>
    linkStudySession(new URLSearchParams(router.state.location.search), sessionId, write);
  try {
    link('saved-task');
    await Promise.all(navigations);
    expect(router.state.location.search).toBe('?session=saved-task');
    const linkedKey = router.state.location.key;
    for (let repeat = 0; repeat < 10; repeat++) link('saved-task');
    expect(write).toHaveBeenCalledTimes(1);
    expect(router.state.location.key).toBe(linkedKey);
    link('another-task');
    await Promise.all(navigations);
    expect(router.state.location.search).toBe('?session=another-task');
    expect(write).toHaveBeenCalledTimes(2);
    link(null);
    await Promise.all(navigations);
    const clearedKey = router.state.location.key;
    expect(router.state.location.search).toBe('');
    link(null);
    expect(write).toHaveBeenCalledTimes(3);
    expect(router.state.location.key).toBe(clearedKey);
  } finally {
    router.dispose();
  }
});
