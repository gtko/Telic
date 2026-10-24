import { env } from 'cloudflare:workers';
import { createDb, workspaceManager } from '@repo/db';
import { and, eq } from 'drizzle-orm';
import { insertOwnedTeam } from '#modules/teams/service';
import { app } from './app';

export interface TestUser {
  // The session cookie header to pass to authenticated requests, e.g.
  // authedApi(cookie) or a per-call { headers: { cookie } }.
  cookie: string;
  userId: string;
  email: string;
  // The handle the sign-up hook derived from the address, which is how a test
  // mentions this user.
  username: string;
  // The workspace sign-up gave the account, or null when it got none.
  workspaceId: number | null;
}

let counter = 0;

// Registers a new user through the better-auth route of the app and returns their session
// cookie (autoSignIn is on). Each call uses a unique email. Sign-up creates no team, so the
// user is given one named after its username, in its own workspace, unless `team` is false.
// The first user of an empty database becomes "god".
export async function signUpTestUser(
  overrides: { email?: string; password?: string; name?: string; team?: boolean } = {},
): Promise<TestUser> {
  counter += 1;
  const email = overrides.email ?? `test-user-${counter}@example.com`;
  const password = overrides.password ?? 'test-password-123';
  const name = overrides.name ?? `Test User ${counter}`;

  const response = await app.handle(
    new Request('http://localhost/api/auth/sign-up/email', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost:3001',
        // The rate limit is per client address; each test user is a different client.
        'x-forwarded-for': `10.${(counter >> 16) & 255}.${(counter >> 8) & 255}.${counter & 255}`,
      },
      body: JSON.stringify({ email, password, name }),
    }),
  );
  const setCookies = response.headers.getSetCookie();
  if (setCookies.length === 0) {
    throw new Error(
      `signUpTestUser: no Set-Cookie for ${email} (status ${response.status}: ${await response.clone().text()})`,
    );
  }
  const cookie = setCookies.map((c) => c.split(';')[0]).join('; ');

  const body = (await response.json()) as { user?: { id?: string; username?: string } };
  const userId = body.user?.id;
  if (!userId) throw new Error(`signUpTestUser: no user id returned for ${email}`);
  const username = body.user?.username;
  if (!username) throw new Error(`signUpTestUser: no username returned for ${email}`);
  const db = createDb(env.DB);
  const [own] = await db
    .select({ workspaceId: workspaceManager.workspaceId })
    .from(workspaceManager)
    .where(and(eq(workspaceManager.userId, userId), eq(workspaceManager.role, 'owner')));
  const workspaceId = own?.workspaceId ?? null;
  if (overrides.team !== false) {
    if (workspaceId === null) {
      throw new Error(`signUpTestUser: ${email} has no workspace for a team; pass team: false`);
    }
    await insertOwnedTeam(db, workspaceId, username, userId);
  }
  return { cookie, userId, email, username, workspaceId };
}
