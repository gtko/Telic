import { Cron } from 'croner';
import { describe, expect, it } from 'vitest';
import {
  InvalidCronError,
  assertValidCron,
  isValidCron,
  minCronIntervalSeconds,
  nextCronRun,
  nextCronRuns,
  tryNextCronRun,
} from '../index';

const FROM = new Date(Date.UTC(2030, 0, 15, 10, 30, 0));

// What the api used to accept and compute with (croner). The parity table is the reason this
// module exists: the two libraries must agree on every expression the app can store.
const PARITY = [
  '* * * * *',
  '*/5 * * * *',
  '0 9 * * *',
  '0 9 * * 1-5',
  '30 2 1 * *',
  '0 0 * * 0',
  '0 0 * * 7',
  '15,45 8-18/2 * * *',
  '0 0 1 1 *',
  '0 12 15 * 1',
  '0 0 29 2 *',
  '0 0 * * MON',
  '0 0 1 JAN,JUL *',
  '@daily',
  '@hourly',
  '@weekly',
  '@monthly',
  '@yearly',
];

describe('cron grammar', () => {
  it.each(PARITY)('computes the same next runs as croner for %s', (expression) => {
    const ours = nextCronRuns(expression, 5, FROM).map((d) => d.getTime());
    const theirs = new Cron(expression, { timezone: 'UTC', paused: true })
      .nextRuns(5, FROM)
      .map((d) => d.getTime());
    expect(ours).toEqual(theirs);
  });

  it('agrees with croner on the minimum interval', () => {
    for (const expression of PARITY) {
      const runs = new Cron(expression, { timezone: 'UTC', paused: true }).nextRuns(5, FROM);
      let shortest = Infinity;
      for (let i = 1; i < runs.length; i++) {
        shortest = Math.min(shortest, (runs[i]!.getTime() - runs[i - 1]!.getTime()) / 1000);
      }
      expect(minCronIntervalSeconds(expression, FROM)).toBe(shortest);
    }
  });

  it('is strictly after the given date and in UTC', () => {
    expect(nextCronRun('30 10 * * *', FROM).toISOString()).toBe('2030-01-16T10:30:00.000Z');
    expect(nextCronRun('0 9 * * *', FROM).toISOString()).toBe('2030-01-16T09:00:00.000Z');
  });

  it('rejects what neither side can honour', () => {
    for (const bad of [
      '',
      'not a cron',
      '* * * *',
      '60 * * * *',
      '* * 32 * *',
      '* * * 13 *',
      '*/90 * * * *',
      '*/0 * * * *',
      '* */25 * * *',
    ]) {
      expect(isValidCron(bad)).toBe(false);
      expect(() => assertValidCron(bad)).toThrow(InvalidCronError);
      expect(tryNextCronRun(bad, FROM)).toBeNull();
    }
  });

  it('rejects a seconds field: the worker ticks once a minute', () => {
    expect(isValidCron('*/10 * * * * *')).toBe(false);
  });

  it('has no next run for a date that never comes', () => {
    expect(() => nextCronRun('0 0 31 2 *', FROM)).toThrow(InvalidCronError);
    expect(tryNextCronRun('0 0 31 2 *', FROM)).toBeNull();
  });

  it('measures the shortest gap of an irregular cron', () => {
    expect(minCronIntervalSeconds('*/5 * * * *', FROM)).toBe(300);
    // Monday and Tuesday: gaps of 1 day and 6 days; the shortest is the day.
    expect(minCronIntervalSeconds('0 0 * * 1,2', FROM)).toBe(86_400);
  });
});
