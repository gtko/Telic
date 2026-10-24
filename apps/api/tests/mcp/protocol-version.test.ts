import { describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { createAuth } from '@repo/auth';
import { db } from '../helpers/db';
import { app } from '../helpers/app';
import { signUpTestUser } from '../helpers/auth';

const initializeParams = {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'test', version: '1' },
};

async function post(
  apiKey: string | null,
  message: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return app.handle(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', ...message }),
    }),
  );
}

async function apiKey() {
  const user = await signUpTestUser({ email: 'protocol@example.com' });
  return (
    await createAuth(env, db).api.createApiKey({ body: { userId: user.userId, name: 'mcp' } })
  ).key;
}

describe('MCP protocol version', () => {
  it('answers server/discover with a JSON-RPC method-not-found, not a 400', async () => {
    const res = await post(
      await apiKey(),
      { id: 7, method: 'server/discover', params: {} },
      { 'mcp-method': 'server/discover', 'mcp-protocol-version': '2026-07-28' },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: number; error: { code: number; data: unknown } };
    expect(body.id).toBe(7);
    expect(body.error.code).toBe(-32601);
    expect(body.error.data).toHaveProperty('supported');
  });

  it('still asks an unauthenticated server/discover to authenticate', async () => {
    const res = await post(null, { id: 1, method: 'server/discover' });

    expect(res.status).toBe(401);
  });

  it('refuses an unsupported version on a later request with the supported list', async () => {
    const res = await post(
      await apiKey(),
      { id: 2, method: 'tools/list' },
      { 'mcp-protocol-version': '2026-07-28' },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { data: { supported: string[] } } };
    expect(body.error.data.supported).toContain('2025-11-25');
  });

  it('negotiates initialize whatever the version header says', async () => {
    const res = await post(
      await apiKey(),
      { id: 3, method: 'initialize', params: initializeParams },
      { 'mcp-protocol-version': '2026-07-28' },
    );

    expect(res.status).toBe(200);
  });
});

describe('route validators', () => {
  it('are built without the exactMirror fallback warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const key = await apiKey();
    const res = await post(key, { id: 4, method: 'tools/list' });
    const text = await res.text();
    const { tools } = JSON.parse(text.slice(text.indexOf('data: ') + 6)).result as {
      tools: { name: string }[];
    };
    const create = tools.find((tool) => tool.name.startsWith('create_'))!;
    await post(key, { id: 5, method: 'tools/call', params: { name: create.name, arguments: {} } });

    const messages = warn.mock.calls.flat().filter((m) => String(m).includes('exactMirror'));
    warn.mockRestore();
    expect(messages).toEqual([]);
  });
});
