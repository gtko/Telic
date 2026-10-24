# @repo/db

Drizzle ORM over Cloudflare D1 (SQLite). Single source of truth for the DB schema.
See `PORTING_NOTES.md` for what the Postgres to D1 move changed and what is still open (ODY-296).
See root `AGENTS.md` for monorepo-wide rules.

## Structure

- `src/client.ts` — the `db` instance (one `postgres()` connection, `prepare: false`).
- `src/schema/auth.ts` — **generated** by better-auth CLI. Do NOT edit by hand;
  regenerate with `bun run auth:generate` in this package (config: `auth.cli.ts`, sqlite).
- `src/schema/app.ts` — hand-written application tables. Add domain tables here.
- `src/schema/index.ts` — re-exports every table; `drizzle.config.ts` points at it.
- `src/permissions.ts` — the permission matrix stored in `team_role.permissions`: the
  resource/action catalog, the default member role, and the normalizer.
- `src/settings.ts` / `src/secrets.ts` — the two instance config stores: `app_setting`
  in plaintext jsonb, `app_secret` encrypted with `APP_ENCRYPTION_KEY`. Both are read
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
- `src/migrate.ts` — programmatic migrator (no drizzle-kit in prod), run by the `migrate` compose service, the api pods' init container, and the api image's CMD. With `BUILD_MIGRATIONS_DIR` set, it applies that folder too, after the core's, under the same lock and backup: a build's own tables, recorded in `drizzle.__build_migrations`.
- `src/wait-for-migrations.ts` — exits once the database holds this release's migrations; the Helm init container of the worker and bot pods.
- `drizzle/` — generated SQL migrations (committed).

## Workflow

1. Edit `schema/app.ts` (or regen `schema/auth.ts`).
2. `bun run db:generate` → new SQL in `drizzle/`.
3. `bun run db:migrate`.

Migrations only — never `drizzle-kit push`. Every schema change goes through a
committed migration in `drizzle/`.

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

`revision` holds one counter per scope � the change markers the clients poll through
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

A new scope kind also needs its entry in `apps/api/src/sync/store.ts` — its name and
the resource a watcher must be allowed to read — and the mirror in
`apps/web/src/utils/revScopes.ts`.

## Conventions

- Explicit snake_case column names (`text("created_at")`) — matches the generated auth schema; no `casing` option.
- FKs use `.references(() => other.id, { onDelete: "cascade" })`.
- `drizzle.config.ts` loads the root `.env` via `dotenv` — needs a valid `DATABASE_URL`.

`0152_agent_execution_state.sql` adds the current execution marker to `agent_run`.
Its trigger bumps `runner-queue:<projectId>` on queue writes. It does not write the
issue scope: the issue run panel watches the user-scoped runner queue marker too,
which avoids introducing a queue/issue revision lock ordering dependency.
