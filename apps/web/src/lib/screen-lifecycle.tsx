import { createContext, useContext } from 'react';

// A retained screen keeps its form/list state but is not a foreground application.
export const ScreenActiveContext = createContext(true);
export const ScreenActiveProvider = ScreenActiveContext.Provider;
export function useScreenActive() {
  return useContext(ScreenActiveContext);
}

export const beforeAppBackEvent = 'nightstudy-before-back';
export const screenDeactivateEvent = 'nightstudy-screen-deactivate';

let backHandler: ((event: PopStateEvent) => void) | null = null;
let bridgeTarget: Window | null = null;
let removeBridge: (() => void) | null = null;

/** Install before BrowserRouter subscribes: a pop must reach layers before routing. */
export function installAppBackBridge(target: Window = window) {
  if (bridgeTarget === target && removeBridge) return removeBridge;
  removeBridge?.();
  const pop = (event: PopStateEvent) => backHandler?.(event);
  target.addEventListener('popstate', pop, true);
  bridgeTarget = target;
  const remove = () => {
    target.removeEventListener('popstate', pop, true);
    if (removeBridge === remove) {
      bridgeTarget = null;
      removeBridge = null;
    }
  };
  removeBridge = remove;
  return remove;
}

/** Scope teardown can remove its own handler without removing a newer account's. */
export function registerAppBackHandler(handler: (event: PopStateEvent) => void) {
  backHandler = handler;
  return () => {
    if (backHandler === handler) backHandler = null;
  };
}

export function createAppBackHandler(
  position: () => { index: number; key: string },
  restore: (delta: number) => void,
) {
  let restoring: { index: number; key: string } | null = null;
  return (event: PopStateEvent) => {
    const before = position();
    const next = Number(event.state?.idx);
    if (restoring) {
      const expected = restoring;
      restoring = null;
      // A later push/replace has priority over an old restoration intent.
      if (before.key === expected.key && before.index === expected.index && next === expected.index)
        return;
    }
    // After reload, earlier app history entries still exist in the browser but
    // are absent from this mount's in-memory navigation stack. An open layer
    // must consume that traversal too; ownership is only relevant to page-level
    // navigation, not to dismissing a layer on the retained current page.
    if (
      !Number.isSafeInteger(next) ||
      !Number.isSafeInteger(before.index) ||
      next < 0 ||
      before.index < 0 ||
      next === before.index
    )
      return;
    if (!consumeTopLayer()) return;
    event.stopImmediatePropagation();
    restoring = before;
    restore(before.index - next);
  };
}

export function consumeTopLayer() {
  return !window.dispatchEvent(new Event(beforeAppBackEvent, { cancelable: true }));
}
