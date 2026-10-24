// Registers the instance bot's webhook with Telegram: the Worker's public origin, the
// route, and the secret Telegram must send back in X-Telegram-Bot-Api-Secret-Token.
// Run it once per deployment, and again whenever the secret changes.
//
// Every value comes from the environment; none is written in this file:
//   TELEGRAM_BOT_TOKEN       the bot token (copied from god mode; the Worker reads its own from the database)
//   TELEGRAM_WEBHOOK_SECRET  the same value as the Worker secret TELEGRAM_WEBHOOK_SECRET
//   WEBHOOK_BASE_URL         the public https origin of the Worker, e.g. https://bot.example.com
//
// Usage: bun run apps/bot/scripts/set-webhook.ts
import { Api } from 'grammy';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const token = required('TELEGRAM_BOT_TOKEN');
const secret = required('TELEGRAM_WEBHOOK_SECRET');
const base = new URL(required('WEBHOOK_BASE_URL'));

// Telegram accepts a secret token of 1 to 256 characters from this set.
if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
  throw new Error('TELEGRAM_WEBHOOK_SECRET must be 1 to 256 characters of A-Z, a-z, 0-9, _ or -');
}
if (base.protocol !== 'https:') {
  throw new Error('WEBHOOK_BASE_URL must be an https URL');
}

// Only the origin is used: the webhook route sits at the root of the Worker.
const url = `${base.origin}/telegram/webhook/${secret}`;

// Only the updates the bot acts on, so Telegram does not queue the others.
await new Api(token).setWebhook(url, {
  secret_token: secret,
  allowed_updates: ['message'],
});

// The URL carries the secret, so it is not printed.
console.log(`[set-webhook] webhook registered for ${base.origin}`);
