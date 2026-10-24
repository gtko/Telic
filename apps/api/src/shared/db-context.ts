import { Elysia } from 'elysia';
import type { Db } from '@repo/db';

// The database of the request, for the routes that read or write it. The app's global
// derive (app.ts) puts `db` on every request's context, built from the D1 binding of
// that request; this plugin gives the handlers its type and fails loudly when the derive
// is missing, instead of reaching for a module-level connection (D1 has none).
export const dbContext = new Elysia({ name: 'db-context' }).resolve(
  { as: 'scoped' },
  (context): { db: Db } => {
    const db = (context as unknown as { db?: Db }).db;
    if (!db) throw new Error('db-context: no database on the request (the app derive is missing)');
    return { db };
  },
);

// The R2 bucket of the request (binding `BUCKET`), put on the context by the same app
// derive as `db`. Only the routes that store or read file bytes use it.
export const bucketContext = new Elysia({ name: 'bucket-context' }).resolve(
  { as: 'scoped' },
  (context): { bucket: R2Bucket } => {
    const bucket = (context as unknown as { bucket?: R2Bucket }).bucket;
    if (!bucket) {
      throw new Error('bucket-context: no bucket on the request (the app derive is missing)');
    }
    return { bucket };
  },
);
