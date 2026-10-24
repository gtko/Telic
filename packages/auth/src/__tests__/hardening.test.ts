// Secret, cookie and rate-limit settings of createAuth, on a local D1 (miniflare).
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/d1/migrator';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@repo/db';
import * as schema from '@repo/db/schema';
import { createAuth, type AuthEnv } from '../index';

const migrationsFolder = fileURLToPath(new URL('../../../db/drizzle-d1', import.meta.url));
const env: AuthEnv = {
  APP_URL: 'https://app.example.com',
  API_URL: 'https://api.example.com',
  BETTER_AUTH_SECRET: 'test-secret-with-more-than-thirty-two-chars',
};

let mf: Miniflare;
let db: Db;

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: 'hardening-test-db' },
  });
  db = createDb((await mf.getD1Database('DB')) as unknown as D1Database);
  await migrate(db, { migrationsFolder });
});

afterAll(async () => {
  await mf.dispose();
});

function post(base: string, path: string, body: unknown, ip: string): Request {
  return new Request(`${base}/api/auth${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, 'cf-connecting-ip': ip },
    body: JSON.stringify(body),
  });
}

describe('BETTER_AUTH_SECRET', () => {
  it.each([undefined, '', 'too-short'])('refuses %j', (secret) => {
    expect(() => createAuth({ ...env, BETTER_AUTH_SECRET: secret }, db)).toThrow(
      'BETTER_AUTH_SECRET',
    );
  });
});

describe('session cookies', () => {
  const signUp = (base: string, e: AuthEnv, email: string) =>
    createAuth(e, db).handler(
      post(
        base,
        '/sign-up/email',
        { email, password: 'correct-horse-battery', name: 'A' },
        `10.9.0.${email.length}`,
      ),
    );

  it('are Secure over https without NODE_ENV, host-prefixed or cross-subdomain', async () => {
    for (const [i, e] of [
      env,
      { ...env, APP_URL: 'https://api.example.com' },
      { ...env, COOKIE_DOMAIN: '.example.com' },
    ].entries()) {
      const res = await signUp(new URL(e.API_URL!).origin, e, `secure${i}@example.com`);
      const cookies = res.headers.getSetCookie();
      expect(cookies.length).toBeGreaterThan(0);
      for (const cookie of cookies) expect(cookie).toMatch(/;\s*Secure/i);
    }
  });

  it('are not Secure on a plain http localhost origin', async () => {
    const local = { ...env, APP_URL: 'http://localhost:3000', API_URL: 'http://localhost:8787' };
    const res = await signUp('http://localhost:8787', local, 'local@example.com');
    const cookies = res.headers.getSetCookie();
    expect(cookies.length).toBeGreaterThan(0);
    for (const cookie of cookies) expect(cookie).not.toMatch(/;\s*Secure/i);
  });
});

describe('rate limit', () => {
  it('answers 429 once a client exceeds the sign-in limit, and keeps the count in the database', async () => {
    const auth = createAuth(env, db);
    const attempt = (ip: string) =>
      auth.handler(
        post(
          'https://api.example.com',
          '/sign-in/email',
          { email: 'x@example.com', password: 'wrong-password-1' },
          ip,
        ),
      );
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await attempt('10.9.1.1')).status);
    expect(statuses.slice(0, 3)).not.toContain(429);
    expect(statuses[3]).toBe(429);
    expect((await attempt('10.9.1.2')).status).not.toBe(429);

    const rows = await db.select().from(schema.rateLimit);
    expect(rows.some((row) => row.key.includes('10.9.1.1') && row.count >= 3)).toBe(true);
  });

  it('counts each client IP separately and ignores a spoofed X-Forwarded-For', async () => {
    const auth = createAuth(env, db);
    const attempt = (ip: string, forwarded?: string) => {
      const req = post(
        'https://api.example.com',
        '/sign-in/email',
        { email: 'z@example.com', password: 'wrong-password-1' },
        ip,
      );
      if (forwarded) req.headers.set('x-forwarded-for', forwarded);
      return auth.handler(req);
    };
    for (let i = 0; i < 4; i++) await attempt('10.9.3.1', `10.9.3.${i + 10}`);
    expect((await attempt('10.9.3.1')).status).toBe(429);
    expect((await attempt('10.9.3.2')).status).not.toBe(429);
  });

  it('is shared by two instances, as two isolates would be', async () => {
    const body = { email: 'y@example.com', password: 'wrong-password-1' };
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const auth = createAuth(env, db);
      statuses.push(
        (await auth.handler(post('https://api.example.com', '/sign-in/email', body, '10.9.2.1')))
          .status,
      );
    }
    expect(statuses[3]).toBe(429);
  });
});
