import { describe, expect, it } from 'vitest';
import { learningDay, learningDayWindow } from './shared.js';

describe('04:00 IANA learning day boundaries', () => {
  it('keeps 03:59 in the preceding Shanghai day and starts a new day at 04:00', () => {
    expect(learningDay(new Date('2026-10-13T19:59:59Z'), 'Asia/Shanghai')).toBe('2026-10-13');
    const at = learningDayWindow(new Date('2026-10-13T20:00:00Z'), 'Asia/Shanghai');
    expect(at.localDate).toBe('2026-10-14');
    expect(at.startsAt.toISOString()).toBe('2026-10-13T20:00:00.000Z');
    expect(at.endsAt.toISOString()).toBe('2026-10-14T20:00:00.000Z');
  });
  it('uses a 23-hour spring transition day instead of shifting UTC by four hours', () => {
    const window = learningDayWindow(new Date('2026-03-07T17:00:00Z'), 'America/New_York');
    expect(window.startsAt.toISOString()).toBe('2026-03-07T09:00:00.000Z');
    expect(window.endsAt.toISOString()).toBe('2026-03-08T08:00:00.000Z');
    expect(window.endsAt.getTime() - window.startsAt.getTime()).toBe(23 * 3600000);
  });
  it('uses a 25-hour autumn transition day and stable cached boundaries', () => {
    const now = new Date('2026-10-31T17:00:00Z');
    const window = learningDayWindow(now, 'America/New_York');
    expect(window.startsAt.toISOString()).toBe('2026-10-31T08:00:00.000Z');
    expect(window.endsAt.toISOString()).toBe('2026-11-01T09:00:00.000Z');
    expect(window.endsAt.getTime() - window.startsAt.getTime()).toBe(25 * 3600000);
    expect(learningDayWindow(now, 'America/New_York')).toEqual(window);
  });
  it('supports a half-hour DST transition', () => {
    const window = learningDayWindow(new Date('2026-04-04T04:00:00Z'), 'Australia/Lord_Howe');
    expect(window.endsAt.getTime() - window.startsAt.getTime()).toBe(24.5 * 3600000);
  });
});
