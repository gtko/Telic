import { sql, type SQL } from 'drizzle-orm';
import type { Db } from './client';
import type { BatchStatement } from './helpers';

// D1 has no interactive transaction and no row lock: the only atomic unit is
// `db.batch([...])`, a single SQLite transaction in which a failing statement rolls the
// whole list back. A rule of the form "check, then write" is therefore written as a
// guard statement placed first in the batch (this file), or as a predicate inside the
// write itself. Both are evaluated by D1 at the moment the write runs, one writer at a
// time, so two requests racing for the same last owner cannot both pass.

// A statement for `db.batch`: it fails, and with it the whole batch, when `violation`
// holds (a SQL boolean expression), and does nothing otherwise. SQLite's json() raises
// "malformed JSON" on a non-JSON text, which is the only way to abort from plain SQL.
export function abortBatchWhen(db: Db, violation: SQL): BatchStatement {
  return db.run(
    sql`select json(case when ${violation} then 'guard violated' else 'null' end)`,
  ) as unknown as BatchStatement;
}

function messages(err: unknown): string {
  const out: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur; i++) {
    if (cur instanceof Error) {
      out.push(cur.message);
      cur = (cur as { cause?: unknown }).cause;
    } else {
      out.push(String(cur));
      break;
    }
  }
  return out.join(' | ');
}

// Whether a write failed on a UNIQUE or PRIMARY KEY constraint (Postgres code 23505).
export function isUniqueViolation(err: unknown): boolean {
  return /UNIQUE constraint failed/i.test(messages(err));
}

// Whether a batch was aborted by an `abortBatchWhen` guard.
export function isGuardViolation(err: unknown): boolean {
  return /malformed JSON/i.test(messages(err));
}

// Whether a write failed on a FOREIGN KEY constraint (Postgres code 23503).
export function isForeignKeyViolation(err: unknown): boolean {
  return /FOREIGN KEY constraint failed/i.test(messages(err));
}

// The rows a statement changed, from the per-statement result of `db.batch`.
export function rowsChanged(result: unknown): number {
  const r = result as { meta?: { changes?: number }; changes?: number } | undefined;
  return r?.meta?.changes ?? r?.changes ?? 0;
}
