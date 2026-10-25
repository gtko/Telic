import type { BreakdownBy } from '@/utils/dashboardWidgets';
import { request } from '@/lib/api/core/client';
import type { ActivityPage, FeedCursor } from '@/lib/api/endpoints/activity';

export interface AnalyticsStats {
  open: number;
  inProgress: number;
  backlog: number;
  overdue: number;
  unassigned: number;
  closedLast7d: number;
}

export interface BreakdownItem {
  key: string;
  label: string;
  count: number;
  color: string | null;
}

export type PulseUnit = 'hour' | 'day' | 'week';

// One heatmap cell from the server: a preformatted bucket label (for the hover
// tooltip) and its activity count. The series is ordered oldest to newest.
export interface PulseBucket {
  label: string;
  count: number;
}

export interface ThroughputWeek {
  week: string;
  created: number;
  closed: number;
}

// The state of the project's issues at the end of one day (burnup widget).
export interface BurnupDay {
  date: string;
  scope: number;
  started: number;
  completed: number;
}

// A completion date projected from the rates over the last windowDays days: the
// remaining issues plus the ones expected to appear, at the scope growth rate,
// while they are closed at the closing rate; null when nothing closed in the
// window or nothing is left. projectedScope is the scope the projection ends at.
export interface BurnupForecast {
  windowDays: number;
  velocityPerDay: number;
  scopeGrowthPerDay: number;
  remaining: number;
  projectedScope: number;
  projectedDate: string | null;
  // The projected date with the days to go shortened and lengthened by about
  // 40%; null together with projectedDate.
  optimisticDate: string | null;
  pessimisticDate: string | null;
}

export interface Burnup {
  days: BurnupDay[];
  forecast: BurnupForecast;
  targetDate: string | null;
}

export interface BurnupParams {
  days: number;
  initiativeId: number | null;
  forecastWeeks: number;
}

// Webhook delivery health over a window plus the subscription split (webhook health widget).
export interface WebhookStats {
  total: number;
  success: number;
  failed: number;
  pending: number;
  activeWebhooks: number;
  disabledWebhooks: number;
}

// Analytics — read-only project metrics behind the dashboard widgets.
export const getBreakdown = (projectKey: string, by: BreakdownBy) =>
  request<BreakdownItem[]>(`/projects/${projectKey}/analytics/breakdown?by=${by}`);

export const getPulse = (
  projectKey: string,
  unit: PulseUnit,
  columns: number,
  scope: 'project' | 'me' = 'project',
) =>
  request<PulseBucket[]>(
    `/projects/${projectKey}/analytics/pulse?unit=${unit}&columns=${columns}&scope=${scope}`,
  );

export const getThroughput = (projectKey: string, weeks = 12) =>
  request<ThroughputWeek[]>(`/projects/${projectKey}/analytics/throughput?weeks=${weeks}`);

export const getBurnup = (projectKey: string, params: BurnupParams) => {
  const q = new URLSearchParams({
    days: String(params.days),
    forecastWeeks: String(params.forecastWeeks),
  });
  if (params.initiativeId != null) q.set('initiativeId', String(params.initiativeId));
  return request<Burnup>(`/projects/${projectKey}/analytics/burnup?${q}`);
};

export const listActivity = (
  projectKey: string,
  params: {
    cursor?: FeedCursor | null;
    limit?: number;
    actorUserId?: string | null;
    action?: string | null;
    issueIds?: number[] | null;
  } = {},
) => {
  const q = new URLSearchParams();
  if (params.limit) q.set('limit', String(params.limit));
  if (params.cursor) q.set('cursor', JSON.stringify(params.cursor));
  if (params.actorUserId != null) q.set('actorUserId', params.actorUserId);
  if (params.action) q.set('action', params.action);
  if (params.issueIds) q.set('issueIds', params.issueIds.join(','));
  const qs = q.toString();
  return request<ActivityPage>(`/projects/${projectKey}/analytics/activity${qs ? `?${qs}` : ''}`);
};

export const getWebhookStats = (projectKey: string, days = 30) =>
  request<WebhookStats>(`/projects/${projectKey}/analytics/webhook-stats?days=${days}`);
