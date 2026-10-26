import { Elysia } from 'elysia';
import { dbContext } from '#shared/db-context';
import { errors } from '#shared/responses';
import { SentryWebhookAckResponse, sentryWebhookBody } from './model';
import { handleSentryDelivery } from './webhook';

// Inbound Sentry issue webhook. Unauthenticated (a delivery carries no session) and mounted
// on the root app, like the repository webhooks: the signature over the raw body, made with
// the Sentry client secret, is the authentication.
export const sentryWebhookRoutes = new Elysia({
  name: 'sentry-webhook',
  detail: { tags: ['Sentry'] },
})
  .use(dbContext)
  .post(
    '/api/sentry/webhook',
    async ({ db, headers, body }) => {
      const handled = await handleSentryDelivery(db, {
        resource: headers['sentry-hook-resource'],
        signature: headers['sentry-hook-signature'],
        body,
      });
      return { ok: true, handled };
    },
    {
      parse: 'text',
      body: sentryWebhookBody,
      response: { 200: SentryWebhookAckResponse, ...errors(400, 401) },
      detail: {
        summary: 'Receive a Sentry issue webhook',
        description:
          'Verify the Sentry-Hook-Signature header against the client secret, then create the ' +
          'Telic issue of a new Sentry issue in the triage column of its routed project, or move ' +
          'a closed linked issue back to triage when Sentry reports it unresolved.',
      },
    },
  );
