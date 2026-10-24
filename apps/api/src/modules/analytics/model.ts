import { t } from 'elysia';
import { ActivityPayloadResponse } from '#shared/activity';
import { instantQuery } from '#shared/schemas';

export const StatsDto = t.Object({
  open: t.Number(),
  inProgress: t.Number(),
  backlog: t.Number(),
  overdue: t.Number(),
  unassigned: t.Number(),
  closedLast7d: t.Number(),
});

const BreakdownItem = t.Object({
  key: t.String(),
  label: t.String(),
  count: t.Number(),
  color: t.Nullable(t.String()),
});

const PulseBucket = t.Object({
  label: t.String(),
  count: t.Number(),
});

const ThroughputWeek = t.Object({
  week: t.String(),
  created: t.Number(),
  closed: t.Number(),
});

const BurnupDay = t.Object({
  date: t.String(),
  scope: t.Number(),
  started: t.Number(),
  completed: t.Number(),
});

export const BurnupDto = t.Object({
  days: t.Array(BurnupDay),
  forecast: t.Object({
    windowDays: t.Number(),
    velocityPerDay: t.Number(),
    scopeGrowthPerDay: t.Number(),
    remaining: t.Number(),
    projectedScope: t.Number(),
    projectedDate: t.Nullable(t.String()),
    optimisticDate: t.Nullable(t.String()),
    pessimisticDate: t.Nullable(t.String()),
  }),
  targetDate: t.Nullable(t.String()),
});

const ActivityItem = t.Object({
  id: t.Number(),
  issueId: t.Number(),
  issueSequence: t.Number(),
  issueTitle: t.String(),
  kind: t.String(),
  actorUserId: t.Nullable(t.String()),
  actorName: t.Nullable(t.String()),
  body: t.Nullable(t.String()),
  action: t.Nullable(t.String()),
  payload: ActivityPayloadResponse,
  createdAt: t.String(),
});

const ActivityCursorDto = t.Object({
  ts: t.String(),
  id: t.Number(),
});

export const ActivityPage = t.Object({
  items: t.Array(ActivityItem),
  nextCursor: t.Nullable(ActivityCursorDto),
});

export const WebhookStatsDto = t.Object({
  total: t.Number(),
  success: t.Number(),
  failed: t.Number(),
  pending: t.Number(),
  activeWebhooks: t.Number(),
  disabledWebhooks: t.Number(),
});

export const BreakdownListResponse = t.Array(BreakdownItem);

export const PulseListResponse = t.Array(PulseBucket);

export const ThroughputListResponse = t.Array(ThroughputWeek);

export const breakdownQuery = t.Object({
  by: t.Union([
    t.Literal('status'),
    t.Literal('priority'),
    t.Literal('type'),
    t.Literal('assignee'),
  ]),
});

export const pulseQuery = t.Object({
  scope: t.Optional(t.Union([t.Literal('project'), t.Literal('me')])),
  unit: t.Optional(t.Union([t.Literal('hour'), t.Literal('day'), t.Literal('week')])),
  columns: t.Optional(t.Numeric()),
});

export const throughputQuery = t.Object({ weeks: t.Optional(t.Numeric()) });

export const burnupQuery = t.Object({
  days: t.Optional(t.Numeric()),
  initiativeId: t.Optional(t.Numeric()),
  forecastWeeks: t.Optional(t.Numeric()),
});

export const activityQuery = t.Object({
  limit: t.Optional(t.Numeric({ description: 'Max entries (1-100). Default 25.' })),
  cursor: t.Optional(
    t.String({ description: 'nextCursor of the previous page, as a JSON string.' }),
  ),
  actorUserId: t.Optional(t.String()),
  action: t.Optional(
    t.String({ description: "Change-log action, such as 'created' or 'status'." }),
  ),
  from: instantQuery('Inclusive earliest entry time.'),
  to: instantQuery('Exclusive latest entry time.'),
  // Comma-separated issue ids the client resolved from the widget's work items
  // filter; absent means no issue-scope restriction.
  issueIds: t.Optional(t.String()),
});

export const daysQuery = t.Object({ days: t.Optional(t.Numeric()) });
