import { randomUUID } from 'node:crypto';
import {
  importJob,
  notificationDelivery,
  project,
  team,
  user,
  webhook,
  webhookDelivery,
  workspace,
  type Db,
} from '@repo/db';
import { eq, inArray } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { claimDueImportJobs } from '../../import-store';
import { claimDueNotifications } from '../../notification-delivery';
import {
  claimDueDeliveries,
  cleanupOldDeliveries,
  markFailed,
  markSuccess,
  scheduleRetry,
} from '../../store';
import { useTestEnv } from '../helpers/d1';

// The claims are raw SQL (UPDATE ... WHERE id IN (SELECT ...) RETURNING, INSERT ... SELECT)
// run against a real D1. The invariant under test, for each of the four queues: of N
// consumers claiming at once, a row is handed out exactly once.

const ctx = useTestEnv();
const CONSUMERS = 6;

async function makeProject(db: Db): Promise<{ teamId: number; projectId: number; userId: string }> {
  const [ws] = await db
    .insert(workspace)
    .values({ name: 'Claimers' })
    .returning({ id: workspace.id });
  const [teamRow] = await db
    .insert(team)
    .values({ workspaceId: ws!.id, name: 'Claimers' })
    .returning({ id: team.id });
  const [projectRow] = await db
    .insert(project)
    .values({ teamId: teamRow!.id, key: randomUUID().slice(0, 8), name: 'Claimed' })
    .returning({ id: project.id });
  const userId = randomUUID();
  await db.insert(user).values({ id: userId, name: 'Claimer', email: `${userId}@example.test` });
  return { teamId: teamRow!.id, projectId: projectRow!.id, userId };
}

async function seedWebhook(db: Db, projectId: number, deliveries: number) {
  const [hook] = await db
    .insert(webhook)
    .values({ projectId, url: 'https://hooks.example.test/in', secret: 's3cret' })
    .returning({ id: webhook.id });
  const ids: number[] = [];
  for (let i = 0; i < deliveries; i++) {
    const [row] = await db
      .insert(webhookDelivery)
      .values({
        webhookId: hook!.id,
        eventId: randomUUID(),
        eventType: 'issue.created',
        payload: { n: i },
        nextAttemptAt: new Date(Date.now() - 1000),
      })
      .returning({ id: webhookDelivery.id });
    ids.push(row!.id);
  }
  return { webhookId: hook!.id, ids };
}

afterEach(() => {
  delete process.env.WEBHOOK_BATCH_SIZE;
  delete process.env.WEBHOOK_DISABLE_THRESHOLD;
  delete process.env.NOTIFICATION_BATCH_SIZE;
});

describe('webhook delivery claim', () => {
  it('returns the delivery with its webhook columns and the parsed payload', async () => {
    const { projectId } = await makeProject(ctx.db);
    const { ids } = await seedWebhook(ctx.db, projectId, 1);
    const claimed = await claimDueDeliveries(ctx.db, Date.now());
    const mine = claimed.find((c) => c.id === ids[0]);
    expect(mine).toMatchObject({
      url: 'https://hooks.example.test/in',
      secret: 's3cret',
      isActive: true,
      attempts: 1,
      eventType: 'issue.created',
      payload: { n: 0 },
    });
  });

  it('hands every row to exactly one of several concurrent consumers', async () => {
    process.env.WEBHOOK_BATCH_SIZE = '7';
    const { projectId } = await makeProject(ctx.db);
    const { ids } = await seedWebhook(ctx.db, projectId, 40);
    const seen: number[] = [];
    // Rounds of concurrent claims until the queue is drained.
    for (let round = 0; round < 6; round++) {
      const results = await Promise.all(
        Array.from({ length: CONSUMERS }, () => claimDueDeliveries(ctx.db, Date.now())),
      );
      for (const batch of results) seen.push(...batch.map((c) => c.id));
    }
    const mine = seen.filter((id) => ids.includes(id));
    expect(mine).toHaveLength(40);
    expect(new Set(mine).size).toBe(40);
    const rows = await ctx.db
      .select({ attempts: webhookDelivery.attempts })
      .from(webhookDelivery)
      .where(inArray(webhookDelivery.id, ids));
    expect(rows.every((r) => r.attempts === 1)).toBe(true);
  });

  it('makes a leased row claimable again only once the lease has expired', async () => {
    process.env.WEBHOOK_BATCH_SIZE = '1000'; // rows leased by earlier tests are due again too
    const { projectId } = await makeProject(ctx.db);
    const { ids } = await seedWebhook(ctx.db, projectId, 1);
    const now = Date.now();
    const first = await claimDueDeliveries(ctx.db, now);
    expect(first.some((c) => c.id === ids[0])).toBe(true);
    const during = await claimDueDeliveries(ctx.db, now + 1000);
    expect(during.some((c) => c.id === ids[0])).toBe(false);
    const after = await claimDueDeliveries(ctx.db, now + 121_000);
    expect(after.find((c) => c.id === ids[0])?.attempts).toBe(2);
  });

  it('records success, retry and failure, and disables a webhook at the threshold', async () => {
    process.env.WEBHOOK_DISABLE_THRESHOLD = '3';
    const { projectId } = await makeProject(ctx.db);
    const { webhookId, ids } = await seedWebhook(ctx.db, projectId, 4);
    const state = async () => {
      const [w] = await ctx.db.select().from(webhook).where(eq(webhook.id, webhookId));
      return w!;
    };

    await markSuccess(ctx.db, ids[0]!, webhookId, { status: 200, body: 'ok' });
    expect((await state()).consecutiveFailures).toBe(0);

    await scheduleRetry(ctx.db, ids[1]!, webhookId, 5000, 'boom', { status: 500 }, Date.now());
    expect(await state()).toMatchObject({ consecutiveFailures: 1, isActive: true });
    const [retried] = await ctx.db
      .select()
      .from(webhookDelivery)
      .where(eq(webhookDelivery.id, ids[1]!));
    expect(retried).toMatchObject({ status: 'pending', lastError: 'boom', responseStatus: 500 });
    expect(retried!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    await markFailed(ctx.db, ids[2]!, webhookId, 'dead', {});
    expect(await state()).toMatchObject({ consecutiveFailures: 2, isActive: true });
    await markFailed(ctx.db, ids[3]!, webhookId, 'dead', {});
    expect(await state()).toMatchObject({ consecutiveFailures: 3, isActive: false });
  });

  it('cleans up old successful deliveries only', async () => {
    const { projectId } = await makeProject(ctx.db);
    const { ids } = await seedWebhook(ctx.db, projectId, 2);
    const old = new Date(Date.now() - 40 * 86_400_000);
    await ctx.db
      .update(webhookDelivery)
      .set({ status: 'success', createdAt: old })
      .where(eq(webhookDelivery.id, ids[0]!));
    await ctx.db
      .update(webhookDelivery)
      .set({ createdAt: old })
      .where(eq(webhookDelivery.id, ids[1]!));
    expect(await cleanupOldDeliveries(ctx.db, Date.now())).toBeGreaterThanOrEqual(1);
    const left = await ctx.db
      .select({ id: webhookDelivery.id })
      .from(webhookDelivery)
      .where(inArray(webhookDelivery.id, ids));
    expect(left).toEqual([{ id: ids[1]! }]);
  });
});

describe('notification delivery claim', () => {
  it('hands every row to exactly one of several concurrent consumers', async () => {
    process.env.NOTIFICATION_BATCH_SIZE = '6';
    const { projectId } = await makeProject(ctx.db);
    const ids: number[] = [];
    for (let i = 0; i < 30; i++) {
      const [row] = await ctx.db
        .insert(notificationDelivery)
        .values({
          projectId,
          channel: 'email',
          recipient: `r${i}@example.test`,
          payload: { text: `n${i}` },
          nextAttemptAt: new Date(Date.now() - 1000),
        })
        .returning({ id: notificationDelivery.id });
      ids.push(row!.id);
    }
    const seen: { id: number; attempts: number; payload: unknown }[] = [];
    for (let round = 0; round < 6; round++) {
      const results = await Promise.all(
        Array.from({ length: CONSUMERS }, () => claimDueNotifications(ctx.db, Date.now())),
      );
      for (const batch of results) seen.push(...batch);
    }
    const mine = seen.filter((c) => ids.includes(c.id));
    expect(mine).toHaveLength(30);
    expect(new Set(mine.map((c) => c.id)).size).toBe(30);
    expect(mine.every((c) => c.attempts === 1)).toBe(true);
    expect(mine[0]!.payload).toMatchObject({ text: expect.stringMatching(/^n\d+$/) });
  });
});

describe('import job claim', () => {
  it('hands every due job to exactly one of several concurrent consumers', async () => {
    const { projectId, userId } = await makeProject(ctx.db);
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      const [row] = await ctx.db
        .insert(importJob)
        .values({
          projectId,
          createdByUserId: userId,
          source: 'plane',
          nextAttemptAt: new Date(Date.now() - 1000),
        })
        .returning({ id: importJob.id });
      ids.push(row!.id);
    }
    const results = await Promise.all(
      Array.from({ length: CONSUMERS }, () => claimDueImportJobs(ctx.db, 100, Date.now())),
    );
    const mine = results
      .flat()
      .map((j) => j.id)
      .filter((id) => ids.includes(id));
    expect([...mine].sort()).toEqual([...ids].sort());
    const rows = await ctx.db
      .select({ attempts: importJob.attempts })
      .from(importJob)
      .where(inArray(importJob.id, ids));
    expect(rows.every((r) => r.attempts === 1)).toBe(true);
  });
});
