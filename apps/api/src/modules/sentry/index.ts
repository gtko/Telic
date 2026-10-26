import { Elysia } from 'elysia';
import { requireUser } from '#shared/access';
import { authContext } from '#shared/auth-context';
import { dbContext } from '#shared/db-context';
import { guards } from '#shared/guards';
import { accessErrors, commonErrors, errors } from '#shared/responses';
import { IssueResponse, projectKeyParams } from '#modules/issues/model';
import {
  SentryWebhookAckResponse,
  TriageIssuesResponse,
  sentryWebhookBody,
  triageIssueParams,
  triageMergeBody,
} from './model';
import { acceptIssue, listTriageIssues, mergeIssue, rejectIssue } from './triage';
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
        contentLength: headers['content-length'],
        body,
      });
      return { ok: true, handled };
    },
    {
      parse: 'text',
      body: sentryWebhookBody,
      response: { 200: SentryWebhookAckResponse, ...errors(400, 401, 413) },
      detail: {
        summary: 'Receive a Sentry issue webhook',
        description:
          'Verify the Sentry-Hook-Signature header against the client secret, then create the ' +
          'Telic issue of a new Sentry issue in the triage column of its routed project, or move ' +
          'a closed linked issue back to triage when Sentry reports it unresolved.',
      },
    },
  );

// Triage of the issues in the triage column. Session-protected, mounted in planner.ts.
export const sentryTriageRoutes = new Elysia({
  name: 'sentry-triage',
  detail: { tags: ['Issues'] },
})
  .use(authContext)
  .use(guards)
  .get('/projects/:projectKey/triage', async ({ db, project }) => listTriageIssues(db, project), {
    params: projectKeyParams,
    permission: ['work_items', 'read'],
    response: { 200: TriageIssuesResponse, ...accessErrors },
    detail: { summary: 'List the issues in triage' },
  })
  .post(
    '/projects/:projectKey/triage/:issueId/accept',
    async ({ db, project, params, user }) =>
      acceptIssue(db, project, params.issueId, requireUser(user).id),
    {
      params: triageIssueParams,
      permission: ['work_items', 'edit'],
      response: { 200: IssueResponse, ...commonErrors, ...errors(409) },
      detail: { summary: 'Accept a triaged issue into the backlog' },
    },
  )
  .post(
    '/projects/:projectKey/triage/:issueId/reject',
    async ({ db, project, params, user }) =>
      rejectIssue(db, project, params.issueId, requireUser(user).id),
    {
      params: triageIssueParams,
      permission: ['work_items', 'edit'],
      response: { 200: IssueResponse, ...commonErrors, ...errors(409) },
      detail: { summary: 'Reject a triaged issue into the canceled column' },
    },
  )
  .post(
    '/projects/:projectKey/triage/:issueId/merge',
    async ({ db, project, params, body, user }) =>
      mergeIssue(db, project, params.issueId, body.targetIssueId, requireUser(user).id),
    {
      params: triageIssueParams,
      body: triageMergeBody,
      permission: ['work_items', 'edit'],
      response: { 200: IssueResponse, ...commonErrors, ...errors(409) },
      detail: { summary: 'Merge a triaged issue into another issue as its duplicate' },
    },
  );
