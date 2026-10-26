// The triage state on project_column, the Sentry routing and issue tables, and the
// instance Sentry config (encrypted in app_secret) on a local D1 (miniflare).
import { eq } from 'drizzle-orm';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../client';
import { getSentryConfig, SENTRY_SECRET_KEY } from '../domains/sentry';
import { migrateD1 } from '../migrate';
import { writeSecret } from '../secrets';
import {
  appSecret,
  issue,
  project,
  projectColumn,
  sentryIssue,
  sentryRoute,
  team,
  user,
} from '../schema';
import { createWorkspace } from '../workspace';

let mf: Miniflare;
let db: Db;
let teamId: number;
let n = 0;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = 'sentry-test-encryption-key';
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: 'sentry-db' },
  });
  db = createDb((await mf.getD1Database('DB')) as unknown as D1Database);
  await migrateD1(db);
  await db.insert(user).values({ id: 'u1', name: 'Ada', email: 'ada@example.com' });
  const workspaceId = await createWorkspace(db, 'Acme', 'u1');
  [{ id: teamId }] = await db
    .insert(team)
    .values({ workspaceId, name: 'Core' })
    .returning({ id: team.id });
});

afterAll(async () => {
  await mf.dispose();
});

async function mkProject() {
  const k = ++n;
  const [p] = await db
    .insert(project)
    .values({ teamId, key: `SE${k}`, name: `Sentry ${k}` })
    .returning({ id: project.id });
  const [c] = await db
    .insert(projectColumn)
    .values({ projectId: p!.id, name: 'Triage', stateType: 'triage', position: 0 })
    .returning({ id: projectColumn.id });
  return { projectId: p!.id, columnId: c!.id };
}

async function mkIssue(projectId: number, columnId: number) {
  const [i] = await db
    .insert(issue)
    .values({ projectId, columnId, sequenceNumber: ++n, title: `Issue ${n}` })
    .returning({ id: issue.id });
  return i!.id;
}

describe('project_column state types', () => {
  it('accepts the triage state', async () => {
    const { projectId } = await mkProject();
    const [row] = await db
      .insert(projectColumn)
      .values({ projectId, name: 'New', stateType: 'triage', position: 1 })
      .returning({ stateType: projectColumn.stateType });
    expect(row!.stateType).toBe('triage');
  });

  it('rejects a state type outside the list', async () => {
    const { projectId } = await mkProject();
    await expect(
      db.insert(projectColumn).values({ projectId, name: 'Bad', stateType: 'bogus', position: 1 }),
    ).rejects.toThrow();
  });
});

describe('sentry_route', () => {
  it('keeps one row per Sentry project slug', async () => {
    const { projectId } = await mkProject();
    const slug = `slug-${++n}`;
    await db.insert(sentryRoute).values({ sentryProjectSlug: slug, projectId });
    await expect(
      db.insert(sentryRoute).values({ sentryProjectSlug: slug, projectId }),
    ).rejects.toThrow();
  });

  it('is removed with its project', async () => {
    const { projectId } = await mkProject();
    const slug = `slug-${++n}`;
    await db.insert(sentryRoute).values({ sentryProjectSlug: slug, projectId });
    await db.delete(project).where(eq(project.id, projectId));
    const rows = await db.select().from(sentryRoute).where(eq(sentryRoute.sentryProjectSlug, slug));
    expect(rows).toHaveLength(0);
  });
});

describe('sentry_issue', () => {
  it('links several Sentry issues to one Telic issue', async () => {
    const { projectId, columnId } = await mkProject();
    const issueId = await mkIssue(projectId, columnId);
    await db.insert(sentryIssue).values([
      { sentryIssueId: `s-${++n}`, issueId },
      { sentryIssueId: `s-${++n}`, issueId },
    ]);
    const rows = await db.select().from(sentryIssue).where(eq(sentryIssue.issueId, issueId));
    expect(rows).toHaveLength(2);
  });

  it('is removed with its Telic issue', async () => {
    const { projectId, columnId } = await mkProject();
    const issueId = await mkIssue(projectId, columnId);
    const sentryIssueId = `s-${++n}`;
    await db.insert(sentryIssue).values({ sentryIssueId, issueId });
    await db.delete(issue).where(eq(issue.id, issueId));
    const rows = await db
      .select()
      .from(sentryIssue)
      .where(eq(sentryIssue.sentryIssueId, sentryIssueId));
    expect(rows).toHaveLength(0);
  });
});

describe('instance Sentry config', () => {
  it('reads empty values when nothing is stored', async () => {
    await expect(getSentryConfig(db)).resolves.toEqual({
      authToken: '',
      clientSecret: '',
      orgSlug: '',
    });
  });

  it('decrypts what was stored and keeps the secrets out of the row in clear', async () => {
    await writeSecret(
      db,
      SENTRY_SECRET_KEY,
      { authToken: 'sntrys_token_123', clientSecret: 'client_secret_456', orgSlug: 'acme' },
      { authToken: true, clientSecret: true, orgSlug: 'acme' },
    );
    await expect(getSentryConfig(db)).resolves.toEqual({
      authToken: 'sntrys_token_123',
      clientSecret: 'client_secret_456',
      orgSlug: 'acme',
    });
    const [row] = await db.select().from(appSecret).where(eq(appSecret.key, SENTRY_SECRET_KEY));
    expect(row!.ciphertext).not.toContain('sntrys_token_123');
    expect(row!.ciphertext).not.toContain('client_secret_456');
  });
});
