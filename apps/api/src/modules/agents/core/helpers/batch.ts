import type { Db } from '@repo/db';

// One statement of `db.batch([...])`: any drizzle query builder of the D1 client.
export type BatchStatement = Parameters<Db['batch']>[0][number];

// `db.batch` refuses an empty list and wants a tuple type. This takes a plain array, does
// nothing when it is empty, and returns the per-statement results. The statements run in
// one atomic D1 batch: all land or none does.
export async function batchAll(db: Db, statements: BatchStatement[]): Promise<unknown[]> {
  if (statements.length === 0) return [];
  return db.batch(statements as [BatchStatement, ...BatchStatement[]]);
}

// Splits a list into chunks of at most `size`. D1 binds at most 100 parameters per
// statement, so a long `inArray(ids)` or a bulk `.values([...])` has to be cut.
export function chunk<T>(items: readonly T[], size = 90): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
