import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from './schema';

// D1 is reached through a binding that exists only inside a request (or a Durable Object),
// so there is no module-level connection: each entry point builds its client from the
// binding it was handed, `createDb(env.DB)`, and passes it down.
export function createDb(binding: D1Database) {
  return drizzle(binding, { schema });
}

// `$client` is the D1 binding the driver was built on; drizzle sets it at runtime, and it is
// what `.batch()` of raw prepared statements needs.
export type Db = DrizzleD1Database<typeof schema> & { $client: D1Database };

// What a function that reads or writes takes. D1 has no interactive transactions: several
// writes that must land together go through `db.batch([...])`, which D1 runs atomically,
// and a read-then-write that must not interleave has to be one statement.
export type DbExecutor = Db;
