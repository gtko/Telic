# Porting tests to the Workers suite

Files listed in `apps/api/tests/porting-excluded.json` are ported to `apps/api/tests/**` but excluded from
the vitest `workers` project (and from the tsconfig) until they are green. Port one by passing `db` as the
first argument of service calls, typing the rows read, removing Bun APIs, then delete it from the list.

Status: 73 files excluded. High priority covers security and permissions.

| File | Reason | Priority |
| --- | --- | --- |
| `tests/api-keys.test.ts` | ported with explicit db but still red or not typechecking; needs `db, ` as first service argument and typed rows | high |
| `tests/auth-extensions.test.ts` | ported with explicit db but still red or not typechecking; needs `db, ` as first service argument and typed rows | high |
| `tests/auth-urls.test.ts` | ported with explicit db but still red or not typechecking; needs `db, ` as first service argument and typed rows | high |
| `tests/csrf-origin.test.ts` | ported with explicit db but still red or not typechecking; needs `db, ` as first service argument and typed rows | high |
| `tests/email-domains.test.ts` | ported with explicit db but still red or not typechecking; needs `db, ` as first service argument and typed rows | high |
| `tests/host-cookie.test.ts` | uses the Bun global (Bun.CookieMap) | high |
| `tests/magic-link.test.ts` | ported with explicit db but still red or not typechecking; needs `db, ` as first service argument and typed rows | high |
| `tests/mcp/attachments.test.ts` | ported with explicit db but still red or not typechecking; needs `db, ` as first service argument and typed rows | high |
| `tests/mcp/discovery-public-url.test.ts` | uses Bun.serve / the Bun global | high |
| `tests/mcp/mcp-auth.test.ts` | ported with explicit db but still red or not typechecking; needs `db, ` as first service argument and typed rows | high |
| `tests/mcp/mcp-teams.test.ts` | ported with explicit db but still red or not typechecking; needs `db, ` as first service argument and typed rows | high |
| `tests/mcp/structured-results.test.ts` | ported with explicit db but still red or not typechecking; needs `db, ` as first service argument and typed rows | high |
| `tests/mcp/team-projects.test.ts` | ported with explicit db but still red or not typechecking; needs `db, ` as first service argument and typed rows | high |
| `tests/modules/current-user/current-user.test.ts` | ported with explicit db but still red or not typechecking; needs `db, ` as first service argument and typed rows | high |
| `tests/modules/god/god-deactivate.test.ts` | ported with explicit db but still red or not typechecking; needs `db, ` as first service argument and typed rows | high |
| `tests/modules/god/god-email-oauth.test.ts` | ported with explicit db but still red or not typechecking; needs `db, ` as first service argument and typed rows | high |
| `tests/modules/god/god-email-verification.test.ts` | ported with explicit db but still red or not typechecking; needs `db, ` as first service argument and typed rows | high |
| `tests/modules/god/god-email.test.ts` | ported with explicit db but still red or not typechecking; needs `db, ` as first service argument and typed rows | high |
| `tests/modules/god/god-oidc.test.ts` | ported with explicit db but still red or not typechecking; needs `db, ` as first service argument and typed rows | high |
| `tests/modules/god/god-project-defaults.test.ts` | ported with explicit db but still red or not typechecking; needs `db, ` as first service argument and typed rows | high |
| `tests/modules/god/god-projects.test.ts` | ported with explicit db but still red or not typechecking; needs `db, ` as first service argument and typed rows | high |
| `tests/modules/god/god-teams.test.ts` | ported with explicit db but still red or not typechecking; needs `db, ` as first service argument and typed rows | high |
| `tests/modules/god/god-updates.test.ts` | ported with explicit db but still red or not typechecking; needs `db, ` as first service argument and typed rows | high |
| `tests/modules/god/god-users.test.ts` | ported with explicit db but still red or not typechecking; needs `db, ` as first service argument and typed rows | high |
| `tests/modules/invites/invite-expiry.test.ts` | ported with explicit db but still red or not typechecking; needs `db, ` as first service argument and typed rows | high |
| `tests/modules/invites/invites.test.ts` | a describe starts Bun.serve in beforeAll (SMTP stub) | high |
| `tests/modules/invites/received-invites.test.ts` | a describe starts Bun.serve in beforeAll (SMTP stub) | high |
| `tests/modules/members/role-escalation.test.ts` | ported with explicit db but still red or not typechecking; needs `db, ` as first service argument and typed rows | high |
| `tests/modules/scim/scim-discovery.test.ts` | ported with explicit db but still red or not typechecking; needs `db, ` as first service argument and typed rows | high |
| `tests/modules/scim/scim-reconcile.test.ts` | 6 groups-sync assertions red after the D1 port (group rows not created) | high |
| `tests/modules/share/share.test.ts` | 5 tests read a null public scaffold (share link rows) | high |
| `tests/modules/teams/teams.test.ts` | ported with explicit db but still red or not typechecking; needs `db, ` as first service argument and typed rows | high |
| `tests/modules/teams/workspace.test.ts` | ported with explicit db but still red or not typechecking; needs `db, ` as first service argument and typed rows | high |
| `tests/modules/workspaces/workspaces.test.ts` | ported with explicit db but still red or not typechecking; needs `db, ` as first service argument and typed rows | high |
| `tests/oauth-token-encryption.test.ts` | ported with explicit db but still red or not typechecking; needs `db, ` as first service argument and typed rows | high |
| `tests/oidc-account-linking.test.ts` | ported with explicit db but still red or not typechecking; needs `db, ` as first service argument and typed rows | high |
| `tests/password-reset.test.ts` | ported with explicit db but still red or not typechecking; needs `db, ` as first service argument and typed rows | high |
| `tests/registration-refusal-redirect.test.ts` | ported with explicit db but still red or not typechecking; needs `db, ` as first service argument and typed rows | high |
| `tests/usernames.test.ts` | ported with explicit db but still red or not typechecking; needs `db, ` as first service argument and typed rows | high |
| `tests/invite-forms.test.ts` | ported with explicit db but still red or not typechecking; needs `db, ` as first service argument and typed rows | medium |
| `tests/modules/connected-apps/connected-apps.test.ts` | ported with explicit db but still red or not typechecking; needs `db, ` as first service argument and typed rows | medium |
| `tests/modules/git/git-managed-webhooks.test.ts` | ported with explicit db but still red or not typechecking; needs `db, ` as first service argument and typed rows | medium |
| `tests/modules/initiatives/initiatives.test.ts` | ported with explicit db but still red or not typechecking; needs `db, ` as first service argument and typed rows | medium |
| `tests/modules/issues/auto-archive.test.ts` | ported with explicit db but still red or not typechecking; needs `db, ` as first service argument and typed rows | medium |
| `tests/modules/link-previews/unit/metadata.test.ts` | HTMLRewriter rejects the test Response (needs a workerd-native Response) | medium |
| `tests/modules/projects/discovery.test.ts` | ported with explicit db but still red or not typechecking; needs `db, ` as first service argument and typed rows | medium |
| `tests/modules/projects/personal-preferences.test.ts` | ported with explicit db but still red or not typechecking; needs `db, ` as first service argument and typed rows | medium |
| `tests/modules/settings/whats-new.test.ts` | ported with explicit db but still red or not typechecking; needs `db, ` as first service argument and typed rows | medium |
| `tests/modules/telegram/telegram.test.ts` | ported with explicit db but still red or not typechecking; needs `db, ` as first service argument and typed rows | medium |

## Not ported yet

- Old `apps/api/src/mcp/__tests__/integration/*.test.ts` on `main` (attachments, client-registration,
  discovery-public-url, mcp-auth, mcp-teams, oauth, structured-results, team-projects) and
  `apps/api/src/mcp/__tests__/unit/*.test.ts` live in `tests/mcp/`; the ones above are excluded.
- `apps/api/src/modules/current-user/__tests__/integration/current-user.test.ts`: port is excluded
  (`tests/modules/current-user/current-user.test.ts`).

## Skipped tests

- `tests/modules/chat-attachments/chat-attachments.test.ts`: two PDF tests (`text.pdf`, `scanned.pdf`) are
  `it.skip`: workerd cannot `readFileSync` the fixtures in `src/modules/chat-attachments/__tests__/fixtures/`.
