# AGENTS.md

Bun + Turborepo monorepo that runs on Cloudflare: Workers, D1, R2, and Queues. Backend
**Elysia**, frontend **Next.js (SSR)** through OpenNext + **shadcn/ui**, auth **better-auth**,
ORM **Drizzle** over D1 (SQLite). Deployed with `wrangler`.

The most specific `AGENTS.md` for the changed area overrides this file. Every app and some
packages have one. Each `CLAUDE.md` only points to the `AGENTS.md` next to it.

## Editing this file

This file holds only the core rules that an agent needs on most tasks.

- Do not add a fix, a feature description, or a detail that only one area needs. Put it in a
  code comment, in `docs/`, or in the `AGENTS.md` of that app or package.
- Add a rule here only when the user asks.

## Core Coding Principles

- **IMPORTANT — always follow, no exceptions:** KISS and YAGNI. Write the simplest thing that
  works. Add an abstraction only when several concrete implementations need it. No
  overengineering.
- Study the existing code first and follow its sound patterns and conventions. Reuse shared
  modules, components, and utilities. Extend them instead of adding a parallel solution.
- Minimum comments. A comment explains why, the code explains what. Hide the comment and
  read the code: if the code tells the fact, delete the comment.
  - A comment longer than its code is too long.
  - A wrong comment is worse than none. Change or delete a comment in the same edit as its code.
  - Do not copy the comment density of nearby code. This rule wins.
  - Never comment layout or styling: positioning, sticky or overflow behaviour, spacing, why a
    class is set.
  - The full rules and the pass that removes stale comments are in the `tidy` skill.

## When the work is done

Run on the new code, in this order, without being asked:

1. `tidy`
2. `code-review`
3. `security-audit`

Then propose a commit message in chat (format in [Commits](#commits)). Never run
`git commit` or `git push` unless the user asks.

## Writing style (docs, comments, chat)

Applies to all prose: docs, code comments, commit messages, chat replies.

- Write plainly and literally, in short, direct sentences.
- No metaphors, personification, or figurative language. Bad: "the parser is the heart of the
  step", "data lives in Postgres", "self-healing queue", "the ticket flows through the
  pipeline". Good: "the parser is the main task of the step", "data is stored in Postgres",
  "a failed donor is retried on the next run".
- No rhetorical flourishes or drama. Say what a thing does, not how important or elegant it is.
- Standard terms that began as metaphors (watermark, backlog, queue, pipeline) are fine.

**Write the final state, not the edit history.** When the user changes a decision, rewrite
docs and comments to describe only the current design.

- Do not write "not X, but Y", "now in the DB instead of in code", "decided", "moved from a
  separate step", "previously we planned". Write Y.
- Do not explain why a choice replaced an earlier idea from the conversation.
- Allowed: forward-looking rationale ("column `project_key` is added now so steps 3–4 need no
  migration") and cross-references between sections.
- Mention a discarded idea only as a lasting "considered and rejected because…" that a future
  reader would otherwise propose again. State it once, plainly.

## Golden rules

- **Runtime is Cloudflare Workers.** There is no long-running server process, no Docker, and no
  self-hosted deployment. Code runs on `workerd` with `nodejs_compat`. Do not use Bun APIs in
  code that ships to a Worker.
- **Package manager is Bun.** Never npm, yarn, or pnpm. Use `bun install` and `bun run`.
- **All code, comments, and strings are in English.**
- Cross-package imports use the workspace protocol: `"@repo/db": "workspace:*"`. Packages
  export raw `.ts` (see each package's `exports`). Wrangler and Next bundle them. No build step.
- Run tasks from the **repo root** through Turborepo: `bun run dev` / `build` / `typecheck`.
- The pre-commit hook (`lefthook.yml`) runs `eslint --fix` and `prettier --write` on the
  staged files and stages the result again. Never skip it with `--no-verify`.

## Layout

```
apps/api               Elysia on a Worker: better-auth at /api/auth/*, agent runs, cron, run queue   :8787
apps/web               Next.js App Router, SSR on a Worker through OpenNext, shadcn, TanStack Query  :3001
apps/worker            Worker: webhook and notification delivery, imports (cron + queue)
apps/bot               Worker: Telegram bot webhook
packages/db            @repo/db          — Drizzle client for D1, schema, migrations, permission matrix, shared config readers
packages/auth          @repo/auth        — better-auth server instance + instance auth settings
packages/crypto        @repo/crypto      — AES-256-GCM encryption for secrets at rest
packages/storage       @repo/storage     — attachment bytes in R2, used by api and worker
packages/mailer        @repo/mailer      — Resend transport for outbound email
packages/net           @repo/net         — SSRF guard for server-side fetches of a supplied URL
packages/cron          @repo/cron        — the cron expression grammar shared by api and worker
packages/eslint-config @repo/eslint-config — shared ESLint config
scripts/               pg-to-d1 (one-time data migration), codemod-sqlite
docs/                  see Docs below
```

Each Worker has a `wrangler.jsonc` that declares its bindings:

| Worker         | D1 `DB` | R2 `BUCKET` | Queues                                   | Cron                 |
| -------------- | ------- | ----------- | ---------------------------------------- | -------------------- |
| `telic-api`    | yes     | yes         | produces and consumes `telic-agent-runs` | every minute, hourly |
| `telic-worker` | yes     | yes         | produces and consumes `telic-jobs`       | every minute         |
| `telic-bot`    | yes     | no          | none                                     | none                 |
| `telic-web`    | no      | no          | none                                     | none                 |

The database is the D1 database `telic`. The bucket is `telic-attachments`.

Dependency graph: `api → @repo/auth → @repo/db → @repo/crypto`. **The web app never imports
packages directly.** It talks to the API over HTTP (better-auth client + fetch).

## Docs

| Doc                                                                                                 | Read when the task touches                                               |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `docs/development.md`                                                                               | local setup, running tests, deploying                                    |
| `docs/dev/d1-notes.md`                                                                              | SQL, migrations, triggers, D1 limits                                     |
| `docs/migration-data-pg-to-d1.md`                                                                   | `scripts/pg-to-d1`, the one-time data migration                          |
| `docs/PORTING_TESTS_TODO.md`, `docs/DB_SIGNATURES.md`                                               | API tests not yet ported to the Workers suite; `db`-first signatures     |
| `docs/mcp-results.md`                                                                               | the shape of MCP tool results (`structuredContent`)                      |
| `docs/importing-from-linear.md`, `docs/dev/linear-import.md`                                        | the Linear import: user guide, implementation                            |
| `docs/importing-from-plane.md`, `docs/dev/plane-import.md`, `docs/dev/plane-import-source-notes.md` | the Plane import: user guide, implementation, Plane API facts            |
| `docs/dev/revision-engine.md`                                                                       | live updates: scopes, counters, refetch                                  |
| `docs/dev/i18n.md`                                                                                  | interface languages, the language cookie                                 |

## Commands (from root)

| Command                     | Purpose                                                                    |
| --------------------------- | -------------------------------------------------------------------------- |
| `bun run dev`               | api, web, worker and bot locally (turbo; `wrangler dev` for the Workers)   |
| `bun run build`             | build the apps                                                             |
| `bun run typecheck`         | tsc in every workspace member, then at the root                            |
| `bun run lint`              | ESLint across the workspace                                                |
| `bun run format:check`      | Prettier check (CI runs the same)                                          |
| `bun run test`              | `scripts/` tests, then every member's suite, one package at a time         |
| `bun run db:generate`       | generate a D1 migration from the Drizzle schema                            |
| `bun run db:migrate:local`  | apply migrations to the local D1 (`wrangler d1 migrations apply --local`)  |
| `bun run db:migrate:remote` | apply migrations to the deployed D1 (`--remote`)                           |
| `bun run deploy`            | `wrangler deploy` of api, worker and bot, then the web deploy              |
| `bun run auth:generate`     | regenerate better-auth tables → `packages/db/src/schema/auth.ts`           |

One test file: `cd apps/api && bunx vitest run <path>`. Same in every member.

## Tests

Tests use **vitest** on a local Miniflare D1 and `workerd`. They are integration tests, not mocks
of the database.

- `apps/api` has two projects. `workers` runs `tests/**/*.test.ts` inside `workerd` through
  `@cloudflare/vitest-pool-workers`, with the real D1 binding and the baseline applied per file.
  `node` runs `src/**/*.vtest.ts` and `src/**/__tests__/d1/**`, with a Miniflare D1 started by
  the test.
- `apps/worker` has the projects `unit` (`*.test.ts`) and `d1` (`*.vtest.ts`). `apps/bot` and
  `packages/*` run plain `*.test.ts`. `apps/web` uses `bun test`.
- The suites never run in parallel (`--concurrency=1`).

CI (`.github/workflows/ci.yml`) runs on every pull request: `format:check`, `lint`,
`typecheck`, `bun audit`, an app build, and `bun run test` on `ubuntu-latest`. Do not add a
workflow for a job that an existing workflow already runs.

## Configuration

- Bindings and public variables are in each app's `wrangler.jsonc`. Nothing secret goes in it.
- Secrets are set with `wrangler secret put <NAME>`: `BETTER_AUTH_SECRET` and
  `APP_ENCRYPTION_KEY` for the api, `TELEGRAM_WEBHOOK_SECRET` for the bot. Provider credentials
  (Resend, the Telegram token) are stored encrypted in D1 and edited in god mode.
- Local secrets are in `<app>/.dev.vars`, copied from `.dev.vars.example` and git-ignored.
- Add a new variable to the `Env` type of its app. A secret or a local value also goes in
  `.dev.vars.example`. A public value goes in `vars` of `wrangler.jsonc`.
- Never use `NEXT_PUBLIC_*` in `apps/web`: `next build` inlines it into the bundle.

## Deploy

- `.github/workflows/deploy.yml` runs on push to `main`. It applies the D1 migrations
  (`wrangler d1 migrations apply telic --remote`), then deploys the four Workers. It does
  nothing while the `CLOUDFLARE_API_TOKEN` repository secret is unset.
- A deployed database is migrated by wrangler only. Never run `migrateD1` on it.

## Commits

Subject: Conventional Commit, `type(scope): summary`. PRs are squash-merged, so the PR title
becomes the commit subject on `main` (`pr-title.yml` checks it). release-please reads the
subjects to pick the next version and write `CHANGELOG.md`.

Pick the type by what the change gives the user, not by how much code it touches:

- **`feat:` — minor.** A capability that did not exist: a new entity, page, integration, or a
  setting that unlocks behaviour. Use it only for a change that earns a "Highlights" entry.
- **`improvement:` — patch.** A visible change to something that exists: a redesign, a
  reworked layout, a theme, a better interaction. Not a bug fix, not a new capability.
- **`fix:` — patch.** Behaviour that was wrong is now right.
- **Every other type (`perf`, `refactor`, `docs`, `build`, `ci`, `test`, `chore`, `revert`) —
  patch.**

Scope: the name of one app or package (`api`, `web`, `worker`, `bot`, `db`, `auth`, …). No
scope when the change spans several.

While the version is `0.x`, `!` (e.g. `feat!:`) bumps the minor. The major never bumps
automatically. To cut `1.0.0`, add a `Release-As: 1.0.0` footer to the squash commit body.

Release config traps:

- Add a new commit type to both `pr-title.yml` and `changelog-sections` in
  `release-please-config.json`. release-please drops a type that is not in
  `changelog-sections` from the release notes.
- Keep `"package-name": ""` in `release-please-config.json`. Without it, release-please skips
  every release and stops at `There are untagged, merged release PRs outstanding - aborting`.

## Gotchas

- Shared packages have no build step. Their consumers import the source.
- A better-auth config change in `packages/auth` can change its tables. Run
  `bun run auth:generate`, then `bun run db:generate` and `db:migrate:local`.
- D1 has no `db.transaction`, no row locks and at most 100 bound parameters per statement. Read
  `docs/dev/d1-notes.md` before you write SQL.
- A Worker has no process lifetime. Do not start timers or keep state between requests. Work
  that must run later goes through a Queue message or a Cron Trigger.
- `bun --filter` needs the `=` form: `bun --filter='@repo/db' run <script>`. With the space
  form, Bun reads `run` as the script name and fails.
- `packages/db/legacy-pg` and `scripts/pg-to-d1` exist only for the one-time Postgres data
  migration. Do not extend them.
