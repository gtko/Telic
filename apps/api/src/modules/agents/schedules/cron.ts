import * as cron from '@repo/cron';
import { HttpError } from '#shared/lib';

function wrap<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof cron.InvalidCronError) throw new HttpError(400, 'Invalid cron expression');
    throw error;
  }
}

export function assertValidCron(expression: string): void {
  wrap(() => cron.assertValidCron(expression));
}

export function nextCronRun(expression: string, from = new Date()): Date {
  return wrap(() => cron.nextCronRun(expression, from));
}

export function minCronIntervalSeconds(expression: string, from = new Date()): number {
  return wrap(() => cron.minCronIntervalSeconds(expression, from));
}
