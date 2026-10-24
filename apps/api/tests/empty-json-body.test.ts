import { describe, it, expect } from 'vitest';
import { app } from '../src/app';
import { signUpTestUser } from './helpers/auth';

// Elysia's dynamic handler (aot: false) must treat a JSON request with an empty body as an empty
// object, and an absent optional body as valid.
describe('empty request bodies', () => {
  const url = 'http://localhost/settings/whats-new/seen';
  const json = { 'content-type': 'application/json' };

  it('accepts a JSON content type with an empty body', async () => {
    const user = await signUpTestUser();

    const anonymous = await app.handle(new Request(url, { method: 'POST', headers: json }));
    expect(anonymous.status).toBe(401);

    const res = await app.handle(
      new Request(url, { method: 'POST', headers: { ...json, cookie: user.cookie } }),
    );
    expect(res.status).toBe(200);
  });

  it('accepts a bodiless POST on a route with an optional body', async () => {
    const user = await signUpTestUser();
    const res = await app.handle(
      new Request('http://localhost/notifications/read-all', {
        method: 'POST',
        headers: { cookie: user.cookie },
      }),
    );
    expect(res.status).not.toBe(400);
    expect(res.status).not.toBe(500);
  });
});
