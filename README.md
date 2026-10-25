<div align="center">

<img src="assets/banner.png" alt="Telic — open-source project management and issue tracking on Cloudflare" width="100%" />

### Project management and issue tracking on Cloudflare

[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![CI](https://github.com/gtko/Telic/actions/workflows/ci.yml/badge.svg)](https://github.com/gtko/Telic/actions/workflows/ci.yml)

</div>

Everything is available over the REST API, webhooks, and an MCP server.

## Architecture

The application runs on Cloudflare only: Workers, D1, R2, and Queues.

| Worker         | Role                                                        | Bindings                                       |
| -------------- | ----------------------------------------------------------- | ---------------------------------------------- |
| `telic-api`    | Elysia API, better-auth, MCP server, cron jobs              | D1 `DB`, R2 `BUCKET`                         |
| `telic-worker` | webhook and notification delivery, imports                  | D1 `DB`, R2 `BUCKET`, Queue `telic-jobs`       |
| `telic-bot`    | Telegram bot webhook                                        | D1 `DB`                                        |
| `telic-web`    | Next.js (SSR) through OpenNext, shadcn/ui, TanStack Query   | none                                           |

Data is in the D1 database `telic`. Attachments are in the R2 bucket `telic-attachments`. The monorepo
uses Bun and Turborepo. `AGENTS.md` describes the layout and the rules.

## Local development

Requirements: [Bun](https://bun.sh) and Git.

```bash
bun install
cp apps/api/.dev.vars.example apps/api/.dev.vars   # then set BETTER_AUTH_SECRET and APP_ENCRYPTION_KEY
cp apps/web/.dev.vars.example apps/web/.dev.vars
bun run db:migrate:local
bun run dev    # web on :3001, api on :8787, with wrangler dev and a local D1
```

See [docs/development.md](docs/development.md).

## Tests

```bash
bun run test        # vitest on a local D1 and workerd, bun test for web
bun run typecheck
bun run lint
```

## Deploy

Pushes to `main` run `.github/workflows/deploy.yml`. It applies the D1 migrations
(`wrangler d1 migrations apply telic --remote`), then deploys the four Workers. By hand:

```bash
export CLOUDFLARE_API_TOKEN=...
bun run db:migrate:remote
bun run deploy
```

## Secrets

Set secrets with `wrangler secret put <NAME>` in the app folder. Never commit them.

| Worker         | Secrets                                         |
| -------------- | ----------------------------------------------- |
| `telic-api`    | `BETTER_AUTH_SECRET`, `APP_ENCRYPTION_KEY`      |
| `telic-worker` | `APP_ENCRYPTION_KEY` (same value as the api)    |
| `telic-bot`    | `TELEGRAM_WEBHOOK_SECRET`, `APP_ENCRYPTION_KEY` |

The CI deploy uses the `CLOUDFLARE_API_TOKEN` repository secret. Provider credentials (Resend, Telegram
token) are stored encrypted in D1 and edited in god mode.

## More

- [Local development](docs/development.md) · [D1 notes](docs/dev/d1-notes.md)
- [Contributing](CONTRIBUTING.md) · [Code of Conduct](CODE_OF_CONDUCT.md) · [Security](SECURITY.md)

## License

Copyright © 2026 Andrii Poluosmak. [AGPL-3.0](LICENSE).
