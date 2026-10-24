import { describe, expect, test } from 'vitest';
import { minCronIntervalSeconds, nextCronRun } from '../../cron';

describe('nextCronRun', () => {
  test('calculates the next run in UTC', () => {
    const next = nextCronRun('0 9 * * *', new Date('2026-07-15T08:30:00.000Z'));
    expect(next.toISOString()).toBe('2026-07-15T09:00:00.000Z');
  });

  test('rejects an invalid expression', () => {
    expect(() => nextCronRun('not a cron')).toThrow('Invalid cron expression');
  });
});

describe('minCronIntervalSeconds', () => {
  const from = new Date('2026-07-15T08:30:00.000Z');

  test('measures an even schedule', () => {
    expect(minCronIntervalSeconds('*/5 * * * *', from)).toBe(300);
    expect(minCronIntervalSeconds('0 9 * * *', from)).toBe(86_400);
  });

  test('takes the shortest gap of an uneven schedule, not the first', () => {
    // 09:00 and 09:01 every day: the gap after the first run is a minute, the one
    // after it a day.
    expect(minCronIntervalSeconds('0,1 9 * * *', from)).toBe(60);
  });

  test('rejects an invalid expression', () => {
    expect(() => minCronIntervalSeconds('not a cron')).toThrow('Invalid cron expression');
  });
});
