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

// The bindings of the agent runtime. `RUN_QUEUE` and `BUCKET` are optional: without
// the queue a run waits for the next cron tick, without the bucket large span payloads
// are cut instead of stored. The span payloads live in the shared bucket under SPAN_PREFIX.
export interface AgentBindings {
  DB: D1Like;
  RUN_QUEUE?: RunQueueLike;
  BUCKET?: R2Like;
}

export const SPAN_PREFIX = 'spans/';

// The bucket seen through the span prefix: the exporter and the retention job keep using
// bare keys, the objects land under `spans/` next to the other users of the bucket.
export function prefixedBucket(bucket: R2Like, prefix = SPAN_PREFIX): R2Like {
  return {
    put: (key, value) => bucket.put(prefix + key, value),
    get: (key) => bucket.get(prefix + key),
    delete: (keys) =>
      bucket.delete(Array.isArray(keys) ? keys.map((k) => prefix + k) : prefix + keys),
  };
}

// The handle every function of the runtime that runs an agent takes first: the Drizzle
// client for our tables, the raw D1 binding Mastra's store needs, and the optional bucket
// and queue.
export interface AgentRuntime {
  db: Db;
  d1: D1Like;
  payloads: R2Like | null;
  // The whole bucket (attachments, imports), not just the span prefix; null without one.
  bucket: R2Bucket | null;
  queue: RunQueueLike | null;
  // The better-auth instance (`ctx.auth` in a route, `createAuth(env, db)` in a consumer):
  // an internal agent's own API key is issued through it.
  auth: AgentKeyAuth;
}

// The Worker's `Env` is accepted as is: its bindings are the workers-types classes, which
// satisfy the structural interfaces above at runtime but not for tsc (the api package does
// not load those types), hence the cast below.
export type AgentEnv = { DB: unknown; RUN_QUEUE?: unknown; BUCKET?: unknown };

export function agentRuntime(rawEnv: AgentEnv, auth: AgentKeyAuth): AgentRuntime {
  const env = rawEnv as unknown as AgentBindings;
  return {
    db: createDb(env.DB as unknown as Parameters<typeof createDb>[0]),
    d1: env.DB,
    payloads: env.BUCKET ? prefixedBucket(env.BUCKET) : null,
    bucket: (env.BUCKET as unknown as R2Bucket | undefined) ?? null,
    queue: env.RUN_QUEUE ?? null,
    auth,
  };
}

// Large JSON payloads of a span go to R2 above this size (D1 caps a row at 2 MB).
export const SPAN_INLINE_MAX_BYTES = 16 * 1024;

// The run queue of a Worker's `env`, for a caller that enqueues a run without building a whole
// runtime (issues/activity, issues/service): pass it as the `queue` argument of enqueueAgentRun.
export function runQueueOf(env: AgentEnv): RunQueueLike | null {
  return ((env as unknown as AgentBindings).RUN_QUEUE ?? null) as RunQueueLike | null;
}
