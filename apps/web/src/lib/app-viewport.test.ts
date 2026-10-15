import { afterEach, expect, it, vi } from 'vitest';
import { measureAppViewport } from '../components/AppViewport';
import { beforeAppBackEvent, consumeTopLayer } from './screen-lifecycle';

afterEach(() => vi.unstubAllGlobals());

it('measures visible viewport height and both offsets from the single app manager', () => {
  vi.stubGlobal('window', {
    innerHeight: 844,
    innerWidth: 390,
    visualViewport: { height: 487.4, width: 389.7, offsetTop: 42.3, offsetLeft: -2 },
  });
  expect(measureAppViewport()).toEqual({
    height: 487,
    width: 390,
    offsetTop: 42,
    offsetLeft: 0,
    keyboardOpen: true,
  });
});

it('supports browsers without visualViewport without claiming the keyboard is open', () => {
  vi.stubGlobal('window', { innerHeight: 844, innerWidth: 390 });
  expect(measureAppViewport()).toEqual({
    height: 844,
    width: 390,
    offsetTop: 0,
    offsetLeft: 0,
    keyboardOpen: false,
  });
});

it('lets a visible top layer consume exactly the current back before application navigation', () => {
  const target = new EventTarget();
  vi.stubGlobal('window', target);
  const close = vi.fn((event: Event) => event.preventDefault());
  target.addEventListener(beforeAppBackEvent, close, { once: true });
  expect(consumeTopLayer()).toBe(true);
  expect(close).toHaveBeenCalledTimes(1);
  expect(consumeTopLayer()).toBe(false);
});
