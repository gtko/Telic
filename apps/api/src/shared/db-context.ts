import { Elysia } from 'elysia';
import type { Db } from '@repo/db';

// D1 is reached through a binding that exists only inside a request, so there is no
// global `db`: the entry point (the Worker's fetch handler, or a test harness) installs a
// provider, and this plugin puts the resulting client on every route context as `db`.
// Services take it as their first argument.
let provider: ((request: Request) => Db) | null = null;

export function setDbProvider(fn: ((request: Request) => Db) | null): void {
  provider = fn;
}

export const dbContext = new Elysia({ name: 'db-context' }).derive(
  { as: 'global' },
  ({ request }): { db: Db } => {
    if (!provider) throw new Error('No database provider installed (setDbProvider)');
    return { db: provider(request) };
  },
);
