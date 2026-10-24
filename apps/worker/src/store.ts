import { webhook, webhookDelivery, type Db } from '@repo/db';
import { eq, sql } from 'drizzle-orm';
import { allRows, parseJson, runChanges } from './d1';
import { workerConfig } from './config';

export interface ClaimedDelivery {
  id: number;
  webhookId: number;
  eventId: string;
  eventType: string;
  payload: unknown;
  attempts: number;
  url: string;
  secret: string;
  isActive: boolean;
}

interface ClaimedRow extends Omit<ClaimedDelivery, 'payload' | 'isActive'> {
  payload: string;
  isActive: number;
}

// Atomically claims up to batchSize due deliveries. D1 serializes writes, so the single
// UPDATE ... WHERE id IN (SELECT ...) is the whole lock: of two consumers claiming at once the
// second one sees the first one's pushed next_attempt_at and never grabs the same row. Claiming
// pushes next_attempt_at forward by the lease and bumps attempts, so a row whose worker crashes
// mid-delivery becomes claimable again after the lease, with no separate recovery pass. The
// webhook's url/secret/is_active are read inline. `nowMs` is the caller's clock.
export async function claimDueDeliveries(
  db: Db,
  nowMs: number = Date.now(),
): Promise<ClaimedDelivery[]> {
  const { batchSize, leaseSeconds } = workerConfig();
  const rows = await allRows<ClaimedRow>(
    db,
    `UPDATE webhook_delivery
     SET attempts = attempts + 1, next_attempt_at = ?
     WHERE status = 'pending' AND next_attempt_at <= ? AND id IN (
       SELECT id FROM webhook_delivery
       WHERE status = 'pending' AND next_attempt_at <= ?
       ORDER BY next_attempt_at, id
       LIMIT ?
     )
     RETURNING
       id,
       webhook_id AS webhookId,
       event_id AS eventId,
       event_type AS eventType,
       payload,
       attempts,
       (SELECT url FROM webhook w WHERE w.id = webhook_delivery.webhook_id) AS url,
       (SELECT secret FROM webhook w WHERE w.id = webhook_delivery.webhook_id) AS secret,
       (SELECT is_active FROM webhook w WHERE w.id = webhook_delivery.webhook_id) AS isActive`,
    [nowMs + leaseSeconds * 1000, nowMs, nowMs, batchSize],
  );
  return rows.map((r) => ({
    ...r,
    payload: parseJson<unknown>(r.payload, null),
    isActive: r.isActive === 1,
  }));
}

// The receiver's response recorded for the history view. Absent on a network or
// timeout error (no response arrived).
export interface DeliveryResponse {
  status?: number;
  body?: string;
}

export async function markSuccess(
  db: Db,
  deliveryId: number,
  webhookId: number,
  response: DeliveryResponse,
): Promise<void> {
  await db.batch([
    db
      .update(webhookDelivery)
      .set({
        status: 'success',
        lastError: null,
        responseStatus: response.status ?? null,
        responseBody: response.body ?? null,
      })
      .where(eq(webhookDelivery.id, deliveryId)),
    db.update(webhook).set({ consecutiveFailures: 0 }).where(eq(webhook.id, webhookId)),
  ]);
}

export async function scheduleRetry(
  db: Db,
  deliveryId: number,
  webhookId: number,
  delayMs: number,
  error: string,
  response: DeliveryResponse,
  nowMs: number = Date.now(),
): Promise<void> {
  const delaySeconds = Math.max(1, Math.ceil(delayMs / 1000));
  await db.batch([
    db
      .update(webhookDelivery)
      .set({
        status: 'pending',
        nextAttemptAt: new Date(nowMs + delaySeconds * 1000),
        lastError: error.slice(0, 500),
        responseStatus: response.status ?? null,
        responseBody: response.body ?? null,
      })
      .where(eq(webhookDelivery.id, deliveryId)),
    bumpWebhookFailure(db, webhookId),
  ]);
}

export async function markFailed(
  db: Db,
  deliveryId: number,
  webhookId: number,
  error: string,
  response: DeliveryResponse,
): Promise<void> {
  await db.batch([
    db
      .update(webhookDelivery)
      .set({
        status: 'failed',
        lastError: error.slice(0, 500),
        responseStatus: response.status ?? null,
        responseBody: response.body ?? null,
      })
      .where(eq(webhookDelivery.id, deliveryId)),
    bumpWebhookFailure(db, webhookId),
  ]);
}

// A delivery claimed for a webhook that is no longer active (auto-disabled or
// disabled by a user after the row was queued). Drop it without counting another
// failure against the already-disabled webhook.
export async function markSkippedInactive(db: Db, deliveryId: number): Promise<void> {
  await db
    .update(webhookDelivery)
    .set({ status: 'failed', lastError: 'webhook disabled' })
    .where(eq(webhookDelivery.id, deliveryId));
}

// Increments the webhook's consecutive-failure counter and auto-disables it once
// the counter reaches the threshold, in one statement (returned as a builder so the
// caller batches it with the delivery update).
function bumpWebhookFailure(db: Db, webhookId: number) {
  const { disableThreshold } = workerConfig();
  return db
    .update(webhook)
    .set({
      consecutiveFailures: sql`${webhook.consecutiveFailures} + 1`,
      isActive: sql`(${webhook.consecutiveFailures} + 1) < ${disableThreshold}`,
    })
    .where(eq(webhook.id, webhookId));
}

// Deletes succeeded deliveries older than the cleanup window. Best-effort; returns
// the number removed.
export async function cleanupOldDeliveries(db: Db, nowMs: number = Date.now()): Promise<number> {
  const { cleanupDays } = workerConfig();
  return runChanges(
    db,
    `DELETE FROM webhook_delivery WHERE status = 'success' AND created_at < ?`,
    [nowMs - cleanupDays * 86_400_000],
  );
}
