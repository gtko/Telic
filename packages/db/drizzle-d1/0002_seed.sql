-- Rows every installation needs, applied by `wrangler d1 migrations apply` and by migrateD1.
-- INSERT OR IGNORE: re-running, or a row an admin already edited in god mode, is left alone.
--
-- app_setting 'storage' (legacy-pg 0046): the instance upload limits. Keep in sync with
-- defaultStorageSettings() in src/domains/storage.ts, which still applies them in memory if the
-- row is missing. The other legacy app_setting row, 'migration.teams' (0119), is a one-off record
-- of a data migration and belongs to the L8 data-migration script, not to a fresh install.
--
-- Nothing else is seeded on purpose:
--   * team_role / project_role defaults are per team: teams/service.ts creates the "Member"
--     default role with the team (insert(teamRole) next to the team insert), so a fresh D1 has
--     none to seed.
--   * model_price rows are per-workspace overrides (legacy 0147). 0150 only moved a shared
--     workspace's rows to the workspaces its teams moved to, and 0155 copied an existing
--     provider id; neither carries literal prices. Built-in prices live in code
--     (apps/api model-pricing), so createWorkspace has nothing to seed.
INSERT OR IGNORE INTO app_setting (key, value)
VALUES (
  'storage',
  '{"maxAttachmentMb":25,"maxAvatarMb":5,"projectQuotaMb":51200,"attachmentMimeTypes":["image/*","video/*","application/pdf","text/plain","text/csv","text/markdown","application/msword","application/vnd.openxmlformats-officedocument.wordprocessingml.document","application/vnd.oasis.opendocument.text","application/vnd.ms-excel","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","application/vnd.oasis.opendocument.spreadsheet","application/vnd.ms-powerpoint","application/vnd.openxmlformats-officedocument.presentationml.presentation","application/vnd.oasis.opendocument.presentation"]}'
);
