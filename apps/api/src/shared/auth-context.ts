import { Elysia } from 'elysia';
import type { Db } from '@repo/db';
import { user as users } from '@repo/db/schema';
import { eq } from 'drizzle-orm';
import {
  ensurePersonalWorkspace,
  getSessionFromHeaders,
  isAccountDeactivated,
  verifyMcpAccessToken,
  type Session,
} from '@repo/auth';
import { HttpError } from './lib';
import { getMcpOAuthToken } from './mcp-request';
import { requestContext, type RequestContext } from './context';

// GET routes that need no session. The raw attachment and avatar bytes routes
// must work in <img>/<video> and external fetches. The invite lookup
// (`GET /invites/:token`) renders the accept screen for a logged-out invitee, who
// signs up from there; only accept/reject (POST) require a session. Every `/share/`
// GET renders a public read-only shared issue or view, keyed by an unguessable
// token. All ids are unguessable.
const PUBLIC_GET =
  /^\/attachments\/[^/]+\/raw$|^\/initiative-attachments\/[^/]+\/raw$|^\/avatars\/[^/]+\/raw$|^\/invites\/[^/]+$|^\/share\//;

// The authenticated user carried on the request context.
export type SessionUser = Session['user'];

// Session plugin shared by the planner. Resolves the better-auth session once and
// puts `user` on the context, so handlers and the access guards read it instead
// of calling getSession again. A missing session is a 401, except on the public
// raw-attachment route, which carries no user.
//
// planner.ts uses this as the runtime backstop, so every planner route is
// session-gated. A feature also uses it directly when its handlers or local
// macros reference `user`, which is what makes the `user` type flow there. The
// plugin is named, so its resolve runs once per request (dedup).
//
// A deactivated account is refused here as well as at sign-in: deactivation arrives
// over SCIM while sessions and API keys are already open, and this is the one place
// every planner route and the MCP surface pass through.
export const authContext = new Elysia({ name: 'auth-context' })
  .use(requestContext)
  .resolve({ as: 'scoped' }, async (ctx): Promise<{ user: SessionUser | null }> => {
    const { request, path } = ctx;
    const user = await requestUser(ctx);
    if (user) return { user: await signedIn(ctx.db, user) };
    // The public raw-attachment route has no session and needs none.
    if (request.method === 'GET' && PUBLIC_GET.test(path)) return { user: null };
    throw new HttpError(401, 'Authentication required');
  });

// The account the request's credentials belong to: a session or an API key, or the MCP
// OAuth token of a tool call, which reaches the route beside the request rather than in
// its headers. Whether the account may act is left to the caller.
export async function requestUser({
  request,
  env,
  db,
  auth,
}: RequestContext): Promise<SessionUser | null> {
  const session = await getSessionFromHeaders(auth, request.headers);
  if (session) return session.user;
  const mcpToken = getMcpOAuthToken(request);
  const mcpUserId = mcpToken ? await verifyMcpAccessToken(env, db, mcpToken) : null;
  if (!mcpUserId) return null;
  const user = await db.query.user.findFirst({ where: eq(users.id, mcpUserId) });
  return (user as SessionUser | undefined) ?? null;
}

// A deactivated account goes no further. Any other gets its personal workspace here when
// it has none yet, so one made before personal workspaces, by SCIM or while they were off
// has it on its next request instead of its next sign-in.
async function signedIn(db: Db, user: SessionUser): Promise<SessionUser> {
  if (isAccountDeactivated(user)) throw new HttpError(401, 'This account is deactivated');
  await ensurePersonalWorkspace(db, user);
  return user;
}
