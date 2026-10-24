import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aiAgent, aiSpans, user, type Db } from '@repo/db';
import { createTestDb, seedProject, type SeededProject, type TestDb } from '#tests/helpers/d1';
import { setAgentSettings } from '#modules/settings/service';
import { getAgentAnalytics } from '../runtime/analytics';
import type { R2Like } from '../runtime/bindings';
import { getAgentTrace, listAgentTraces } from '../runtime/traces';
import { pruneAgentTraces } from '../runtime/trace-retention';

// The span store (ai_spans) the runtime's exporter writes, read by the trace endpoints, the
// analytics and the retention sweep. Ported from the bun/PG agent-traces.test.ts: the spans are
// seeded straight into the table the way D1SpanExporter writes them, since a real trace needs
// a live model call.

let t: TestDb;
let s: SeededProject;
let agentId: number;
let otherAgentId: number;
let seq = 0;

beforeAll(async () => {
  t = await createTestDb();
  s = await seedProject(t.db, { key: 'TR' });
  agentId = await seedAgent(t.db);
  otherAgentId = await seedAgent(t.db);
});
afterAll(() => t.dispose());

async function seedAgent(db: Db) {
  const n = ++seq;
  const userId = `trace-agent-${n}`;
  await db.insert(user).values({ id: userId, name: `Bot ${n}`, email: `tbot${n}@example.com` });
  const [row] = await db
    .insert(aiAgent)
    .values({ teamId: s.teamId, userId, username: `tbot${n}`, kind: 'internal' })
    .returning({ id: aiAgent.id });
  return row!.id;
}

// An in-memory bucket, to see what the runtime writes and deletes.
function fakeBucket() {
  const objects = new Map<string, string>();
  const bucket: R2Like = {
    async put(key, value) {
      objects.set(key, value);
    },
    async get(key) {
      const value = objects.get(key);
      return value === undefined ? null : { text: async () => value };
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
  };
  return { objects, bucket };
}

const DAY = 86_400_000;

async function seedTrace(
  traceId: string,
  root: Partial<typeof aiSpans.$inferInsert> & { startedAt: number },
  opts: { toolInput?: unknown; inputRef?: string } = {},
) {
  const rootId = `root-${++seq}`;
  await t.db.insert(aiSpans).values({
    traceId,
    spanId: rootId,
    name: 'agent run',
    spanType: 'agent_run',
    endedAt: root.startedAt + 1500,
    teamId: s.teamId,
    agentId,
    projectId: s.projectId,
    inputJson: JSON.stringify('do the thing'),
    outputJson: JSON.stringify('done'),
    ...root,
  });
  await t.db.insert(aiSpans).values({
    traceId,
    spanId: `tool-${seq}`,
    parentSpanId: rootId,
    name: 'create_issue',
    spanType: 'tool_call',
    startedAt: root.startedAt + 100,
    endedAt: root.startedAt + 400,
    inputJson: opts.inputRef ? null : JSON.stringify(opts.toolInput ?? { title: 'Task' }),
    inputRef: opts.inputRef ?? null,
    inputBytes: opts.inputRef ? 99_999 : null,
    outputJson: JSON.stringify({ id: 7 }),
  });
}

const rtOf = (bucket?: R2Like) =>
  ({ db: t.db, payloads: bucket ?? null, queue: null, d1: null, auth: null }) as never;

describe('agent traces', () => {
  it("lists the agent's traces newest first with what each run belongs to", async () => {
    await seedTrace('trace-old', {
      startedAt: Date.UTC(2026, 0, 1),
      runId: 11,
      trigger: 'mention',
    });
    await seedTrace('trace-new', { startedAt: Date.UTC(2026, 0, 2) });
    const page = await listAgentTraces(t.db, agentId, 'viewer', { limit: 20, offset: 0 });
    expect(page.total).toBe(2);
    expect(page.items.map((i) => i.traceId)).toEqual(['trace-new', 'trace-old']);
    expect(page.items[1]).toMatchObject({
      status: 'success',
      durationMs: 1500,
      projectId: s.projectId,
      runId: 11,
      trigger: 'mention',
    });
  });

  it('reads one trace with its steps, and not one of another agent', async () => {
    await seedTrace('trace-detail', { startedAt: Date.UTC(2026, 0, 3) });
    const detail = await getAgentTrace(rtOf(), agentId, 'trace-detail', 'viewer');
    expect(detail!.spans.map((x) => x.type)).toEqual(['agent_run', 'tool_call']);
    expect(detail!.spans[1]).toMatchObject({
      name: 'create_issue',
      durationMs: 300,
      input: { title: 'Task' },
      output: { id: 7 },
    });
    expect(await getAgentTrace(rtOf(), otherAgentId, 'trace-detail', 'viewer')).toBeNull();
  });

  it("keeps a member's chat to them", async () => {
    await seedTrace('trace-chat', { startedAt: Date.UTC(2026, 0, 4), userId: 'alice' });
    expect(await getAgentTrace(rtOf(), agentId, 'trace-chat', 'bob')).toBeNull();
    expect(await getAgentTrace(rtOf(), agentId, 'trace-chat', 'alice')).not.toBeNull();
  });

  it('reads a large payload back from the bucket, or a marker when the object is gone', async () => {
    const { bucket, objects } = fakeBucket();
    objects.set('spans/trace-big/big.input.json', JSON.stringify({ big: true }));
    await seedTrace(
      'trace-big',
      { startedAt: Date.UTC(2026, 0, 5) },
      { inputRef: 'spans/trace-big/big.input.json' },
    );
    const withBucket = await getAgentTrace(rtOf(bucket), agentId, 'trace-big', 'v');
    expect(withBucket!.spans[1]!.input).toEqual({ big: true });
    const without = await getAgentTrace(rtOf(), agentId, 'trace-big', 'v');
    expect(without!.spans[1]!.input).toEqual({ truncated: true, bytes: 99_999 });
  });
});

describe('agent analytics on spans', () => {
  it('sums the model calls of the runs in scope', async () => {
    const now = Date.now();
    await seedTrace('trace-an', { startedAt: now - 1000, agentId });
    await t.db.insert(aiSpans).values({
      traceId: 'trace-an',
      spanId: 'model-1',
      parentSpanId: 'root-x',
      name: 'llm',
      spanType: 'model_inference',
      startedAt: now - 900,
      endedAt: now - 800,
      provider: 'acme',
      model: 'tiny',
      inputTokens: 100,
      outputTokens: 40,
    });
    const result = await getAgentAnalytics(t.db, { teamIds: [s.teamId] }, 7);
    expect(result.totals.runs).toBeGreaterThanOrEqual(1);
    expect(result.totals.inputTokens).toBeGreaterThanOrEqual(100);
    expect(result.models.find((m) => m.model === 'tiny')).toMatchObject({
      provider: 'acme',
      calls: 1,
      inputTokens: 100,
      outputTokens: 40,
    });
    // A scope with no team reads nothing.
    expect((await getAgentAnalytics(t.db, { teamIds: [] }, 7)).totals.runs).toBe(0);
  });
});

describe('agent trace retention', () => {
  const idsOf = async () =>
    (await listAgentTraces(t.db, agentId, 'viewer', { limit: 100, offset: 0 })).items.map(
      (i) => i.traceId,
    );

  it('deletes the traces past the window with their bucket objects, and keeps the rest', async () => {
    const { bucket, objects } = fakeBucket();
    const rt = rtOf(bucket);
    objects.set('spans/ret-old/x.input.json', '{}');
    objects.set('spans/ret-recent/x.input.json', '{}');
    await seedTrace(
      'ret-old',
      { startedAt: Date.now() - 40 * DAY },
      { inputRef: 'spans/ret-old/x.input.json' },
    );
    await seedTrace(
      'ret-recent',
      { startedAt: Date.now() - 5 * DAY },
      { inputRef: 'spans/ret-recent/x.input.json' },
    );

    await setAgentSettings(t.db, { traceRetentionDays: 0 });
    await pruneAgentTraces(rt);
    expect(await idsOf()).toEqual(expect.arrayContaining(['ret-old', 'ret-recent']));

    await setAgentSettings(t.db, { traceRetentionDays: 30 });
    expect(await pruneAgentTraces(rt)).toBeGreaterThan(0);
    const left = await idsOf();
    expect(left).toContain('ret-recent');
    expect(left).not.toContain('ret-old');
    expect([...objects.keys()]).toEqual(['spans/ret-recent/x.input.json']);
    await setAgentSettings(t.db, { traceRetentionDays: 0 });
  });

  it('drops the traces of a team that no longer exists, whatever the window says', async () => {
    await seedTrace('ret-orphan', { startedAt: Date.now(), teamId: s.teamId + 1000 });
    await seedTrace('ret-mine', { startedAt: Date.now() });
    await pruneAgentTraces({ db: t.db, payloads: null } as never);
    const left = await idsOf();
    expect(left).toContain('ret-mine');
    expect(left).not.toContain('ret-orphan');
    expect(await t.db.select().from(aiSpans).where(eq(aiSpans.traceId, 'ret-orphan'))).toHaveLength(
      0,
    );
  });
});
