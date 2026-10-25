import { createDb, type Db } from '@repo/db';
import { useR2Bucket } from '@repo/storage';
import { workerConfig } from './config';
import { deliver } from './delivery';
import { equalJitterBackoffMs } from './backoff';
import { processImportTick } from './import-worker';
import { hasDueImportJobs } from './import-store';
import { hasDueNotifications, processNotificationDeliveries } from './notification-delivery';
import {
  type ClaimedDelivery,
  claimDueDeliveries,
  markSuccess,
  scheduleRetry,
  markFailed,
  markSkippedInactive,
  cleanupOldDeliveries,
} from './store';

// Entry point of the Worker: a Cron Trigger every minute (webhook deliveries
// and the wake-ups of the heavy jobs) and the Queue consumer that runs
// those heavy jobs (source imports, notification bursts). The queue message is only a
// wake-up: the consumer claims the work itself, so a duplicate or late message is harmless.

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  JOBS: Queue<JobMessage>;
  [setting: string]: unknown;
}

export type JobMessage = { kind: 'import' } | { kind: 'notifications' };

// Notification batches drained per queue message (20 rows each, a handful of queries a row).
const MAX_NOTIFICATION_BATCHES = 5;

function connect(env: Env): Db {
  useR2Bucket(env.BUCKET);
  return createDb(env.DB);
}

// Cron: the cheap, bounded work runs inline; the heavy work is handed to the queue.
export async function runScheduled(db: Db, env: Env, nowMs: number): Promise<void> {
  const cfg = workerConfig();
  const claimed = await claimDueDeliveries(db, nowMs);
  if (claimed.length > 0) await Promise.all(claimed.map((d) => processDelivery(db, d, nowMs)));

  if (await hasDueNotifications(db, nowMs)) await wake(env, { kind: 'notifications' }, db);
  if (await hasDueImportJobs(db, nowMs)) await wake(env, { kind: 'import' }, db);

  if (new Date(nowMs).getUTCMinutes() % Math.max(1, cfg.cleanupEveryMinutes) === 0) {
    const removed = await cleanupOldDeliveries(db, nowMs);
    if (removed > 0) console.log(`[worker] cleaned up ${removed} old deliveries`);
  }
}

// Queue: runs the job a message names. Without a queue binding (a local run) the cron runs
// the job inline instead.
export async function runJob(db: Db, env: Env, message: JobMessage): Promise<void> {
  if (message.kind === 'notifications') {
    for (let i = 0; i < MAX_NOTIFICATION_BATCHES; i++) {
      if ((await processNotificationDeliveries(db)) === 0) return;
    }
    if (await hasDueNotifications(db)) await wake(env, message, db);
    return;
  }
  await processImportTick(db);
  // The tick re-arms the job as due when it has more to do: continue without waiting a minute.
  if (await hasDueImportJobs(db)) await wake(env, message, db);
}

async function wake(env: Env, message: JobMessage, db: Db): Promise<void> {
  if (env.JOBS) {
    await env.JOBS.send(message);
    return;
  }
  await runJob(db, { ...env, JOBS: undefined as never }, message);
}

async function processDelivery(db: Db, d: ClaimedDelivery, nowMs: number): Promise<void> {
  const cfg = workerConfig();
  if (!d.isActive) {
    await markSkippedInactive(db, d.id);
    return;
  }
  const body = JSON.stringify(d.payload);
  const result = await deliver({
    url: d.url,
    secret: d.secret,
    deliveryId: d.id,
    eventId: d.eventId,
    eventType: d.eventType,
    body,
    timeoutMs: cfg.timeoutMs,
  });
  const response = { status: result.status, body: result.responseBody };
  if (result.ok) {
    await markSuccess(db, d.id, d.webhookId, response);
    return;
  }
  if (result.retryable && d.attempts < cfg.maxAttempts) {
    await scheduleRetry(
      db,
      d.id,
      d.webhookId,
      equalJitterBackoffMs(d.attempts),
      result.error ?? 'delivery failed',
      response,
      nowMs,
    );
    return;
  }
  await markFailed(db, d.id, d.webhookId, result.error ?? 'delivery failed', response);
}

export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    await runScheduled(connect(env), env, controller.scheduledTime);
  },

  async queue(batch: MessageBatch<JobMessage>, env: Env): Promise<void> {
    const db = connect(env);
    for (const message of batch.messages) {
      try {
        await runJob(db, env, message.body);
        message.ack();
      } catch (error) {
        console.error('[worker] job failed:', error);
        message.retry();
      }
    }
  },
};
