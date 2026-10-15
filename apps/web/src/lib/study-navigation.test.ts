import React, { Children, type ReactElement, type ReactNode } from 'react';
import { createMemoryRouter, type Location } from 'react-router-dom';
import { afterAll, expect, it, vi } from 'vitest';
import { renderAppScreen, ScreenRoutes } from '../App';
import { screenIdentity } from './navigation';
import { linkStudySession } from './study-navigation';

const route = vi.hoisted(() => {
  vi.stubGlobal('window', { __NIGHTSTUDY_CONFIG__: {} });
  return { location: { pathname: '/learn' } as Location };
});
vi.mock('react-router-dom', async (original) => ({
  ...(await original<typeof import('react-router-dom')>()),
  useLocation: () => route.location,
}));
vi.stubGlobal('React', React);
afterAll(() => vi.unstubAllGlobals());

// Inspect keys used by the real retained-screen renderer and the route element.
// Browser location keys change on query updates; neither mounted React key may do so.
function pageBoundaryKey() {
  const screen = renderAppScreen({
    id: screenIdentity(route.location.pathname),
    location: route.location,
    active: true,
    kind: route.location.pathname === '/lookup' ? 'module' : 'study',
  });
  const wrapper = Children.only(screen.props.children) as ReactElement<{ children: ReactNode }>;
  const boundary = Children.only(wrapper.props.children) as ReactElement;
  return `${screen.key}:${boundary.key}`;
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
    const rendered = ScreenRoutes({ location: route.location });
    const routes = Children.only(rendered.props.children) as ReactElement<{ children: ReactNode }>;
    const studyRoute = Children.toArray(routes.props.children).find(
      (node) => React.isValidElement<{ path: string }>(node) && node.props.path === 'learn',
    ) as ReactElement<{ element: ReactElement }>;
    expect(studyRoute.props.element.key).toBe('learn');
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
