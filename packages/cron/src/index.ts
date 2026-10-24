import { CronExpressionParser } from 'cron-parser';

// The one cron grammar of the app. The api validates a schedule when it is saved and the
// worker computes its next run when it fires; both call this module, so an expression the
// api accepts is one the worker can always advance (before, the api used croner and the worker
// cron-parser, which disagree on edge cases). Times are UTC. The worker ticks once a minute, so
// a seconds field cannot be honoured and is rejected: only the 5-field form and the @nicknames.

export class InvalidCronError extends Error {
  constructor(expression: string) {
    super(`Invalid cron expression: ${expression}`);
    this.name = 'InvalidCronError';
  }
}

const NICKNAME = /^@(yearly|annually|monthly|weekly|daily|midnight|hourly)$/i;

// cron-parser accepts a step larger than the field ('*/90 * * * *' runs once an hour), croner
// rejects it; the stricter reading is the contract. Largest step per field (minute, hour,
// day of month, month, day of week).
const MAX_STEP = [60, 24, 31, 12, 7];

function stepsInRange(fields: string[]): boolean {
  return fields.every((field, i) =>
    field.split(',').every((part) => {
      const step = part.split('/')[1];
      if (step === undefined) return true;
      const n = Number(step);
      return Number.isInteger(n) && n >= 1 && n <= MAX_STEP[i]!;
    }),
  );
}

function parse(expression: string, from: Date) {
  const trimmed = expression.trim();
  const fields = trimmed.split(/\s+/);
  const nickname = NICKNAME.test(trimmed);
  if (!nickname && (fields.length !== 5 || !stepsInRange(fields))) {
    throw new InvalidCronError(expression);
  }
  try {
    return CronExpressionParser.parse(trimmed, { currentDate: from, tz: 'UTC' });
  } catch {
    throw new InvalidCronError(expression);
  }
}

// Throws InvalidCronError when the expression is not a valid 5-field cron or @nickname.
export function assertValidCron(expression: string): void {
  parse(expression, new Date());
}

export function isValidCron(expression: string): boolean {
  try {
    assertValidCron(expression);
    return true;
  } catch {
    return false;
  }
}

// The next `count` runs strictly after `from`. Throws InvalidCronError when the expression is
// invalid or has no run left (a date that never comes, e.g. '0 0 31 2 *').
export function nextCronRuns(expression: string, count: number, from: Date = new Date()): Date[] {
  const it = parse(expression, from);
  const runs: Date[] = [];
  try {
    for (let i = 0; i < count; i++) runs.push(it.next().toDate());
  } catch {
    // No run left: whatever was found stands.
  }
  if (runs.length === 0) throw new InvalidCronError(expression);
  return runs;
}

export function nextCronRun(expression: string, from: Date = new Date()): Date {
  return nextCronRuns(expression, 1, from)[0]!;
}

// The next run, or null when the expression is invalid or exhausted (the worker pauses the
// schedule instead of throwing in its loop).
export function tryNextCronRun(expression: string, from: Date = new Date()): Date | null {
  try {
    return nextCronRun(expression, from);
  } catch {
    return null;
  }
}

// The shortest gap, in seconds, between the next runs. A cron fires irregularly
// ('0 0 * * 1,2'), so a single gap would let a burst through.
export function minCronIntervalSeconds(expression: string, from: Date = new Date()): number {
  const runs = nextCronRuns(expression, 5, from);
  if (runs.length < 2) throw new InvalidCronError(expression);
  let shortest = Infinity;
  for (let i = 1; i < runs.length; i++) {
    shortest = Math.min(shortest, (runs[i]!.getTime() - runs[i - 1]!.getTime()) / 1000);
  }
  return shortest;
}
