import type { Db } from '../client';
import { readSecret } from '../secrets';

// The instance Sentry integration, stored encrypted in app_secret under 'sentry'. The
// write side and the redacted view stay with the caller, as for the other instance
// secrets (see packages/auth/src/instance.ts).

export const SENTRY_SECRET_KEY = 'sentry';

export interface SentryConfig {
  authToken: string; // secret
  clientSecret: string; // secret, verifies the webhook signature
  orgSlug: string;
}

export async function getSentryConfig(db: Db): Promise<SentryConfig> {
  const stored = await readSecret<SentryConfig>(db, SENTRY_SECRET_KEY);
  // Merge over the default so a config written before a field was added stays valid.
  return { authToken: '', clientSecret: '', orgSlug: '', ...stored };
}
