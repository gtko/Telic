// Worker tuning, read from the environment (Worker vars and secrets) behind a lazy getter.
// Every value has a sane default.

import { intEnv } from './env';

export interface WorkerConfig {
  // Max deliveries claimed and sent per cron run (also the concurrency ceiling).
  batchSize: number;
  // Per-delivery HTTP timeout.
  timeoutMs: number;
  // After this many attempts a failing delivery is marked failed (dead-letter).
  maxAttempts: number;
  // After this many consecutive failures a webhook is auto-disabled.
  disableThreshold: number;
  // How long a claimed row is leased before it becomes claimable again (crash
  // recovery). Must exceed timeoutMs comfortably.
  leaseSeconds: number;
  // Succeeded deliveries older than this are deleted by the periodic cleanup.
  cleanupDays: number;
  // Run the cleanup once every this many minutes (the cron fires every minute).
  cleanupEveryMinutes: number;
}

export function workerConfig(): WorkerConfig {
  return {
    batchSize: intEnv('WEBHOOK_BATCH_SIZE', 20),
    timeoutMs: intEnv('WEBHOOK_TIMEOUT_MS', 10_000),
    maxAttempts: intEnv('WEBHOOK_MAX_ATTEMPTS', 8),
    disableThreshold: intEnv('WEBHOOK_DISABLE_THRESHOLD', 20),
    leaseSeconds: intEnv('WEBHOOK_LEASE_SECONDS', 120),
    cleanupDays: intEnv('WEBHOOK_CLEANUP_DAYS', 30),
    cleanupEveryMinutes: intEnv('WEBHOOK_CLEANUP_EVERY_MINUTES', 60),
  };
}
