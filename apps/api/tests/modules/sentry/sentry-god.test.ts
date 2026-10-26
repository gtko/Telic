import { describe, it, expect } from 'vitest';
import { authedApi, createProject } from '../../helpers/app';
import { signUpTestUser } from '../../helpers/auth';
import {
  CLIENT_SECRET,
  deliverSentry,
  godApi,
  SENTRY_SLUG,
  sentryIssue,
  setupRoutedProject,
  triageIssues,
} from '../../helpers/sentry';

// The instance Sentry settings and routes, under god mode. The stored secrets are written
// through the API and never read back.

const AUTH_TOKEN = 'sntrys_auth_token_value';

describe('sentry settings', () => {
  it('reports nothing stored before the first update', async () => {
    const god = await godApi();
    const res = await god.god.sentry.get();
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ orgSlug: '', hasAuthToken: false, hasClientSecret: false });
  });

  it('never returns the auth token or the client secret, and reports them once stored', async () => {
    const god = await godApi();
    const put = await god.god.sentry.put({
      authToken: AUTH_TOKEN,
      clientSecret: CLIENT_SECRET,
      orgSlug: 'acme',
    });
    expect(put.status).toBe(200);
    expect(JSON.stringify(put.data)).not.toContain(AUTH_TOKEN);
    expect(JSON.stringify(put.data)).not.toContain(CLIENT_SECRET);

    const res = await god.god.sentry.get();
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.data)).not.toContain(AUTH_TOKEN);
    expect(JSON.stringify(res.data)).not.toContain(CLIENT_SECRET);
    expect(res.data).toMatchObject({ orgSlug: 'acme', hasAuthToken: true, hasClientSecret: true });
    expect(res.data!.webhookUrl).toMatch(/\/api\/sentry\/webhook$/);
  });

  it('keeps a stored secret when an update sends it empty, and still verifies with it', async () => {
    const { god } = await setupRoutedProject({ authToken: AUTH_TOKEN });

    const put = await god.god.sentry.put({ clientSecret: '', orgSlug: 'acme-eu' });
    expect(put.data).toMatchObject({
      orgSlug: 'acme-eu',
      hasAuthToken: true,
      hasClientSecret: true,
    });

    const res = await deliverSentry(sentryIssue('3001'));
    expect(res).toMatchObject({ status: 200, data: { handled: 'created' } });
  });

  it('clears a stored auth token when an update sends it null', async () => {
    const { god } = await setupRoutedProject({ authToken: AUTH_TOKEN });

    const put = await god.god.sentry.put({ authToken: null });
    expect(put).toMatchObject({
      status: 200,
      data: { hasAuthToken: false, hasClientSecret: true },
    });

    const res = await god.god.sentry.get();
    expect(res.data).toMatchObject({ hasAuthToken: false, hasClientSecret: true });
  });

  it('clears the client secret when an update sends it null, so no delivery verifies', async () => {
    const { god, asOwner } = await setupRoutedProject();

    const put = await god.god.sentry.put({ clientSecret: null });
    expect(put).toMatchObject({ status: 200, data: { hasClientSecret: false } });

    const res = await deliverSentry(sentryIssue('3003'));
    expect(res.status).toBe(401);
    expect(await triageIssues(asOwner)).toEqual([]);
  });

  it('refuses the settings to a user who is not god', async () => {
    await godApi();
    const user = await signUpTestUser({ name: 'Plain' });
    const plain = authedApi(user.cookie);

    expect((await plain.god.sentry.get()).status).toBe(403);
    expect((await plain.god.sentry.put({ orgSlug: 'acme' })).status).toBe(403);
  });
});

describe('sentry routes', () => {
  it('routes a Sentry project to a Telic project and moves it when routed again', async () => {
    const { god, asOwner, projectId } = await setupRoutedProject();
    const ops = await createProject(asOwner, { key: 'OPS', name: 'Operations' });

    const listed = await god.god.sentry.routes.get();
    expect(listed.data).toMatchObject([
      { sentryProjectSlug: SENTRY_SLUG, projectId, projectKey: 'MKT' },
    ]);

    const moved = await god.god.sentry.routes.put({
      sentryProjectSlug: SENTRY_SLUG,
      projectId: ops.data!.id,
    });
    expect(moved).toMatchObject({ status: 200, data: { projectKey: 'OPS' } });
    const relisted = await god.god.sentry.routes.get();
    expect(relisted.data).toMatchObject([{ sentryProjectSlug: SENTRY_SLUG, projectKey: 'OPS' }]);
  });

  it('refuses a route to a project that does not exist', async () => {
    const { god } = await setupRoutedProject();
    const res = await god.god.sentry.routes.put({ sentryProjectSlug: 'api', projectId: 999999 });
    expect(res.status).toBe(404);
  });

  it('stops routing a Sentry project once its route is deleted', async () => {
    const { god, asOwner } = await setupRoutedProject();
    const [route] = (await god.god.sentry.routes.get()).data!;

    const removed = await god.god.sentry.routes({ id: route.id }).delete();
    expect(removed.status).toBe(204);
    expect((await god.god.sentry.routes({ id: route.id }).delete()).status).toBe(404);

    const res = await deliverSentry(sentryIssue('3002'));
    expect(res).toMatchObject({ status: 200, data: { handled: 'unrouted' } });
    expect(await triageIssues(asOwner)).toEqual([]);
  });

  it('refuses the routes to a user who is not god', async () => {
    const { projectId } = await setupRoutedProject();
    const user = await signUpTestUser({ name: 'Plain' });
    const plain = authedApi(user.cookie);

    const res = await plain.god.sentry.routes.put({ sentryProjectSlug: 'api', projectId });
    expect(res.status).toBe(403);
  });
});
