import { afterEach, expect, it, vi } from 'vitest';
import {
  beforeAppBackEvent,
  createAppBackHandler,
  installAppBackBridge,
  registerAppBackHandler,
} from './screen-lifecycle';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.unstubAllGlobals();
});
function pop(target: EventTarget, index: number) {
  target.dispatchEvent(Object.assign(new Event('popstate'), { state: { idx: index } }));
}

it('runs the pre-router bridge before a router listener registered earlier than the provider, closes only the dialog and permits the next back', () => {
  const target = new EventTarget();
  vi.stubGlobal('window', target);
  // The app may have reloaded: its root index is not assumed to be zero.
  let position = { index: 2, key: 'learning' },
    nativeIndex = 2;
  let dialogOpen = true;
  const order: string[] = [];
  const restore = vi.fn();
  cleanups.push(installAppBackBridge(target as unknown as Window));
  const router = () => {
    order.push('router');
    position = { index: nativeIndex, key: nativeIndex === 2 ? 'learning' : 'home' };
  };
  target.addEventListener('popstate', router);
  cleanups.push(() => target.removeEventListener('popstate', router));
  // Layout effects run after BrowserRouter has subscribed. They register only
  // the current account handler; the early bridge already owns listener order.
  cleanups.push(
    registerAppBackHandler(
      createAppBackHandler(
        () => position,
        (index) => [1, 2].includes(index),
        restore,
      ),
    ),
  );
  const dialog = (event: Event) => {
    order.push('layer');
    if (!dialogOpen) return;
    dialogOpen = false;
    event.preventDefault();
  };
  target.addEventListener(beforeAppBackEvent, dialog);
  cleanups.push(() => target.removeEventListener(beforeAppBackEvent, dialog));
  nativeIndex = 1;
  pop(target, nativeIndex);
  expect(dialogOpen).toBe(false);
  expect(position).toEqual({ index: 2, key: 'learning' });
  expect(order).toEqual(['layer']);
  expect(restore).toHaveBeenCalledExactlyOnceWith(1);
  nativeIndex = 2;
  pop(target, nativeIndex);
  expect(order).toEqual(['layer', 'router']);
  nativeIndex = 1;
  pop(target, nativeIndex);
  expect(position).toEqual({ index: 1, key: 'home' });
  expect(order).toEqual(['layer', 'router', 'layer', 'router']);
  expect(restore).toHaveBeenCalledOnce();
});

it('does not let an old scope cleanup remove a newer handler and never adds a history sentinel', () => {
  const target = new EventTarget();
  vi.stubGlobal('window', target);
  const remove = installAppBackBridge(target as unknown as Window);
  cleanups.push(remove);
  expect(installAppBackBridge(target as unknown as Window)).toBe(remove);
  const oldScope = vi.fn(),
    newScope = vi.fn();
  const clearOld = registerAppBackHandler(oldScope);
  const clearNew = registerAppBackHandler(newScope);
  cleanups.push(clearNew);
  clearOld();
  pop(target, 1);
  expect(oldScope).not.toHaveBeenCalled();
  expect(newScope).toHaveBeenCalledOnce();
  clearNew();
  pop(target, 0);
  expect(newScope).toHaveBeenCalledOnce();
});

it('gives a later push priority over an old restoration without bypassing the next dialog', () => {
  const target = new EventTarget();
  vi.stubGlobal('window', target);
  let position = { index: 2, key: 'learning' };
  const restore = vi.fn();
  cleanups.push(installAppBackBridge(target as unknown as Window));
  cleanups.push(
    registerAppBackHandler(
      createAppBackHandler(
        () => position,
        () => true,
        restore,
      ),
    ),
  );
  const close = vi.fn((event: Event) => event.preventDefault());
  target.addEventListener(beforeAppBackEvent, close);
  cleanups.push(() => target.removeEventListener(beforeAppBackEvent, close));
  pop(target, 1);
  expect(restore).toHaveBeenLastCalledWith(1);
  // A newer route was pushed before the restoration event arrived. Its own
  // dialog must still receive back even when the next index matches that old target.
  position = { index: 3, key: 'new-route' };
  pop(target, 2);
  expect(close).toHaveBeenCalledTimes(2);
  expect(restore).toHaveBeenCalledTimes(2);
});
