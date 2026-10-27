# Local development

Requirements: [Bun](https://bun.sh) 1.4+ and Git. Wrangler is a dev dependency; no Docker is needed.

## Setup

```bash
git clone https://github.com/gtko/Telic.git
cd Telic
bun install
cp apps/api/.dev.vars.example apps/api/.dev.vars   # fill in BETTER_AUTH_SECRET and APP_ENCRYPTION_KEY
cp apps/web/.dev.vars.example apps/web/.dev.vars
bun run db:migrate:local
bun run dev
```

`bun run dev` runs the workspace through Turborepo: web on <http://localhost:3001> (`next dev`), and the
api, worker and bot with `wrangler dev` on the local Miniflare D1 and R2. The api listens on
<http://localhost:8787>. Local state is stored in each app's `.wrangler/` folder.

## Configuration

Bindings and public variables are in each app's `wrangler.jsonc`. Secrets for local runs are in the
git-ignored `<app>/.dev.vars`, copied from `.dev.vars.example`. Deployed secrets are set with
`wrangler secret put`.

## Commands

Run everything from the repository root through Turborepo. Use `bun`, never npm, yarn, or pnpm.

| Command                     | Purpose                                         |
| --------------------------- | ----------------------------------------------- |
| `bun run dev`               | all apps locally                                |
| `bun run typecheck`         | `tsc --noEmit` across the workspace             |
| `bun run lint`              | ESLint                                          |
| `bun run format`            | Prettier, writes                                |
| `bun run db:generate`       | generate a migration from the Drizzle schema    |
| `bun run db:migrate:local`  | apply migrations to the local D1                |
| `bun run db:migrate:remote` | apply migrations to the deployed D1             |
| `bun run test`              | all test suites                                 |
| `bun run deploy`            | deploy the five Workers                         |

## Tests

```bash
bun run test
```

The suites use vitest on a local Miniflare D1 and `workerd`; they need no external service. `apps/api` has
the projects `workers` and `node`, `apps/worker` the projects `unit` and `d1`. One file:
`cd apps/api && bunx vitest run <path>`. `apps/api/AGENTS.md` explains how to write a test. CI runs the same
command on `ubuntu-latest`.

## Deploy

Pushes to `main` run `.github/workflows/deploy.yml`: it applies the D1 migrations and deploys the Workers.
It needs the `CLOUDFLARE_API_TOKEN` repository secret (Workers Scripts, D1, Queues and R2 edit
permissions). To deploy by hand, set `CLOUDFLARE_API_TOKEN` and run `bun run db:migrate:remote`, then
`bun run deploy`. First-time setup creates the D1 database `telic`, the R2 bucket `telic-attachments` and
the queues `telic-agent-runs`, `telic-agent-runs-dlq` and `telic-jobs`.

`apps/site` deploys the `telic-site` Worker. It serves `apps/site/public/` as static assets only, with no code
and no bindings. `bun run deploy` deploys it with the other Workers.

The mechanisms that span several apps — the revision engine, the interface languages, the D1 specifics —
are described in [`docs/dev/`](dev/).
