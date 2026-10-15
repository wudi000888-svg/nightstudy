import React, { type ReactElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PwaProvider } from './Pwa';
import { post } from '../lib/api';
import { activeWriteRequests } from '../lib/request-activity';

interface Effect {
  deps: unknown[];
  cleanup?: () => void;
}
const state = vi.hoisted(() => {
  vi.stubGlobal('window', { __NIGHTSTUDY_CONFIG__: {} });
  return {
    pathname: '/',
    pending: 0,
    scope: 'scope-a',
    slots: [] as unknown[],
    cursor: 0,
    refs: [] as { current: unknown }[],
    refCursor: 0,
    effects: [] as Effect[],
    effectCursor: 0,
    setups: [] as { index: number; setup: () => unknown; deps: unknown[] }[],
    unsubscribe: null as null | (() => void),
    storeUpdates: 0,
  };
});
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => {
    const index = state.cursor++;
    if (!(index in state.slots))
      state.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [
      state.slots[index],
      (value: unknown) => {
        state.slots[index] = typeof value === 'function' ? value(state.slots[index]) : value;
      },
    ];
  },
  useRef: (initial: unknown) => (state.refs[state.refCursor++] ??= { current: initial }),
  useSyncExternalStore: (
    subscribe: (listener: () => void) => () => void,
    snapshot: () => number,
  ) => {
    state.unsubscribe ??= subscribe(() => {
      state.storeUpdates++;
    });
    return snapshot();
  },
  useEffect: (setup: () => unknown, deps: unknown[]) => {
    const index = state.effectCursor++,
      previous = state.effects[index];
    if (!previous || deps.some((value, at) => !Object.is(value, previous.deps[at])))
      state.setups.push({ index, setup, deps });
  },
}));
vi.mock('../AppContext', () => ({
  useApp: () => ({
    site: { siteId: 'site-a', instanceId: 'installation-a', basePath: '' },
    pending: state.pending,
    scope: state.scope,
  }),
}));
vi.mock('react-router-dom', () => ({ useLocation: () => ({ pathname: state.pathname }) }));

interface Value {
  update: () => void;
  canUpdate: boolean;
  updateReady: boolean;
}
function render(): Value {
  state.cursor = state.refCursor = state.effectCursor = 0;
  state.setups = [];
  const view = PwaProvider({ children: null }) as ReactElement<{ value: Value }>;
  for (const setup of state.setups) {
    state.effects[setup.index]?.cleanup?.();
    const cleanup = setup.setup();
    state.effects[setup.index] = {
      deps: setup.deps,
      cleanup: typeof cleanup === 'function' ? (cleanup as () => void) : undefined,
    };
  }
  return view.props.value;
}
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  return render();
}
let worker: EventTarget & { controller: object | null; register: ReturnType<typeof vi.fn> };
let registration: EventTarget & {
  waiting: { postMessage: ReturnType<typeof vi.fn> } | null;
  installing: null;
};
let reload: ReturnType<typeof vi.fn>;
let response: ((value: Response) => void) | null;
beforeEach(() => {
  expect(activeWriteRequests()).toBe(0);
  state.pathname = '/';
  state.pending = 0;
  state.scope = 'scope-a';
  state.slots = [];
  state.refs = [];
  state.effects = [];
  state.setups = [];
  state.storeUpdates = 0;
  reload = vi.fn();
  response = null;
  registration = Object.assign(new EventTarget(), {
    waiting: { postMessage: vi.fn() },
    installing: null,
  });
  worker = Object.assign(new EventTarget(), {
    controller: {} as object | null,
    register: vi.fn().mockResolvedValue(registration),
  });
  const media = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal('React', React);
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), {
      isSecureContext: true,
      matchMedia: () => media,
      location: { reload },
    }),
  );
  vi.stubGlobal('navigator', { serviceWorker: worker });
  vi.stubGlobal('document', { visibilityState: 'visible' });
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((done) => {
          response = done;
        }),
    ),
  );
  vi.stubEnv('PROD', true);
});
afterEach(() => {
  for (const effect of state.effects) effect?.cleanup?.();
  state.unsubscribe?.();
  state.unsubscribe = null;
  expect(activeWriteRequests()).toBe(0);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('blocks a retained note save from activating an update even before React has rendered the busy store snapshot', async () => {
  render();
  const beforeSave = await settle();
  expect(beforeSave.updateReady).toBe(true);
  expect(beforeSave.canUpdate).toBe(true);
  const save = post('notes', { title: 'Rain', body: 'A retained screen is saving.' });
  beforeSave.update();
  expect(registration.waiting!.postMessage).not.toHaveBeenCalled();
  expect(render().canUpdate).toBe(false);
  expect(state.storeUpdates).toBe(1);
  response!(Response.json({ note: { id: 'confirmed-note' } }));
  await save;
  const ready = render();
  expect(ready.canUpdate).toBe(true);
  ready.update();
  expect(registration.waiting!.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'ACTIVATE' });
  expect(state.storeUpdates).toBe(2);
});

it('rechecks new writes synchronously at controllerchange and offers a safe retry after confirmation', async () => {
  render();
  (await settle()).update();
  const save = post('notes/id', { body: 'A write started after accepting the update.' }, 'PATCH');
  worker.dispatchEvent(new Event('controllerchange'));
  expect(reload).not.toHaveBeenCalled();
  expect(render().canUpdate).toBe(false);
  response!(Response.json({ ok: true }));
  await save;
  const ready = render();
  expect(ready.updateReady).toBe(true);
  expect(ready.canUpdate).toBe(true);
  ready.update();
  expect(reload).toHaveBeenCalledOnce();
});

it('never reloads on first installation or carries accepted update intent across an account scope change', async () => {
  worker.controller = null;
  render();
  await settle();
  worker.dispatchEvent(new Event('controllerchange'));
  expect(reload).not.toHaveBeenCalled();
  worker.controller = {};
  registration.dispatchEvent(new Event('updatefound'));
  // Remount registration lifecycle for a fresh account-bound update offer.
  state.scope = 'scope-b';
  render();
  (await settle()).update();
  expect(registration.waiting!.postMessage).toHaveBeenCalledOnce();
  state.scope = 'scope-c';
  render();
  worker.dispatchEvent(new Event('controllerchange'));
  expect(reload).not.toHaveBeenCalled();
});
