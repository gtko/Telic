import { createDb, type Db } from '@repo/db';
import type { AgentKeyAuth } from '../service';

// What the agent runtime needs from a Worker's `env`. Structural on purpose: the api
// package does not load @cloudflare/workers-types (they clash with bun's), and the
// Worker, the tests (Miniflare) and the queue consumer all hand in the real bindings.

export interface D1PreparedLike {
  bind(...values: unknown[]): D1PreparedLike;
}

export interface D1Like {
  prepare(sql: string): D1PreparedLike;
  batch(statements: D1PreparedLike[]): Promise<unknown[]>;
}

export interface R2Like {
  put(key: string, value: string): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  delete(keys: string | string[]): Promise<void>;
}

// The body of a message on the run queue: an identifier and nothing else (a message is
// capped at 128 KB, and the agent_run row stays the source of truth).
export interface RunMessage {
  runId: number;
}

export interface RunQueueLike {
  send(body: RunMessage, options?: { delaySeconds?: number }): Promise<void>;
  sendBatch(
    messages: { body: RunMessage; delaySeconds?: number }[],
    options?: { delaySeconds?: number },
  ): Promise<void>;
}

// The bindings of the agent runtime. `RUN_QUEUE` and `TRACE_PAYLOADS` are optional: without
// the queue a run waits for the next cron tick, without the bucket large span payloads
// are cut instead of stored.
export interface AgentBindings {
  DB: D1Like;
  RUN_QUEUE?: RunQueueLike;
  TRACE_PAYLOADS?: R2Like;
}

// The handle every function of the runtime that runs an agent takes first: the Drizzle
// client for our tables, the raw D1 binding Mastra's store needs, and the optional bucket
// and queue.
export interface AgentRuntime {
  db: Db;
  d1: D1Like;
  payloads: R2Like | null;
  queue: RunQueueLike | null;
  // The better-auth instance (`ctx.auth` in a route, `createAuth(env, db)` in a consumer):
  // an internal agent's own API key is issued through it.
  auth: AgentKeyAuth;
}

export function agentRuntime(env: AgentBindings, auth: AgentKeyAuth): AgentRuntime {
  return {
    db: createDb(env.DB as unknown as Parameters<typeof createDb>[0]),
    d1: env.DB,
    payloads: env.TRACE_PAYLOADS ?? null,
    queue: env.RUN_QUEUE ?? null,
    auth,
  };
}

// Large JSON payloads of a span go to R2 above this size (D1 caps a row at 2 MB).
export const SPAN_INLINE_MAX_BYTES = 16 * 1024;
