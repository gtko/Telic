import { describe, expect, it } from 'vitest';
import { api } from './helpers/app';
import { signUpTestUser } from './helpers/auth';

describe('auth config', () => {
  it('reports whether any account exists', async () => {
    expect((await api['auth-config'].get()).data).toMatchObject({ hasUsers: false });

    await signUpTestUser();

    expect((await api['auth-config'].get()).data).toMatchObject({ hasUsers: true });
  });
});
