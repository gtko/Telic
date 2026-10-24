import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { TELEGRAM_BOT_SECRET_KEY, userTelegramAccount, writeSecret, type Db } from '@repo/db';
import { createWorker, type Env } from './worker';
import { createTestD1, insertPendingLink, type TestD1 } from './test-support';

// The webhook end to end on a local D1: a Telegram update posted to the route reaches
// the bot, the bot answers through the Telegram API (faked here), and a request without
// the right secret is refused before anything is read or sent.

const WEBHOOK_SECRET = 'webhook-secret-for-tests';
const BOT_TOKEN = '123456:test-token';
const BOT_INFO = { id: 123456, is_bot: true, first_name: 'Telic', username: 'telic_test_bot' };

interface TelegramCall {
  method: string;
  body: Record<string, unknown>;
}

// Stands in for api.telegram.org: records each Bot API call and answers it as Telegram would.
function fakeTelegram(calls: TelegramCall[]): typeof fetch {
  const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ method, body });
    const result =
      method === 'getMe' ? BOT_INFO : { message_id: 1, date: 0, chat: { id: body.chat_id } };
    return Response.json({ ok: true, result });
  };
  return fake as unknown as typeof fetch;
}

// A text update as Telegram sends it. A leading "/command" carries a bot_command entity,
// which is how the bot recognises /start.
function update(text: string, chatId: number) {
  const command = /^\/\S+/.exec(text);
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 0,
      text,
      entities: command
        ? [{ type: 'bot_command', offset: 0, length: command[0].length }]
        : undefined,
      chat: { id: chatId, type: 'private', first_name: 'Lin' },
      from: { id: chatId, is_bot: false, first_name: 'Lin', username: 'lin' },
    },
  };
}

interface WebhookRequestOptions {
  // The segment after /telegram/webhook/.
  path?: string;
  // The secret header; null leaves the header out.
  header?: string | null;
  method?: string;
}

function webhook(body: unknown, options: WebhookRequestOptions = {}): Request {
  const { path = WEBHOOK_SECRET, header = WEBHOOK_SECRET, method = 'POST' } = options;
  const headers = new Headers({ 'content-type': 'application/json' });
  if (header !== null) headers.set('X-Telegram-Bot-Api-Secret-Token', header);
  return new Request(`https://bot.example.test/telegram/webhook/${path}`, {
    method,
    headers,
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
}

let testD1: TestD1;
let db: Db;
let env: Env;
let calls: TelegramCall[];
let worker: ReturnType<typeof createWorker>;
let nextChatId = 1_000_000;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY ??= 'test-app-encryption-key-not-for-production';
  testD1 = await createTestD1();
  db = testD1.db;
  env = { DB: testD1.binding, TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET };
});

afterAll(async () => {
  await testD1.dispose();
});

beforeEach(() => {
  calls = [];
  worker = createWorker({ telegramFetch: fakeTelegram(calls) });
});

async function configureBot(enabled = true): Promise<void> {
  const config = { enabled, botToken: BOT_TOKEN, botUsername: BOT_INFO.username };
  await writeSecret(db, TELEGRAM_BOT_SECRET_KEY, config, {
    enabled,
    botUsername: BOT_INFO.username,
  });
}

describe('telegram webhook', () => {
  it('delivers a valid update to the bot, which links the chat and answers', async () => {
    await configureBot();
    const { userId, code } = await insertPendingLink(db);
    const chatId = nextChatId++;

    const res = await worker.fetch(webhook(update(`/start ${code}`, chatId)), env);

    expect(res.status).toBe(200);
    const reply = calls.find((c) => c.method === 'sendMessage');
    expect(reply?.body).toMatchObject({
      chat_id: chatId,
      text: 'Your Telegram account is connected. Notifications will arrive here.',
    });
    const [row] = await db
      .select({ chatId: userTelegramAccount.chatId })
      .from(userTelegramAccount)
      .where(eq(userTelegramAccount.userId, userId));
    expect(row?.chatId).toBe(String(chatId));
  });

  it('answers 401 to a wrong secret header, without reading or sending anything', async () => {
    await configureBot();
    const { userId, code } = await insertPendingLink(db);

    const res = await worker.fetch(
      webhook(update(`/start ${code}`, nextChatId++), { header: 'not-the-secret' }),
      env,
    );

    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
    await expectCodeStillPending(userId, code);
  });

  it('answers 401 to a wrong secret in the path', async () => {
    await configureBot();
    const { userId, code } = await insertPendingLink(db);

    const res = await worker.fetch(
      webhook(update(`/start ${code}`, nextChatId++), { path: 'not-the-secret' }),
      env,
    );

    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
    await expectCodeStillPending(userId, code);
  });

  it('answers 401 when the secret header is missing', async () => {
    await configureBot();
    const res = await worker.fetch(webhook(update('/start', nextChatId++), { header: null }), env);
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('answers 401 to everything when no secret is configured', async () => {
    await configureBot();
    const unconfigured: Env = { DB: testD1.binding, TELEGRAM_WEBHOOK_SECRET: '' };

    // An empty header must not match an empty configured secret.
    const res = await worker.fetch(
      webhook(update('/start', nextChatId++), { path: 'x', header: '' }),
      unconfigured,
    );
    expect(res.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('answers 503 while the instance bot is switched off', async () => {
    await configureBot(false);
    const res = await worker.fetch(webhook(update('/start', nextChatId++)), env);
    expect(res.status).toBe(503);
    expect(calls).toEqual([]);
  });

  it('accepts only POST on the webhook route', async () => {
    await configureBot();
    const res = await worker.fetch(webhook(undefined, { method: 'GET' }), env);
    expect(res.status).toBe(405);
    expect(calls).toEqual([]);
  });

  async function expectCodeStillPending(userId: string, code: string): Promise<void> {
    const [row] = await db
      .select({ linkCode: userTelegramAccount.linkCode })
      .from(userTelegramAccount)
      .where(eq(userTelegramAccount.userId, userId));
    expect(row?.linkCode).toBe(code);
  }
});
