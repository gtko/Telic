import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { aiAgent, agentRun, issue, team, user, type Db } from '@repo/db';
import { createTestDb, seedProject, type SeededProject, type TestDb } from '#tests/helpers/d1';

import type { AgentRuntime, RunQueueLike } from '../runtime/bindings';
import { runMinuteJobs } from '../../jobs';
// setup-vtest.ts stubs enqueueAgentRun for the suites of other modules; this suite tests the real
// one, imported past the mock.
const {
  RESCUE_GRACE_MS,
  claimLeaseSeconds,
  claimRun,
  countRunsAhead,
  enqueueAgentRun,
  explainMiss,
  findDueRunIds,
  markRunFailed,
  markRunSuccess,
  rescueDueRuns,
  scheduleRunRetry,
} = await vi.importActual<typeof import('../run-queue')>('../run-queue');

// The agent_run queue against a real D1 (Miniflare): the claim/lease/retry state machine the
// Queue consumer and the cron drive. Ported from the bun/PG integration test run-queue.test.ts;
// the PG FOR UPDATE SKIP LOCKED claim became one conditional UPDATE, so the new tests assert
// the invariant it must keep: a run is claimed by exactly one consumer at a time.

let t: TestDb;
let seeded: SeededProject;
let workspaceId: number;
let seq = 0;

beforeAll(async () => {
  t = await createTestDb();
  seeded = await seedProject(t.db, { key: 'RQ' });
  [{ workspaceId }] = await t.db
    .select({ workspaceId: team.workspaceId })
    .from(team)
    .where(eq(team.id, seeded.teamId));
});
afterAll(() => t.dispose());

async function seedAgent(db: Db, kind: 'internal' | 'external' = 'internal') {
  const n = ++seq;
  const userId = `agent-user-${n}`;
  await db.insert(user).values({ id: userId, name: `Bot ${n}`, email: `bot${n}@example.com` });
  const [row] = await db
    .insert(aiAgent)
    .values({ teamId: seeded.teamId, userId, username: `bot${n}`, kind })
    .returning({ id: aiAgent.id });
  return row!.id;
}

async function seedIssue(db: Db) {
  const n = ++seq;
  const [row] = await db
    .insert(issue)
    .values({
      projectId: seeded.projectId,
      columnId: seeded.columnIds[0]!,
      sequenceNumber: 1000 + n,
      title: `Task ${n}`,
    })
    .returning({ id: issue.id });
  return row!.id;
}

function fakeQueue() {
  const sent: { runId: number; delaySeconds?: number }[] = [];
  const queue: RunQueueLike = {
    async send(body, options) {
      sent.push({ runId: body.runId, delaySeconds: options?.delaySeconds });
    },
    async sendBatch(messages) {
      for (const m of messages) sent.push({ runId: m.body.runId });
    },
  };
  return { queue, sent };
}

async function enqueue(
  opts: { agentId?: number; issueId?: number; queue?: RunQueueLike; delaySeconds?: number } = {},
) {
  const agentId = opts.agentId ?? (await seedAgent(t.db));
  const issueId = opts.issueId ?? (await seedIssue(t.db));
  const runId = await enqueueAgentRun(
    t.db,
    {
      agentId,
      projectId: seeded.projectId,
      issueId,
      sourceActivityId: null,
      prompt: 'do it',
      delaySeconds: opts.delaySeconds,
    },
    opts.queue,
  );
  return { agentId, issueId, runId };
}

async function readRun(runId: number) {
  const [row] = await t.db.select().from(agentRun).where(eq(agentRun.id, runId));
  return row!;
}

describe('enqueue', () => {
  it('stores the run as pending with zero attempts and sends its message', async () => {
    const { queue, sent } = fakeQueue();
    const { runId } = await enqueue({ queue });
    expect(await readRun(runId)).toMatchObject({ status: 'pending', attempts: 0, lastError: null });
    expect(sent).toEqual([{ runId, delaySeconds: undefined }]);
  });

  it('delays the message and the claim of a delayed run', async () => {
    const { queue, sent } = fakeQueue();
    const { runId } = await enqueue({ queue, delaySeconds: 120 });
    expect(sent[0]).toEqual({ runId, delaySeconds: 120 });
    expect(await claimRun(t.db, runId)).toBeNull();
    expect(await explainMiss(t.db, runId)).toMatchObject({ retryInSeconds: expect.any(Number) });
    expect(await claimRun(t.db, runId, Date.now() + 121_000)).not.toBeNull();
  });
});

describe('claim: enqueue -> claim -> success', () => {
  it('claims a due run, bumps attempts, holds the lease, then records success', async () => {
    const { runId, agentId } = await enqueue();
    const claimed = await claimRun(t.db, runId);
    expect(claimed).toMatchObject({ id: runId, agentId, attempts: 1, prompt: 'do it' });
    expect(claimed!.executionDeadline).toBeGreaterThan(Date.now());

    const after = await readRun(runId);
    expect(after).toMatchObject({ status: 'pending', attempts: 1 });
    expect(after.startedAt).not.toBeNull();
    expect(after.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    // The lease is held: a second claim finds nothing.
    expect(await claimRun(t.db, runId)).toBeNull();

    await markRunSuccess(t.db, runId, 'done', { inputTokens: 12, outputTokens: 3 });
    expect(await readRun(runId)).toMatchObject({
      status: 'success',
      output: 'done',
      lastError: null,
      inputTokens: 12,
      outputTokens: 3,
    });
    // A finished run is never claimed again and needs no further look.
    expect(await claimRun(t.db, runId, Date.now() + 3_600_000)).toBeNull();
    expect(await explainMiss(t.db, runId)).toEqual({ retryInSeconds: null });
  });

  it('never lets two consumers claim the same run (Promise.all)', async () => {
    const { runId } = await enqueue();
    const results = await Promise.all(Array.from({ length: 12 }, () => claimRun(t.db, runId)));
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect((await readRun(runId)).attempts).toBe(1);
  });

  it('claims every run once when two consumers receive each message', async () => {
    const agentId = await seedAgent(t.db);
    const issueIds = await Promise.all(Array.from({ length: 6 }, () => seedIssue(t.db)));
    const ids = await Promise.all(issueIds.map((issueId) => enqueue({ agentId, issueId })));
    const results = await Promise.all([...ids, ...ids].map(({ runId }) => claimRun(t.db, runId)));
    const claimedIds = results.filter((r) => r).map((r) => r!.id);
    expect(claimedIds.sort()).toEqual(ids.map((r) => r.runId).sort());
  });

  it('takes a run back once its lease expired (the consumer died)', async () => {
    const { runId } = await enqueue();
    expect(await claimRun(t.db, runId)).not.toBeNull();
    const lease = await claimLeaseSeconds(t.db);
    // Inside the lease: still held.
    expect(await claimRun(t.db, runId, Date.now() + (lease - 5) * 1000)).toBeNull();
    // Past it: claimable again, and the attempt is counted.
    const second = await claimRun(t.db, runId, Date.now() + (lease + 5) * 1000);
    expect(second).toMatchObject({ id: runId, attempts: 2 });
    expect((await readRun(runId)).attempts).toBe(2);
  });

  it('leaves the runs of an external agent to its runner', async () => {
    const agentId = await seedAgent(t.db, 'external');
    const { runId } = await enqueue({ agentId });
    expect(await claimRun(t.db, runId)).toBeNull();
    expect(await readRun(runId)).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('runs the runs of one agent on one issue one at a time, oldest first', async () => {
    const agentId = await seedAgent(t.db);
    const issueId = await seedIssue(t.db);
    const a = await enqueue({ agentId, issueId });
    const b = await enqueue({ agentId, issueId });
    // The newer run waits while the older one is due or in flight, even if its message came first.
    expect(await claimRun(t.db, b.runId)).toBeNull();
    expect(await claimRun(t.db, a.runId)).not.toBeNull();
    expect(await claimRun(t.db, b.runId)).toBeNull();
    await markRunSuccess(t.db, a.runId, 'done', null);
    expect(await claimRun(t.db, b.runId)).not.toBeNull();
  });
});

describe('outcomes', () => {
  it('marks a run failed with the error, truncated to the column limit', async () => {
    const { runId } = await enqueue();
    await claimRun(t.db, runId);
    await markRunFailed(t.db, runId, 'x'.repeat(600));
    const row = await readRun(runId);
    expect(row.status).toBe('failed');
    expect(row.lastError).toHaveLength(500);
  });

  it('reschedules a retry back to pending with the error and a future attempt time', async () => {
    const { runId } = await enqueue();
    await claimRun(t.db, runId);
    await scheduleRunRetry(t.db, runId, 60_000, 'transient');
    const row = await readRun(runId);
    expect(row).toMatchObject({ status: 'pending', lastError: 'transient' });
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 50_000);
    expect(await claimRun(t.db, runId)).toBeNull();
    expect(await claimRun(t.db, runId, Date.now() + 61_000)).toMatchObject({ attempts: 2 });
  });

  it('counts the in-flight runs of the workspace a run waits behind', async () => {
    const first = await enqueue();
    const second = await enqueue();
    const before = await countRunsAhead(t.db, workspaceId, second.runId);
    await claimRun(t.db, first.runId);
    expect(await countRunsAhead(t.db, workspaceId, second.runId)).toBe(before + 1);
    await markRunSuccess(t.db, first.runId, 'done', null);
    expect(await countRunsAhead(t.db, workspaceId, second.runId)).toBe(before);
  });
});

describe('cron catch-up', () => {
  it('re-sends only the runs whose message is overdue', async () => {
    const lost = await enqueue();
    const fresh = await enqueue();
    // Age the first run past the grace period; the second was just queued.
    await t.db
      .update(agentRun)
      .set({ nextAttemptAt: new Date(Date.now() - RESCUE_GRACE_MS - 5_000) })
      .where(eq(agentRun.id, lost.runId));
    const due = await findDueRunIds(t.db);
    expect(due).toContain(lost.runId);
    expect(due).not.toContain(fresh.runId);

    const { queue, sent } = fakeQueue();
    await rescueDueRuns(t.db, queue);
    expect(sent.map((m) => m.runId)).toContain(lost.runId);
    expect(sent.map((m) => m.runId)).not.toContain(fresh.runId);
    // Without a queue there is nothing to send to.
    expect(await rescueDueRuns(t.db, null)).toBe(0);
  });

  it('runMinuteJobs re-sends a lost run and an expired lease through the Worker wiring', async () => {
    const lost = await enqueue();
    const dead = await enqueue();
    await claimRun(t.db, dead.runId);
    const past = new Date(Date.now() - RESCUE_GRACE_MS - 5_000);
    await t.db.update(agentRun).set({ nextAttemptAt: past }).where(eq(agentRun.id, lost.runId));
    await t.db.update(agentRun).set({ nextAttemptAt: past }).where(eq(agentRun.id, dead.runId));

    const { queue, sent } = fakeQueue();
    await runMinuteJobs({ db: t.db, queue } as unknown as AgentRuntime);
    expect(sent.map((m) => m.runId)).toEqual(expect.arrayContaining([lost.runId, dead.runId]));
  });
});
