import { request } from '@/lib/api/core/client';
import type { Issue } from '@/lib/api/endpoints/issues';

export interface SentrySettings {
  orgSlug: string;
  hasAuthToken: boolean;
  hasClientSecret: boolean;
  webhookUrl: string;
}

// An omitted or empty secret keeps the stored one.
export interface SentrySettingsPatch {
  orgSlug?: string;
  authToken?: string;
  clientSecret?: string;
}

// Which Telic project receives the issues of one Sentry project.
export interface SentryRoute {
  id: number;
  sentryProjectSlug: string;
  projectId: number;
  projectKey: string;
  projectName: string;
}

export const getSentrySettings = () => request<SentrySettings>('/god/sentry');

export const updateSentrySettings = (patch: SentrySettingsPatch) =>
  request<SentrySettings>('/god/sentry', { method: 'PUT', body: JSON.stringify(patch) });

export const listSentryRoutes = () => request<SentryRoute[]>('/god/sentry/routes');

export const upsertSentryRoute = (body: { sentryProjectSlug: string; projectId: number }) =>
  request<SentryRoute>('/god/sentry/routes', { method: 'PUT', body: JSON.stringify(body) });

export const deleteSentryRoute = (id: number) =>
  request<void>(`/god/sentry/routes/${id}`, { method: 'DELETE' });

export const listTriageIssues = (projectKey: string) =>
  request<Issue[]>(`/projects/${projectKey}/triage`);

export const acceptTriageIssue = (projectKey: string, issueId: number) =>
  request<Issue>(`/projects/${projectKey}/triage/${issueId}/accept`, { method: 'POST' });

export const rejectTriageIssue = (projectKey: string, issueId: number) =>
  request<Issue>(`/projects/${projectKey}/triage/${issueId}/reject`, { method: 'POST' });

export const mergeTriageIssue = (projectKey: string, issueId: number, targetIssueId: number) =>
  request<Issue>(`/projects/${projectKey}/triage/${issueId}/merge`, {
    method: 'POST',
    body: JSON.stringify({ targetIssueId }),
  });
