import { t } from 'elysia';
import { IssueResponse } from '#modules/issues/model';

// The raw body is verified against Sentry-Hook-Signature, so it arrives as text.
export const sentryWebhookBody = t.String();

export const SentryWebhookAckResponse = t.Object({ ok: t.Boolean(), handled: t.String() });

export const triageIssueParams = t.Object({ projectKey: t.String(), issueId: t.Numeric() });

export const triageMergeBody = t.Object({ targetIssueId: t.Integer() });

export const TriageIssuesResponse = t.Array(IssueResponse);
