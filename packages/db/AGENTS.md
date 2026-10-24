# @repo/db

Drizzle ORM over Cloudflare D1 (SQLite). Single source of truth for the DB schema.
See `docs/dev/d1-notes.md` for column types, transactions, triggers, limits and the migration workflow.
See root `AGENTS.md` for monorepo-wide rules.

## Structure

- `src/client.ts` — `createDb(env.DB)`, the Drizzle client over a D1 binding.
- `src/schema/auth.ts` — **generated** by better-auth CLI. Do NOT edit by hand;
  regenerate with `bun run auth:generate` in this package (config: `auth.cli.ts`, sqlite).
- `src/schema/app.ts` — hand-written application tables. Add domain tables here.
- `src/schema/index.ts` — re-exports every table; `drizzle.config.ts` points at it.
- `src/permissions.ts` — the permission matrix stored in `team_role.permissions`: the
  resource/action catalog, the default member role, and the normalizer.
- `src/settings.ts` / `src/secrets.ts` — the two instance config stores: `app_setting`
  in plaintext JSON, `app_secret` encrypted with `APP_ENCRYPTION_KEY`. Both are read
  by more than one app, which is why they are here.
- `src/domains/` — one module per stored config that more than one process reads: its
  shape, its defaults and the reader that decrypts it. Only that. The write side, the
  redacted view an HTTP client gets, the validation and anything else specific to one
  caller stay with that caller — the api's settings routes, or god mode in
  `@repo/auth`. A config only one process reads does not belong here at all.
  Currently: the instance Telegram bot (api, bot, worker), the instance mail provider
  (`@repo/auth`, api, worker), a team's notification providers (api, worker), and the
  instance's upload limits and project-storage-quota accounting (api, worker — an
  imported attachment is checked against the same limits an interactive upload is).
- `src/migrate.ts` — `migrateD1(db)`, a helper that applies `drizzle-d1/` to a throwaway local
  database (tests, scripts). Not exported from the package index.
- `drizzle-d1/` — SQL migrations (committed), including the hand-written triggers and seed.
- `legacy-pg/` — the Postgres migrations of the previous deployment. Never run. They document
  the source schema for `scripts/pg-to-d1`.

## Workflow

1. Edit `schema/app.ts` (or regen `schema/auth.ts`).
2. `bun run db:generate` → new SQL in `drizzle-d1/`.
3. `bun run db:migrate:local`.

Migrations only — never `drizzle-kit push`. A deployed D1 is migrated by
`wrangler d1 migrations apply` only; see `docs/dev/d1-notes.md`.

## Team-owned agents

An AI agent is a row in `ai_agent` with a `team_id` and a `user_id`: the team that owns
it, and the bot user it acts as. The team is the boundary — there is no instance-level
agent and no flag on `user` marking a non-human identity, so anything that has to
enumerate agents does it through `ai_agent`.

What the team owns with it: `agent_skill`, `agent_tool` and `integration_credential`
all carry a `team_id` and are shared by every project of the team. `agent_schedule` and
`agent_run` carry a `project_id` — a run happens in one project.

The projects an agent works in are its bot user's `project_member` rows, the same as for
a person, and the `role_id` on each of them is what its requests are checked against —
per project, so one agent can hold different roles in two of them. Its rights in a
project are the intersection of that role and the actions in `ai_agent.tools`.
`team_member.role` takes a fourth value, `'agent'`, so an agent stands in the team
without being a person in it.

`ai_agent_team_username_uq` makes the mention handle unique per team, not per project.

## Revision engine

`revision` holds one counter per scope — the change markers the clients poll through
`GET /sync/rev`. Nothing in the application writes them: the triggers in
`drizzle-d1/0001_triggers.sql` do (hand-written SQLite, ported from the Postgres
migrations 0070 to 0152), so a write moves the marker whichever process it came from.
SQLite triggers are per operation, so a logical trigger `x` is `x_i`, `x_u`, `x_d`.
There are no functions: a bump is the inline `INSERT INTO revision ... SELECT ... WHERE ...
ON CONFLICT (scope) DO UPDATE SET rev = rev + 1`. An issue moved to another project bumps
the board of both projects, and its `issue:` scope row takes the new project id.

To make a new table move an existing scope, copy the three `issue_label_rev_*` triggers
in a new hand-written migration (`drizzle-kit generate --custom --name=...`) and change
the table, the issue id column and whether the board is bumped (`board`) or only the issue
screen (`detail`: leave the `board:` statement out). Then add the logical name to
`EXPECTED` and bump `EXPECTED_PHYSICAL` in `src/__tests__/triggers.test.ts`.

drizzle-kit drops a table's triggers when it rebuilds the table: a migration that does so
must re-create them (the inventory test fails otherwise). Never run `migrateD1` and
`wrangler d1 migrations apply` on the same database. `app.document_rebalance` and
`app.document_checkpoint` are rows of `trigger_flag`: insert the row in the same
`db.batch` as the writes it governs and delete it as the batch's last statement.

A new scope kind also needs its entry in `apps/api/src/modules/sync/service.ts` — its name and
the resource a watcher must be allowed to read — and the mirror in
`apps/web/src/utils/revScopes.ts`.

## Conventions

- Explicit snake_case column names (`text("created_at")`) — matches the generated auth schema; no `casing` option.
- FKs use `.references(() => other.id, { onDelete: "cascade" })`.
- `drizzle.config.ts` uses the `sqlite` dialect and needs no connection.

`0152_agent_execution_state.sql` adds the current execution marker to `agent_run`.
Its trigger bumps `runner-queue:<projectId>` on queue writes. It does not write the
issue scope: the issue run panel watches the user-scoped runner queue marker too,
which avoids introducing a queue/issue revision lock ordering dependency.
