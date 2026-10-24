import { createHash, timingSafeEqual } from 'node:crypto';
import { webhookCallback } from 'grammy';
import { createDb, getInstanceBotConfig, isInstanceBotUsable } from '@repo/db';
import { createBot } from './bot';

// The Telegram bot as a Cloudflare Worker. Telegram posts every update to
// POST /telegram/webhook/:secret, with the same secret in the
// X-Telegram-Bot-Api-Secret-Token header (scripts/set-webhook.ts registers both). Both
// must match TELEGRAM_WEBHOOK_SECRET before anything is read or sent.
//
// The bot token lives in the database, so the bot is built for each request from the
// instance settings the api writes. Nothing is kept between requests.

export interface Env {
  DB: D1Database;
  // A Worker secret, never in wrangler.jsonc: `wrangler secret put TELEGRAM_WEBHOOK_SECRET`.
  TELEGRAM_WEBHOOK_SECRET: string;
}

export interface WorkerHandler {
  fetch: (request: Request, env: Env) => Promise<Response>;
}

export interface WorkerOptions {
  // Replaces the HTTP client for the Telegram Bot API. Tests use it; production leaves it out.
  telegramFetch?: typeof fetch;
}

const SECRET_HEADER = 'X-Telegram-Bot-Api-Secret-Token';
const WEBHOOK_ROUTE = /^\/telegram\/webhook\/([^/]+)$/;

export function createWorker(options: WorkerOptions = {}): WorkerHandler {
  return {
    async fetch(request, env) {
      const route = WEBHOOK_ROUTE.exec(new URL(request.url).pathname);
      if (!route) return plain(404, 'Not found');
      if (request.method !== 'POST') return plain(405, 'Method not allowed', { Allow: 'POST' });

      // Checked before the database is touched, so a request without the secret reads
      // nothing and learns nothing about the bot.
      const expected = env.TELEGRAM_WEBHOOK_SECRET;
      const pathOk = secretsMatch(route[1], expected);
      const headerOk = secretsMatch(request.headers.get(SECRET_HEADER), expected);
      if (!pathOk || !headerOk) return plain(401, 'Unauthorized');

      const db = createDb(env.DB);
      const config = await getInstanceBotConfig(db);
      if (!isInstanceBotUsable(config)) return plain(503, 'Bot not configured');

      const bot = createBot({ token: config.botToken, db, telegramFetch: options.telegramFetch });
      // grammy compares the header again. The check above is the one that decides; this
      // one only stops the bot from answering a request the route did not accept.
      const handle = webhookCallback(bot, 'cloudflare-mod', { secretToken: expected });
      return handle(request);
    },
  };
}

export default createWorker();

// Both secrets are hashed first, so the comparison always covers 32 bytes and leaks
// nothing about the secret's length. An absent or empty value never matches.
function secretsMatch(given: string | null | undefined, expected: string | undefined): boolean {
  if (!given || !expected) return false;
  return timingSafeEqual(digest(given), digest(expected));
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function plain(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}
