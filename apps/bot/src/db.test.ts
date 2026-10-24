import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Db } from '@repo/db';
import { confirmTelegramLink } from './db';
import { createTestD1, insertPendingLink, type TestD1 } from './test-support';

// Redeeming a `/start` code is the only write this service makes, and it is where the
// link is decided: a code must work once, and a chat must not be taken over from
// another user. The pending rows the api mints are inserted directly here.

let testD1: TestD1;
let db: Db;

beforeAll(async () => {
  testD1 = await createTestD1();
  db = testD1.db;
});

afterAll(async () => {
  await testD1.dispose();
});

const pendingLink = (ttlMinutes?: number) => insertPendingLink(db, ttlMinutes);

describe('confirmTelegramLink', () => {
  it('links the chat and refuses to replay the code', async () => {
    const { userId, code } = await pendingLink();
    const chatId = randomUUID();

    const first = await confirmTelegramLink(db, {
      code,
      chatId,
      username: 'lin',
      firstName: 'Lin',
    });
    expect(first).toEqual({ ok: true, userId });

    const replay = await confirmTelegramLink(db, {
      code,
      chatId,
      username: 'lin',
      firstName: 'Lin',
    });
    expect(replay).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses a chat already linked to another user', async () => {
    const chatId = randomUUID();
    const first = await pendingLink();
    await confirmTelegramLink(db, { code: first.code, chatId, username: null, firstName: null });

    const second = await pendingLink();
    const result = await confirmTelegramLink(db, {
      code: second.code,
      chatId,
      username: null,
      firstName: null,
    });
    expect(result).toEqual({ ok: false, reason: 'taken' });
  });

  it('rejects an expired code', async () => {
    const { code } = await pendingLink(-1);
    const result = await confirmTelegramLink(db, {
      code,
      chatId: randomUUID(),
      username: null,
      firstName: null,
    });
    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects an unknown code', async () => {
    const result = await confirmTelegramLink(db, {
      code: 'nope',
      chatId: randomUUID(),
      username: null,
      firstName: null,
    });
    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });

  it('lets exactly one of N parallel redemptions of the same code link', async () => {
    const { userId, code } = await pendingLink();
    const chatId = randomUUID();

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        confirmTelegramLink(db, { code, chatId, username: null, firstName: null }),
      ),
    );
    expect(results.filter((r) => r.ok)).toEqual([{ ok: true, userId }]);
    expect(results.filter((r) => !r.ok)).toHaveLength(9);
  });

  it('lets exactly one of N parallel users take the same chat', async () => {
    const chatId = randomUUID();
    const pendings = await Promise.all(Array.from({ length: 10 }, () => pendingLink()));

    const results = await Promise.all(
      pendings.map((p) =>
        confirmTelegramLink(db, { code: p.code, chatId, username: null, firstName: null }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual(
      Array.from({ length: 9 }, () => ({ ok: false, reason: 'taken' })),
    );
  });
});
