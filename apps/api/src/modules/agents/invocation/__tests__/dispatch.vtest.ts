import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { agentChatMessage, agentChatThread, agentRun, aiAgent, issue, user } from '@repo/db';
import { createTestDb, seedProject, type SeededProject, type TestDb } from '#tests/helpers/d1';

const pinnedFetch = vi.hoisted(() => vi.fn());
vi.mock('@repo/net', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@repo/net')>()),
  pinnedFetch,
}));

import { dispatchInvocations } from '../service';
import { ensureInvocationSecret } from '../secret';
const { enqueueAgentRun } =
  await vi.importActual<typeof import('../../core/run-queue')>('../../core/run-queue');

let t: TestDb;
let seeded: SeededProject;

beforeAll(async () => {
  t = await createTestDb();
  seeded = await seedProject(t.db, { key: 'INV' });
});
afterAll(() => t.dispose());

async function seedExternalAgent(invocationUrl: string | null) {
  const userId = `inv-agent-${Math.random().toString(36).slice(2)}`;
  await t.db.insert(user).values({ id: userId, name: 'Ext', email: `${userId}@example.com` });
  const [row] = await t.db
    .insert(aiAgent)
    .values({
      teamId: seeded.teamId,
      userId,
      username: userId.replaceAll('-', ''),
      kind: 'external',
      invocationUrl,
    })
    .returning({ id: aiAgent.id });
  await ensureInvocationSecret(t.db, row!.id);
  return row!.id;
}

describe('dispatchInvocations', () => {
  it('sends a signed request to the URL of an external agent for a due run and a chat answer', async () => {
    pinnedFetch.mockReset();
    pinnedFetch.mockResolvedValue(new Response('ok', { status: 202 }));
    const agentId = await seedExternalAgent('https://agent.example.com/hook');
    const [i] = await t.db
      .insert(issue)
      .values({
        projectId: seeded.projectId,
        columnId: seeded.columnIds[0]!,
        sequenceNumber: 1,
        title: 'T',
      })
      .returning({ id: issue.id });
    const runId = await enqueueAgentRun(
      t.db,
      {
        agentId,
        projectId: seeded.projectId,
        issueId: i!.id,
        sourceActivityId: null,
        prompt: 'do it',
      },
      null,
    );
    await t.db.insert(agentChatThread).values({ id: 'inv-thread', agentId, userId: seeded.userId });
    await t.db
      .insert(agentChatMessage)
      .values({ threadId: 'inv-thread', agentId, role: 'user', content: 'hi', status: 'success' });
    const [answer] = await t.db
      .insert(agentChatMessage)
      .values({ threadId: 'inv-thread', agentId, role: 'assistant', status: 'pending' })
      .returning({ id: agentChatMessage.id });

    await dispatchInvocations(t.db);

    const calls = pinnedFetch.mock.calls.map(([url, init]) => ({
      url,
      event: init.headers['X-Itsaplan-Event'] as string,
      signed: Boolean(init.headers['X-Itsaplan-Signature']),
      body: JSON.parse(init.body as string),
    }));
    expect(calls.map((c) => c.url)).toEqual([
      'https://agent.example.com/hook',
      'https://agent.example.com/hook',
    ]);
    expect(calls.map((c) => c.event).sort()).toEqual(['agent.chat', 'agent.run']);
    expect(calls.every((c) => c.signed)).toBe(true);
    expect(calls.find((c) => c.event === 'agent.run')!.body.run.id).toBe(runId);
    expect(calls.find((c) => c.event === 'agent.chat')!.body.message.id).toBe(answer!.id);

    const [run] = await t.db.select().from(agentRun).where(eq(agentRun.id, runId));
    expect(run!.attempts).toBe(1);
    const [msg] = await t.db
      .select()
      .from(agentChatMessage)
      .where(eq(agentChatMessage.id, answer!.id));
    expect(msg!.status).toBe('streaming');
  });

  it('fails a chat answer at once when the endpoint refuses it', async () => {
    pinnedFetch.mockReset();
    pinnedFetch.mockResolvedValue(new Response('no', { status: 500 }));
    const agentId = await seedExternalAgent('https://agent2.example.com/hook');
    await t.db
      .insert(agentChatThread)
      .values({ id: 'inv-thread-2', agentId, userId: seeded.userId });
    await t.db.insert(agentChatMessage).values({
      threadId: 'inv-thread-2',
      agentId,
      role: 'user',
      content: 'hi',
      status: 'success',
    });
    const [answer] = await t.db
      .insert(agentChatMessage)
      .values({ threadId: 'inv-thread-2', agentId, role: 'assistant', status: 'pending' })
      .returning({ id: agentChatMessage.id });

    await dispatchInvocations(t.db);

    const [msg] = await t.db
      .select()
      .from(agentChatMessage)
      .where(eq(agentChatMessage.id, answer!.id));
    expect(msg).toMatchObject({ status: 'failed' });
  });

  it('sends nothing for an external agent without a URL', async () => {
    pinnedFetch.mockReset();
    await seedExternalAgent(null);
    await dispatchInvocations(t.db);
    expect(pinnedFetch).not.toHaveBeenCalled();
  });
});
