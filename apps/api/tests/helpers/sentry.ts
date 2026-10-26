import { createHmac } from 'node:crypto';
import { app, authedApi, type Api, createProject } from './app';
import { signUpTestUser } from './auth';

// The client secret the instance is configured with in the Sentry tests.
export const CLIENT_SECRET = 'sentry-client-secret';

// The Sentry project slug the instance routes to the Telic project, in the Sentry tests.
export const SENTRY_SLUG = 'web';

// The first sign-up of a reset database is the instance owner (god), so this is the
// instance owner's client; it configures Sentry through /god/sentry.
export async function godApi(): Promise<Api> {
  const god = await signUpTestUser({ name: 'Root' });
  return authedApi(god.cookie);
}

// Sends a Sentry webhook delivery. The signature is HMAC-SHA256 of the raw body, hex, under
// the client secret, as Sentry signs it. A delivery is sent as text, so the bytes signed are
// the bytes received.
export async function deliverSentry(
  payload: unknown,
  {
    secret = CLIENT_SECRET,
    signature,
    resource = 'issue',
    headers = {},
  }: {
    secret?: string;
    signature?: string;
    resource?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const body = JSON.stringify(payload);
  const res = await app.handle(
    new Request('http://localhost/api/sentry/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'sentry-hook-resource': resource,
        'sentry-hook-signature':
          signature ?? createHmac('sha256', secret).update(body).digest('hex'),
        ...headers,
      },
      body,
    }),
  );
  return {
    status: res.status,
    data: (await res.json().catch(() => null)) as { ok?: boolean; handled?: string } | null,
  };
}

// A Sentry `issue` webhook payload with the fields the handler reads.
export function sentryIssue(
  id: string,
  { action = 'created', slug = SENTRY_SLUG }: { action?: string; slug?: string } = {},
) {
  return {
    action,
    data: {
      issue: {
        id,
        title: `TypeError in checkout ${id}`,
        culprit: 'app/checkout.ts',
        permalink: `https://sentry.io/organizations/acme/issues/${id}/`,
        level: 'error',
        firstSeen: '2026-10-01T10:00:00Z',
        lastSeen: '2026-10-02T10:00:00Z',
        project: { slug },
      },
    },
  };
}

// A project MKT owned by a new user, with the Sentry instance configured (unless `configure`
// is false) to route SENTRY_SLUG to it. Returns the instance owner's client, the project
// owner's client and the project id.
export async function setupRoutedProject({
  configure = true,
  authToken,
}: { configure?: boolean; authToken?: string } = {}) {
  const god = await godApi();
  const owner = await signUpTestUser({ name: 'Owner' });
  const asOwner = authedApi(owner.cookie);
  const created = await createProject(asOwner, { key: 'MKT', name: 'Marketing' });
  const projectId = created.data!.id;
  // A Sentry issue takes the Bug type of its project, which the default project lacks.
  await asOwner.projects({ projectKey: 'MKT' })['issue-types'].post({ name: 'Bug' });
  if (configure) {
    await god.god.sentry.put({ clientSecret: CLIENT_SECRET, orgSlug: 'acme', authToken });
    await god.god.sentry.routes.put({ sentryProjectSlug: SENTRY_SLUG, projectId });
  }
  return { god, asOwner, projectId };
}

// The id of each column of a project, keyed by its state type. The triage column exists
// once the first delivery has created it, so read this after that.
export async function columnIds(asOwner: Api, projectKey = 'MKT'): Promise<Record<string, number>> {
  const view = await asOwner.projects({ projectKey }).get();
  return Object.fromEntries(view.data!.columns.map((c) => [c.stateType, c.id]));
}

// The issues in the triage column of a project.
export async function triageIssues(asOwner: Api, projectKey = 'MKT') {
  const res = await asOwner.projects({ projectKey }).triage.get();
  return res.data!;
}

// Fakes the Sentry API: calls to sentry.io are recorded and answered by `respond`, every
// other request goes to the real fetch. Call restoreFetch after each test.
const realFetch = globalThis.fetch;

export interface SentryCall {
  url: string;
  init?: RequestInit;
}

export function mockSentryFetch(respond: () => Response | Promise<Response>): SentryCall[] {
  const calls: SentryCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith('https://sentry.io/')) return realFetch(input, init);
    calls.push({ url, init });
    return respond();
  }) as typeof fetch;
  return calls;
}

export function restoreFetch() {
  globalThis.fetch = realFetch;
}
