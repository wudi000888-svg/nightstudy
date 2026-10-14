import { describe, expect, it } from 'vitest';
import { splitInterval, splitPlannedInterval } from './analytics.js';
import { learningDayWindow } from './shared.js';

describe('learning-day statistics preserve boundaries', () => {
  it('keeps the New York spring learning day at its real 23-hour duration', () => {
    const day = learningDayWindow(new Date('2026-03-07T16:00:00Z'), 'America/New_York');
    expect(day.startsAt.toISOString()).toBe('2026-03-07T09:00:00.000Z');
    expect(day.endsAt.toISOString()).toBe('2026-03-08T08:00:00.000Z');
  });
  it('keeps the New York autumn learning day at its real 25-hour duration', () => {
    const day = learningDayWindow(new Date('2026-10-31T16:00:00Z'), 'America/New_York');
    expect(day.startsAt.toISOString()).toBe('2026-10-31T08:00:00.000Z');
    expect(day.endsAt.toISOString()).toBe('2026-11-01T09:00:00.000Z');
  });
  it('splits new learning activity at Shanghai 04:00 rather than midnight', () => {
    expect(
      splitInterval(
        new Date('2026-10-13T19:59:50Z'),
        new Date('2026-10-13T20:00:10Z'),
        'Asia/Shanghai',
        4,
      ).map((part) => [part.date, (part.endAt.getTime() - part.startAt.getTime()) / 1000]),
    ).toEqual([
      ['2026-10-13', 10],
      ['2026-10-14', 10],
    ]);
  });
  it('uses a saved plan date after the current timezone changes', () => {
    const start = new Date('2026-10-13T20:00:00Z');
    expect(
      splitPlannedInterval(
        start,
        new Date(start.getTime() + 20000),
        [
          {
            startsAt: start,
            endsAt: new Date('2026-10-14T20:00:00Z'),
            localDate: '2026-10-14',
            timeZone: 'Asia/Shanghai',
          },
        ],
        'America/Los_Angeles',
      ).map((part) => part.date),
    ).toEqual(['2026-10-14']);
  });
  it('preserves the original midnight attribution before task plans were introduced', () => {
    const start = new Date('2026-10-13T17:00:00Z');
    expect(
      splitPlannedInterval(
        start,
        new Date(start.getTime() + 10000),
        [
          {
            startsAt: new Date('2026-10-12T20:00:00Z'),
            endsAt: new Date('2026-10-13T20:00:00Z'),
            localDate: '2026-10-13',
            timeZone: 'Asia/Shanghai',
          },
        ],
        'Asia/Shanghai',
        new Date('2026-10-13T18:00:00Z'),
      ).map((part) => part.date),
    ).toEqual(['2026-10-14']);
  });
});
