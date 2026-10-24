import { Elysia } from 'elysia';
import { env as workerEnv } from 'cloudflare:workers';
import { createAuth } from '@repo/auth';
import { createDb, type Db } from '@repo/db';
import { useR2Bucket } from '@repo/storage';
import type { Env } from '../env';

// The better-auth instance of the isolate. Building one is not free and it holds nothing but
// the binding it was given, so it is made once per D1 binding and shared by the requests the
// isolate serves (a test that rebinds the database gets a fresh one).
const authByBinding = new WeakMap<object, ReturnType<typeof createAuth>>();

function authFor(env: Env, db: Db) {
  let auth = authByBinding.get(env.DB);
  if (!auth) {
    auth = createAuth(env, db);
    authByBinding.set(env.DB, auth);
  }
  return auth;
}

// What every route reads from the Worker instead of a module-level global:
//   ctx.env   the bindings, variables and secrets (see ../env.ts)
//   ctx.db    the Drizzle client over the D1 binding
//   ctx.bucket the R2 bucket for file bytes
//   ctx.auth  the better-auth instance over the same database
// A service takes `db` as its first argument, and a route hands it `ctx.db`. The derive is
// global so a plugin that `.use(requestContext)` (directly, or through authContext) sees the
// three typed, and so do the routes the root app mounts after it (MCP).
export const requestContext = new Elysia({ name: 'request-context' }).derive(
  { as: 'global' },
  () => {
    const env = workerEnv as unknown as Env;
    const db = createDb(env.DB);
    useR2Bucket(env.BUCKET);
    return { env, db, bucket: env.BUCKET, auth: authFor(env, db) };
  },
);

export type RequestContext = {
  request: Request;
  env: Env;
  db: Db;
  auth: ReturnType<typeof createAuth>;
};
