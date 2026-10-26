import { t } from 'elysia';

// The raw body is verified against Sentry-Hook-Signature, so it arrives as text.
export const sentryWebhookBody = t.String();

export const SentryWebhookAckResponse = t.Object({ ok: t.Boolean(), handled: t.String() });
