import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Dialog } from '../components/UI';
import { consumeTopLayer } from './screen-lifecycle';

const state = vi.hoisted(() => {
  vi.stubGlobal('window', { __NIGHTSTUDY_CONFIG__: {} });
  return {
    active: true,
    current: 'a',
    cursor: 0,
    refs: new Map<string, { current: unknown }[]>(),
    elements: new Map<
      string,
      { open: boolean; showModal: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }
    >(),
    effects: new Map<string, { deps: unknown[]; cleanup?: () => void }>(),
  };
});
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useContext: () => state.active,
  useId: () => `dialog-${state.current}`,
  useRef: (initial: unknown) => {
    const slots = state.refs.get(state.current) ?? [];
    state.refs.set(state.current, slots);
    const index = state.cursor++;
    return (slots[index] ??= {
      current: index === 0 ? state.elements.get(state.current) : initial,
    });
  },
  useEffect: (setup: () => (() => void) | undefined, deps: unknown[]) => {
    const previous = state.effects.get(state.current);
    if (previous && deps.every((value, index) => Object.is(value, previous.deps[index]))) return;
    previous?.cleanup?.();
    state.effects.set(state.current, { deps, cleanup: setup() });
  },
}));

function render(name: string, open: boolean, onClose: () => void) {
  state.current = name;
  state.cursor = 0;
  if (!state.elements.has(name)) {
    const element = {
      open: false,
      showModal: vi.fn(() => {
        element.open = true;
      }),
      close: vi.fn(() => {
        element.open = false;
      }),
    };
    state.elements.set(name, element);
  }
  return Dialog({ open, title: '学习计划', children: '保留编辑草稿', onClose });
}
beforeEach(() => {
  state.active = true;
  state.refs.clear();
  state.elements.clear();
  state.effects.clear();
  vi.stubGlobal('React', React);
  vi.stubGlobal('window', new EventTarget());
});
afterEach(() => {
  for (const effect of state.effects.values()) effect.cleanup?.();
  vi.unstubAllGlobals();
});

it('uses the real modal effect to consume back for the top dialog before closing its parent layer', () => {
  const parent = vi.fn(),
    child = vi.fn();
  render('a', true, parent);
  render('b', true, child);
  expect(consumeTopLayer()).toBe(true);
  expect(child).toHaveBeenCalledOnce();
  expect(parent).not.toHaveBeenCalled();
  render('b', false, child);
  expect(consumeTopLayer()).toBe(true);
  expect(parent).toHaveBeenCalledOnce();
  render('a', false, parent);
  expect(consumeTopLayer()).toBe(false);
});

it('closes the native top layer when its retained screen is hidden, preserving the controlled editing state for reopen', () => {
  const close = vi.fn();
  render('a', true, close);
  const native = state.elements.get('a')!;
  expect(native.open).toBe(true);
  state.active = false;
  render('a', true, close);
  expect(native.open).toBe(false);
  expect(consumeTopLayer()).toBe(false);
  expect(close).not.toHaveBeenCalled();
  state.active = true;
  render('a', true, close);
  expect(native.open).toBe(true);
  expect(native.showModal).toHaveBeenCalledTimes(2);
  state.effects.get('a')!.cleanup?.();
  expect(native.open).toBe(false);
  expect(consumeTopLayer()).toBe(false);
});

it('keeps native cancel controlled when a saving owner refuses to dismiss the dialog', () => {
  const refuseDismiss = vi.fn();
  const view = render('a', true, refuseDismiss);
  const preventDefault = vi.fn();
  view.props.onCancel({ preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(refuseDismiss).toHaveBeenCalledOnce();
  expect(state.elements.get('a')!.open).toBe(true);
});
