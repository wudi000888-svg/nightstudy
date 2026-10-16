import { expect, it } from 'vitest';
import { wordCardPlacement } from './word-cards';

it('opens beside the tapped sentence on a phone when space permits, without covering it', () => {
  const result = wordCardPlacement(
    { left: 270, right: 320, top: 260, bottom: 282 },
    { left: 0, top: 0, width: 390, height: 844 },
    320,
  );
  expect(result.placement).toBe('below');
  expect(result.style.top).toBeGreaterThan(282);
  expect(result.style.left + result.style.width).toBeLessThanOrEqual(378);
});

it('moves above a word near the bottom while keeping it visible', () => {
  const result = wordCardPlacement(
    { left: 30, right: 90, top: 720, bottom: 744 },
    { left: 0, top: 0, width: 390, height: 844 },
    300,
  );
  expect(result.placement).toBe('above');
  expect(result.style.top + result.style.maxHeight).toBeLessThan(720);
});

it('uses a compact bottom card on short screens and stays inside the visible keyboard viewport', () => {
  const viewport = { left: 5, top: 100, width: 320, height: 290 };
  const result = wordCardPlacement({ left: 20, right: 55, top: 210, bottom: 232 }, viewport, 330);
  expect(result.placement).toBe('bottom');
  expect(result.style.top).toBeGreaterThanOrEqual(viewport.top + 12);
  expect(result.style.top + result.style.maxHeight).toBeLessThanOrEqual(378);
  expect(result.style.left).toBeGreaterThanOrEqual(viewport.left + 12);
  expect(result.style.left + result.style.width).toBeLessThanOrEqual(313);
});

it('keeps desktop hover cards narrow and within the viewport edges', () => {
  const result = wordCardPlacement(
    { left: 1190, right: 1240, top: 500, bottom: 520 },
    { left: 0, top: 0, width: 1280, height: 720 },
    300,
  );
  expect(result.style.width).toBe(420);
  expect(result.style.left + result.style.width).toBe(1268);
  expect(result.placement).toBe('above');
});
