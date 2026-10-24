# bot — rules

Telegram bot: a Cloudflare Worker (`telic-bot`) that receives Telegram webhook updates for the
instance bot with grammY. Its only job today is completing account links (`/start <code>`). See
root `AGENTS.md`.

## Invariants

- **The bot talks to D1 and Telegram, and to nothing else.** Its queries are in `src/db.ts`,
  over the schema of `@repo/db`, through the `DB` binding. It holds no api credential and makes
  no call to the api, so a secret that never crosses the network cannot be read off it.
- **The bot settings row is the api's.** The api writes `telegram.bot` in `app_secret`; the bot
  reads it through `@repo/db` (`domains/telegram-bot.ts`), which is also where a new field on
  that config goes. The secret `APP_ENCRYPTION_KEY` decrypts it.
- **The webhook secret is checked first.** `POST /telegram/webhook/:secret` must carry the same
  value in the path and in the `X-Telegram-Bot-Api-Secret-Token` header, equal to the Worker
  secret `TELEGRAM_WEBHOOK_SECRET`. Nothing is read from D1 before both match.
- **The token is not env configuration.** It is stored in the database and edited in god mode.
  The bot is built for each request from the stored settings, so a new bot works without a
  redeploy. Nothing is kept between requests.
- **An error must not fail the update.** `bot.catch` swallows update failures so Telegram does
  not redeliver the same update.

## Config

Bindings: `DB` (D1). Secrets: `TELEGRAM_WEBHOOK_SECRET` and `APP_ENCRYPTION_KEY`
(`wrangler secret put`). `scripts/set-webhook.ts` registers the webhook URL and the secret
with Telegram.

## Growing it

Commands beyond `/start` go in `bot.ts`, the queries they need in `db.ts`.

## Tests

`vitest run`. `src/db.test.ts` covers redeeming a `/start` code against a Miniflare D1 with the
migrations applied. It inserts the pending rows the api mints in production; there is no api to
call. The worker handler is tested with an injected `telegramFetch`.

## Run

- Dev: `bun run dev` at the repo root runs `wrangler dev` alongside the other apps.
- Prod: `wrangler deploy`, done by `.github/workflows/deploy.yml`.
