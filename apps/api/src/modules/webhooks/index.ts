import { Elysia, t } from 'elysia';
import { noContent } from '#shared/http';
import { guards, entityGuard } from '#shared/guards';
import { authContext } from '#shared/auth-context';
import { dbContext } from '#shared/db-context';
import { HttpError } from '#shared/lib';
import { assertPublicHttpUrl } from '#shared/net';
import { mcpTool } from '#mcp/generate';
import { accessErrors, commonErrors } from '#shared/responses';
import {
  WebhookDeliveryPageResponse,
  WebhookResponse,
  createWebhookBody,
  listDeliveriesQuery,
  updateWebhookBody,
  webhookParams,
} from './model';
import {
  listWebhooks,
  createWebhook,
  getWebhook,
  updateWebhook,
  deleteWebhook,
  listWebhookDeliveries,
} from './service';

export const webhookRoutes = new Elysia({ name: 'webhooks', detail: { tags: ['Webhooks'] } })
  .use(authContext)
  .use(dbContext)
  .use(guards)
  .macro({
    webhook: entityGuard(
      'webhooks',
      'Webhook not found',
      async (p, { db }) => (await getWebhook(db, Number(p.webhookId)))?.projectId ?? null,
    ),
  })
  .get(
    '/projects/:projectKey/webhooks',
    async ({ db, project }) => {
      return listWebhooks(db, project.id);
    },
    {
      permission: ['webhooks', 'read'],
      response: { 200: t.Array(WebhookResponse), ...accessErrors },
      detail: { summary: "List a project's webhooks", ...mcpTool('list_webhooks') },
    },
  )

  .post(
    '/projects/:projectKey/webhooks',
    async ({ db, project, body, set }) => {
      await assertPublicHttpUrl(body.url);
      set.status = 201;
      return createWebhook(db, {
        projectId: project.id,
        url: body.url,
        events: body.events,
        isActive: body.isActive,
      });
    },
    {
      body: createWebhookBody,
      permission: ['webhooks', 'create'],
      response: { 201: WebhookResponse, ...commonErrors },
      detail: { summary: 'Create a webhook', ...mcpTool('create_webhook') },
    },
  )

  .patch(
    '/webhooks/:webhookId',
    async ({ db, params, body }) => {
      if (body.url !== undefined) await assertPublicHttpUrl(body.url);
      const updated = await updateWebhook(db, params.webhookId, body);
      if (!updated) throw new HttpError(404, 'Webhook not found');
      return updated;
    },
    {
      body: updateWebhookBody,
      params: webhookParams,
      webhook: 'edit',
      response: { 200: WebhookResponse, ...commonErrors },
      detail: { summary: 'Update a webhook', ...mcpTool('update_webhook') },
    },
  )

  .delete(
    '/webhooks/:webhookId',
    async ({ db, params }) => {
      await deleteWebhook(db, params.webhookId);
      return noContent();
    },
    {
      params: webhookParams,
      webhook: 'delete',
      response: { 204: t.Void(), ...commonErrors },
      detail: { summary: 'Delete a webhook', ...mcpTool('delete_webhook') },
    },
  )

  .get(
    '/webhooks/:webhookId/deliveries',
    async ({ db, params, query }) => {
      return listWebhookDeliveries(db, params.webhookId, {
        before: query.before,
        limit: query.limit,
      });
    },
    {
      params: webhookParams,
      query: listDeliveriesQuery,
      webhook: 'read',
      response: { 200: WebhookDeliveryPageResponse, ...commonErrors },
      detail: {
        summary: 'List webhook deliveries',
        description: "List a webhook's delivery attempts.",
        ...mcpTool('list_webhook_deliveries'),
      },
    },
  );
