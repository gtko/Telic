import { env as workerEnv } from 'cloudflare:workers';

// The Worker's bindings, variables and secrets, in one type shared by the fetch handler, the
// cron handler, the queue consumer and the tests. wrangler.jsonc declares the bindings and the
// public variables; the secrets are set with `wrangler secret put` (see the comments there).
// Every variable is optional on purpose: a missing one falls back to a default (or turns a
// feature off) rather than failing the whole Worker.
export interface Env {
  // Bindings.
  DB: D1Database;
  BUCKET: R2Bucket;

  // Public variables (wrangler.jsonc "vars").
  APP_URL?: string;
  API_URL?: string;
  COOKIE_DOMAIN?: string;
  PASSKEY_RP_ID?: string;
  PASSKEY_RP_NAME?: string;
  CLIENT_IP_HEADER?: string;
  TRUSTED_PROXIES?: string;
  SSRF_ALLOWED_HOSTS?: string;
  SSRF_DEV_RELAXED?: string;
  EMAIL_FROM?: string;
  NOTIFICATIONS_EMAIL_FROM?: string;
  GIT_WEBHOOK_BASE_URL?: string;
  NODE_ENV?: string;

  // Secrets (`wrangler secret put`, never in a file).
  BETTER_AUTH_SECRET?: string;
  APP_ENCRYPTION_KEY?: string;
}

// The environment outside a request handler: the plugins that are built once per isolate
// (CORS origins, the OpenAPI description) and the hooks that carry no derived context read
// it here. Handlers get it from the request context (`ctx.env`) instead.
export function getEnv(): Env {
  return workerEnv as unknown as Env;
}

// A string variable with a default, trailing slashes removed (the form every URL is joined in).
export function urlVar(value: string | undefined, fallback: string): string {
  return (value?.trim() || fallback).replace(/\/+$/, '');
}

// The web app's origin: the first entry of the comma-separated APP_URL.
export function appUrlOf(env: Pick<Env, 'APP_URL'>): string {
  return urlVar(env.APP_URL?.split(',')[0], 'http://localhost:3001');
}

export function apiUrlOf(env: Pick<Env, 'API_URL'>): string {
  return urlVar(env.API_URL, 'http://localhost:3000');
}
