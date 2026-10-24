import type { Db } from '@repo/db';

// Raw SQL against the D1 binding behind a Db. drizzle 0.45's db.run(sql) fails on D1
// ("reading 'bind'") and db.batch only takes query builders, so a hand-written statement
// (an UPDATE ... RETURNING claim, a conditional INSERT ... SELECT) goes to the binding itself:
// the same atomic unit, with the column names the query chose. The typed Db has no $client
// in drizzle 0.45; the D1 driver sets it at runtime.

// D1 allows 100 bound parameters per statement and 1000 queries per invocation.
export const MAX_PARAMS = 100;

export type SqlValue = string | number | null;

export interface Statement {
  sql: string;
  params?: SqlValue[];
}

export function binding(db: Db): D1Database {
  return (db as unknown as { $client: D1Database }).$client;
}

function prepare(db: Db, s: Statement): D1PreparedStatement {
  return binding(db)
    .prepare(s.sql)
    .bind(...(s.params ?? []));
}

export async function allRows<T>(db: Db, text: string, params: SqlValue[] = []): Promise<T[]> {
  const res = await prepare(db, { sql: text, params }).all<T>();
  return res.results;
}

// Rows changed by one statement.
export async function runChanges(db: Db, text: string, params: SqlValue[] = []): Promise<number> {
  const res = await prepare(db, { sql: text, params }).run();
  return res.meta.changes ?? 0;
}

// Several statements in one atomic batch. Returns the rows changed by each.
export async function runBatch(db: Db, statements: Statement[]): Promise<number[]> {
  if (statements.length === 0) return [];
  const results = await binding(db).batch(statements.map((s) => prepare(db, s)));
  return results.map((r) => r.meta.changes ?? 0);
}

export function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return (value as T) ?? fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

// Like runBatch, but hands back every statement's rows too, so a batch can end with the
// SELECT that reads the id the earlier statements produced.
export async function batchResults(
  db: Db,
  statements: Statement[],
): Promise<{ changes: number; rows: Record<string, unknown>[] }[]> {
  if (statements.length === 0) return [];
  const results = await binding(db).batch<Record<string, unknown>>(
    statements.map((s) => prepare(db, s)),
  );
  return results.map((r) => ({ changes: r.meta.changes ?? 0, rows: r.results }));
}
