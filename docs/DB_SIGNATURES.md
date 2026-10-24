# Signatures `db`-first (ody-296, zone C)

Convention: `db: Db` is the FIRST parameter of every function that reads the base. Routes take `ctx.db`
(plus `ctx.env`, `ctx.auth`) from `requestContext` (shared/context.ts). `Db` exposes `$client: D1Database`.

## apps/api/src/shared/access.ts (all `(db, ...)`)
- getProjectAccess(db, projectId, userId) / getTeamAccess(db, teamId, userId)
- requireProjectAccess(db, projectKey, user) / requireProjectOwner(db, projectKey, user)
- requireProjectAdmin(db, projectKey, user) / assertProjectAdmin(db, project, user)
- requireProjectPermission(db, projectKey, user, resource, action)
- requireTeamRunsProject(db, projectKey, user) / requireMemberAdmin(db, projectKey, user, resource, action)
- checkMemberAdmin(db, project, user, resource, action) / requireSelfOrMemberAdmin(db, projectKey, targetUserId, user, resource, action)
- mayGrantPermissions(db, project, user, target) / assertGrantablePermissions(db, project, user, target)
- assertPermission(db, projectId, user, resource, action) / checkPermission(db, projectId, user, resource, action)
- assertProjectOwner(db, projectId, user) / assertProjectFeature(db, projectId, feature) / assertProjectWritable(db, projectId, method)
- requireTeamMembership(db, teamId, user) / requireTeamPermission(db, teamId, user, resource, action)
- projectsWithPermission(db, membership, resource, action)
- Unchanged, no db: requireUser, requireGod, assertMcpEnabled, assertFeatureEnabled, assertWritable

## apps/api/src/shared
- getLimits(db, workspaceId) / getTeamLimits(db, teamId); setLimitsProvider((db, workspaceId) => Promise<Limits>)
- getProjectSetting(db, projectId, key) / setProjectSetting(db, projectId, key, value)
- assertMcpAllowed(db, projectId, headers) (guards.ts); entityGuard resolver receives `(params, ctx)` with ctx.db
- requestUser(ctx: RequestContext) (auth-context.ts); RequestContext = { request, env, db, auth }

## Other
- buildMcpServer(db, app, credential, userId) (mcp/server.ts); mountMcp reads db/env/auth from the route context
- syncOidcGroupsAfterCallback(db, auth, response); getCurrentUser(db, account)
- @repo/auth: createAuth(env, db), accountsManagedByScim(db), verifyMcpAccessToken(env, db, token), mcpUnauthorized(env)
- @repo/mailer: SmtpConfig/SmtpAuth are legacy stored-shape types only (no SMTP transport; Resend only)
