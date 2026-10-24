import { notificationDelivery, type Db, type DeliveryPayload } from '@repo/db';
import { eq } from 'drizzle-orm';
import { allRows, parseJson } from './d1';
import { equalJitterBackoffMs } from './backoff';
import { intEnv } from './env';
import { deliverNotification, type SendResult } from './notification-send';

// Drains the notification_delivery outbox: claims due rows and sends each one.
// Follows the same claim/retry pattern as webhook delivery. A succeeded row is
// deleted (no delivery history is kept); a permanently failed row is left as
// 'failed' with its last error for debugging.

export interface ClaimedNotification {
  id: number;
  projectId: number;
  channel: string;
  recipient: string | null;
  payload: DeliveryPayload;
  attempts: number;
}

// Claims and sends one batch. Returns how many rows it took, so a caller draining the
// outbox knows whether another batch may be waiting.
export async function processNotificationDeliveries(
  db: Db,
  nowMs: number = Date.now(),
): Promise<number> {
  const claimed = await claimDueNotifications(db, nowMs);
  await Promise.all(claimed.map((d) => processDelivery(db, d, nowMs)));
  return claimed.length;
}

// Whether a row is due, for the cron to decide to wake the queue consumer.
export async function hasDueNotifications(db: Db, nowMs: number = Date.now()): Promise<boolean> {
  const rows = await allRows<{ one: number }>(
    db,
    `SELECT 1 AS one FROM notification_delivery WHERE status = 'pending' AND next_attempt_at <= ? LIMIT 1`,
    [nowMs],
  );
  return rows.length > 0;
}

// Atomically claims up to the batch size of due rows. D1 serializes writes, so the one
// UPDATE ... WHERE id IN (SELECT ...) is the lock: two consumers never get the same row. The
// claim leases the row by pushing next_attempt_at forward, so a row whose worker crashes
// mid-send becomes claimable again after the lease.
export async function claimDueNotifications(
  db: Db,
  nowMs: number = Date.now(),
): Promise<ClaimedNotification[]> {
  const batchSize = intEnv('NOTIFICATION_BATCH_SIZE', 20);
  const leaseSeconds = intEnv('NOTIFICATION_LEASE_SECONDS', 120);
  const rows = await allRows<Omit<ClaimedNotification, 'payload'> & { payload: string }>(
    db,
    `UPDATE notification_delivery
     SET attempts = attempts + 1, next_attempt_at = ?
     WHERE status = 'pending' AND next_attempt_at <= ? AND id IN (
       SELECT id FROM notification_delivery
       WHERE status = 'pending' AND next_attempt_at <= ?
       ORDER BY next_attempt_at, id
       LIMIT ?
     )
     RETURNING id, project_id AS projectId, channel, recipient, payload, attempts`,
    [nowMs + leaseSeconds * 1000, nowMs, nowMs, batchSize],
  );
  return rows.map((r) => ({
    ...r,
    payload: parseJson<DeliveryPayload>(r.payload, {} as DeliveryPayload),
  }));
}

async function processDelivery(db: Db, d: ClaimedNotification, nowMs: number): Promise<void> {
  let result: SendResult;
  try {
    result = await deliverNotification(db, d);
  } catch (err) {
    result = {
      ok: false,
      retryable: true,
      error: err instanceof Error ? err.message : 'send failed',
    };
  }

  if (result.ok) {
    await db.delete(notificationDelivery).where(eq(notificationDelivery.id, d.id));
    return;
  }

  const maxAttempts = intEnv('NOTIFICATION_MAX_ATTEMPTS', 5);
  const error = (result.error ?? 'delivery failed').slice(0, 500);
  if (result.retryable && d.attempts < maxAttempts) {
    const delaySeconds = Math.ceil(equalJitterBackoffMs(d.attempts, 30_000, 30 * 60_000) / 1000);
    await db
      .update(notificationDelivery)
      .set({ nextAttemptAt: new Date(nowMs + delaySeconds * 1000), lastError: error })
      .where(eq(notificationDelivery.id, d.id));
    return;
  }
  await db
    .update(notificationDelivery)
    .set({ status: 'failed', lastError: error })
    .where(eq(notificationDelivery.id, d.id));
}
