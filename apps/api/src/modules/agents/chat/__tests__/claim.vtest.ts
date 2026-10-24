import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentChatMessage, agentChatThread, aiAgent, user, type Db } from '@repo/db';
import { createTestDb, seedProject, type TestDb } from '#tests/helpers/d1';

import { getRunnerAgent } from '../../runner/service';
import { takeNextMessage } from '../service';

let t: TestDb;
let teamId: number;
let seq = 0;

beforeAll(async () => {
  t = await createTestDb();
  ({ teamId } = await seedProject(t.db, { key: 'CH' }));
});
afterAll(() => t.dispose());

async function seedAgent(db: Db) {
  const n = ++seq;
  const userId = `chat-agent-user-${n}`;
  await db.insert(user).values({ id: userId, name: `Bot ${n}`, email: `chatbot${n}@example.com` });
  await db.insert(aiAgent).values({ teamId, userId, username: `chatbot${n}`, kind: 'external' });
  return (await getRunnerAgent(db, userId))!;
}

async function seedThreadWithQuestion(db: Db, agentId: number, requesterId: string) {
  const threadId = `thread-${++seq}`;
  await db.insert(agentChatThread).values({ id: threadId, agentId, userId: requesterId });
  await db
    .insert(agentChatMessage)
    .values({ threadId, agentId, role: 'user', content: 'hello', status: 'success' });
  const [answer] = await db
    .insert(agentChatMessage)
    .values({ threadId, agentId, role: 'assistant', status: 'pending' })
    .returning({ id: agentChatMessage.id });
  return answer!.id;
}

describe('takeNextMessage', () => {
  it('claims a due answer once: attempts bumped, streaming, lease pushed', async () => {
    const agent = await seedAgent(t.db);
    const messageId = await seedThreadWithQuestion(t.db, agent.id, 'chat-agent-user-1');
    const before = Date.now();

    const claimed = await takeNextMessage(t.db, agent);
    expect(claimed?.id).toBe(messageId);

    const [row] = await t.db
      .select()
      .from(agentChatMessage)
      .where(eq(agentChatMessage.id, messageId));
    expect(row).toMatchObject({ status: 'streaming', attempts: 1, content: '' });
    expect(row!.nextAttemptAt.getTime()).toBeGreaterThan(before);
    expect(await takeNextMessage(t.db, agent)).toBeNull();
  });

  it('lets exactly one of many parallel claims win', async () => {
    const agent = await seedAgent(t.db);
    const messageId = await seedThreadWithQuestion(t.db, agent.id, 'chat-agent-user-1');

    const results = await Promise.all(
      Array.from({ length: 8 }, () => takeNextMessage(t.db, agent)),
    );
    const winners = results.filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.id).toBe(messageId);
    const [row] = await t.db
      .select({ attempts: agentChatMessage.attempts })
      .from(agentChatMessage)
      .where(eq(agentChatMessage.id, messageId));
    expect(row!.attempts).toBe(1);
  });
});
