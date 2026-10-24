import {
  issue,
  projectColumn,
  projectMember,
  issueActivity,
  issueType,
  user,
  aiAgent,
  agentRun,
  webhook,
  webhookDelivery,
  initiative,
  type ActivityPayload,
  type Db,
} from '@repo/db';
import { and, desc, eq, gte, inArray, isNull, isNotNull, lt, sql } from 'drizzle-orm';
import { HttpError, iso } from '#shared/lib';
import type { AgentRunTrigger } from '#modules/agents/model';

// Read-only project metrics for the dashboards feature. Every figure is derived
// from the existing issue / project_column / issue_activity / issue_status tables —
// there is no analytics storage. Timestamps are stored as epoch milliseconds, and the
// calendar boundaries (day, ISO week) are UTC.

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const WEEK_MS = 7 * DAY_MS;

const startOfDay = (ms: number) => Math.floor(ms / DAY_MS) * DAY_MS;
// The Monday of the week holding `ms` (the epoch day 0 is a Thursday).
const startOfWeek = (ms: number) => {
  const day = Math.floor(ms / DAY_MS);
  return (day - ((day + 3) % 7)) * DAY_MS;
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const two = (n: number) => String(n).padStart(2, '0');

// One row per closed issue: when it entered the completed state it is still in. A
// move between two completed columns falls inside that stretch of the history, so it
// is not a second closing, and an issue that was reopened counts once, at the last
// entry — the one it never left. An issue that is not in a completed state now has
// no row here.
function closings(projectId: number) {
  return sql`
    SELECT s.issue_id, min(s.entered_at) AS closed_at
      FROM issue_status s
      JOIN issue i ON i.id = s.issue_id
     WHERE i.project_id = ${projectId}
       AND s.state_type = 'completed'
       AND NOT EXISTS (
             SELECT 1 FROM issue_status p
              WHERE p.issue_id = s.issue_id
                AND p.state_type IS NOT 'completed'
                AND (p.entered_at, p.id) > (s.entered_at, s.id))
     GROUP BY s.issue_id`;
}

// --- Stats -----------------------------------------------------------------------

export interface StatsDto {
  open: number;
  inProgress: number;
  backlog: number;
  overdue: number;
  unassigned: number;
  closedLast7d: number;
}

const OPEN_STATES = sql`${projectColumn.stateType} NOT IN ('completed', 'canceled')`;

export async function getStats(db: Db, projectId: number): Promise<StatsDto> {
  // One row per state type with its issue count; the open/backlog/in-progress
  // figures are derived from it.
  const stateRows = await db
    .select({ stateType: projectColumn.stateType, count: sql<number>`count(*)` })
    .from(issue)
    .innerJoin(projectColumn, eq(projectColumn.id, issue.columnId))
    .where(eq(issue.projectId, projectId))
    .groupBy(projectColumn.stateType);

  let open = 0;
  let inProgress = 0;
  let backlog = 0;
  for (const r of stateRows) {
    if (r.stateType !== 'completed' && r.stateType !== 'canceled') open += r.count;
    if (r.stateType === 'started') inProgress = r.count;
    if (r.stateType === 'backlog') backlog = r.count;
  }

  const [{ overdue }] = await db
    .select({ overdue: sql<number>`count(*)` })
    .from(issue)
    .innerJoin(projectColumn, eq(projectColumn.id, issue.columnId))
    .where(and(eq(issue.projectId, projectId), sql`${issue.dueDate} < date('now')`, OPEN_STATES));

  const [{ unassigned }] = await db
    .select({ unassigned: sql<number>`count(*)` })
    .from(issue)
    .innerJoin(projectColumn, eq(projectColumn.id, issue.columnId))
    .where(and(eq(issue.projectId, projectId), isNull(issue.assigneeUserId), OPEN_STATES));

  const since7d = Date.now() - 7 * DAY_MS;
  const closedRows = (await db.all(sql`
    SELECT count(*) AS count
      FROM (${closings(projectId)}) c
     WHERE c.closed_at >= ${since7d}`)) as unknown as { count: number }[];
  const closedLast7d = Number(closedRows[0]!.count);

  return { open, inProgress, backlog, overdue, unassigned, closedLast7d };
}

// --- Breakdown -------------------------------------------------------------------

export type BreakdownBy = 'status' | 'priority' | 'type' | 'assignee' | 'delegate';

export interface BreakdownItem {
  key: string;
  label: string;
  count: number;
  color: string | null;
}

const PRIORITY_LABEL: Record<string, string> = {
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  none: 'No priority',
};

export async function getBreakdown(
  db: Db,
  projectId: number,
  by: BreakdownBy,
): Promise<BreakdownItem[]> {
  if (by === 'status') {
    // Every column, including empty ones, in work items order.
    const rows = await db
      .select({
        key: sql<string>`CAST(${projectColumn.id} AS TEXT)`,
        label: projectColumn.name,
        color: projectColumn.color,
        count: sql<number>`count(${issue.id})`,
      })
      .from(projectColumn)
      .leftJoin(issue, eq(issue.columnId, projectColumn.id))
      .where(eq(projectColumn.projectId, projectId))
      .groupBy(projectColumn.id, projectColumn.name, projectColumn.color, projectColumn.position)
      .orderBy(projectColumn.position);
    return rows.map((r) => ({ key: r.key, label: r.label, count: r.count, color: r.color }));
  }

  if (by === 'priority') {
    const rows = await db
      .select({
        key: sql<string>`COALESCE(${issue.priority}, 'none')`,
        count: sql<number>`count(*)`,
      })
      .from(issue)
      .where(eq(issue.projectId, projectId))
      .groupBy(issue.priority)
      .orderBy(desc(sql`count(*)`));
    return rows.map((r) => ({
      key: r.key,
      label: PRIORITY_LABEL[r.key] ?? r.key,
      count: r.count,
      color: null,
    }));
  }

  if (by === 'type') {
    const rows = await db
      .select({
        key: sql<string>`COALESCE(CAST(${issueType.id} AS TEXT), 'none')`,
        label: sql<string>`COALESCE(${issueType.name}, 'No type')`,
        color: issueType.color,
        count: sql<number>`count(${issue.id})`,
      })
      .from(issue)
      .leftJoin(issueType, eq(issueType.id, issue.typeId))
      .where(eq(issue.projectId, projectId))
      .groupBy(issueType.id, issueType.name, issueType.color)
      .orderBy(desc(sql`count(${issue.id})`));
    return rows.map((r) => ({
      key: r.key,
      label: r.label,
      count: r.count,
      color: r.color ?? null,
    }));
  }

  if (by === 'delegate') {
    const rows = await db
      .select({
        key: sql<string>`COALESCE(${user.id}, 'none')`,
        label: sql<string>`COALESCE(${user.name}, 'Not delegated')`,
        count: sql<number>`count(${issue.id})`,
      })
      .from(issue)
      .leftJoin(user, eq(user.id, issue.delegateUserId))
      .where(eq(issue.projectId, projectId))
      .groupBy(user.id, user.name)
      .orderBy(desc(sql`count(${issue.id})`));
    return rows.map((r) => ({ key: r.key, label: r.label, count: r.count, color: null }));
  }

  // assignee
  const rows = await db
    .select({
      key: sql<string>`COALESCE(${user.id}, 'none')`,
      label: sql<string>`COALESCE(${user.name}, 'Unassigned')`,
      count: sql<number>`count(${issue.id})`,
    })
    .from(issue)
    .leftJoin(user, eq(user.id, issue.assigneeUserId))
    .where(eq(issue.projectId, projectId))
    .groupBy(user.id, user.name)
    .orderBy(desc(sql`count(${issue.id})`));
  return rows.map((r) => ({ key: r.key, label: r.label, count: r.count, color: null }));
}

// --- Pulse (activity heatmap) ----------------------------------------------------

export type PulseUnit = 'hour' | 'day' | 'week';

export interface PulseBucket {
  label: string;
  count: number;
}

// Per-unit heatmap geometry. `rows` cells stack in each column. `aligned` units
// snap each column to a calendar boundary so the rows carry meaning — an hour
// column is a day (rows = hours 0..23), a day column is a week (rows = the seven
// days of an ISO week). Weeks have no such boundary, so they are unaligned: each
// column just packs `rows` consecutive weeks ending at now.
const PULSE_UNIT: Record<
  PulseUnit,
  {
    stepMs: number;
    superMs: number;
    floor: (ms: number) => number;
    superFloor: (ms: number) => number;
    rows: number;
    aligned: boolean;
    label: (ms: number) => string;
  }
> = {
  hour: {
    stepMs: HOUR_MS,
    superMs: DAY_MS,
    floor: (ms) => Math.floor(ms / HOUR_MS) * HOUR_MS,
    superFloor: startOfDay,
    rows: 24,
    aligned: true,
    label: (ms) => {
      const d = new Date(ms);
      return `${MONTHS[d.getUTCMonth()]} ${two(d.getUTCDate())}, ${two(d.getUTCHours())}:00`;
    },
  },
  day: {
    stepMs: DAY_MS,
    superMs: WEEK_MS,
    floor: startOfDay,
    superFloor: startOfWeek,
    rows: 7,
    aligned: true,
    label: (ms) => {
      const d = new Date(ms);
      return `${WEEKDAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${two(d.getUTCDate())}`;
    },
  },
  week: {
    stepMs: WEEK_MS,
    superMs: WEEK_MS,
    floor: startOfWeek,
    superFloor: startOfWeek,
    rows: 4,
    aligned: false,
    label: (ms) => {
      const d = new Date(ms);
      return `Week of ${MONTHS[d.getUTCMonth()]} ${two(d.getUTCDate())}`;
    },
  },
};

export function pulseRows(unit: PulseUnit): number {
  return PULSE_UNIT[unit].rows;
}

// A zero-filled activity series for the heatmap: `columns` columns of `rows` cells
// each, ending at now (see PULSE_UNIT for the geometry). The database counts the
// activity per bucket index and the full axis is filled in here, so the client
// renders the returned order directly, with no client-side date math or timezone
// reconciliation.
export async function getPulse(
  db: Db,
  projectId: number,
  unit: PulseUnit,
  columns: number,
  actorUserId?: string,
): Promise<PulseBucket[]> {
  const u = PULSE_UNIT[unit];
  const now = Date.now();
  const total = columns * u.rows;
  // Aligned: start at the super boundary `columns-1` supers back, so the last column
  // is the current super. Unaligned: `total` base units back from the current bucket.
  const start = u.aligned
    ? u.superFloor(now) - (columns - 1) * u.superMs
    : u.floor(now) - (total - 1) * u.stepMs;
  const rows = (await db.all(sql`
    SELECT CAST((a.created_at - ${start}) / ${u.stepMs} AS INTEGER) AS idx, count(a.id) AS count
      FROM issue_activity a
     WHERE a.issue_id IN (SELECT id FROM issue WHERE project_id = ${projectId})
       AND a.created_at >= ${start}
       ${actorUserId == null ? sql`` : sql`AND a.actor_user_id = ${actorUserId}`}
     GROUP BY idx`)) as unknown as { idx: number; count: number }[];
  const counts = new Map(rows.map((r) => [Number(r.idx), Number(r.count)]));
  return Array.from({ length: total }, (_, i) => ({
    label: u.label(start + i * u.stepMs),
    count: counts.get(i) ?? 0,
  }));
}

// --- Throughput (created vs closed per week) -------------------------------------

export interface ThroughputWeek {
  week: string;
  created: number;
  closed: number;
}

// Creations come from the change log, closings from the status history; the two are
// counted in one pass over their union so the weeks need no merging afterwards. A
// week with neither is absent from the result.
export async function getThroughput(
  db: Db,
  projectId: number,
  weeks: number,
): Promise<ThroughputWeek[]> {
  const since = startOfWeek(Date.now()) - (weeks - 1) * WEEK_MS;
  const rows = (await db.all(sql`
    SELECT e.week AS week,
           count(*) FILTER (WHERE e.kind = 'created') AS created,
           count(*) FILTER (WHERE e.kind = 'closed') AS closed
      FROM (
        SELECT (a.created_at / 86400000 - ((a.created_at / 86400000 + 3) % 7)) * 86400000 AS week, 'created' AS kind
          FROM issue_activity a
          JOIN issue i ON i.id = a.issue_id
         WHERE i.project_id = ${projectId}
           AND a.action = 'created'
           AND a.created_at >= ${since}
        UNION ALL
        SELECT (c.closed_at / 86400000 - ((c.closed_at / 86400000 + 3) % 7)) * 86400000, 'closed'
          FROM (${closings(projectId)}) c
         WHERE c.closed_at >= ${since}
      ) e
     GROUP BY e.week
     ORDER BY e.week`)) as unknown as { week: number; created: number; closed: number }[];
  return rows.map((r) => ({
    week: new Date(Number(r.week)).toISOString().slice(0, 10),
    created: Number(r.created),
    closed: Number(r.closed),
  }));
}

// --- Burnup (scope / started / completed per day, with a forecast) ---------------

export interface BurnupDay {
  date: string;
  scope: number;
  started: number;
  completed: number;
}

export interface BurnupForecast {
  windowDays: number;
  velocityPerDay: number;
  // The scope's growth rate over the same window, never negative: cancellations
  // are not a trend.
  scopeGrowthPerDay: number;
  remaining: number;
  // The scope the projection ends at: today's plus the issues expected to appear,
  // at scopeGrowthPerDay, while today's remaining ones are closed.
  projectedScope: number;
  projectedDate: string | null;
  // The projected date with the days to go shortened and lengthened by
  // RANGE_BUFFER: the range the widget can draw around the projection. Null
  // together with projectedDate.
  optimisticDate: string | null;
  pessimisticDate: string | null;
}

export interface BurnupDto {
  days: BurnupDay[];
  forecast: BurnupForecast;
  targetDate: string | null;
}

export interface BurnupParams {
  days: number;
  initiativeId: number | null;
  forecastWeeks: number;
}

// Unlike closings() above, which dates each issue by the moment it was closed, the
// burnup asks what state every issue was in at the end of each day: the status row
// whose stretch covers that midnight. So an issue that was reopened leaves the
// completed line for the days it was open again, and a canceled issue leaves the
// scope line — the chart is a history of the project, not of the events.
export async function getBurnup(
  db: Db,
  projectId: number,
  params: BurnupParams,
): Promise<BurnupDto> {
  const targetDate = await initiativeTargetDate(db, projectId, params.initiativeId);
  const today = startOfDay(Date.now());
  const initiativeFilter =
    params.initiativeId == null ? sql`` : sql`AND i.initiative_id = ${params.initiativeId}`;
  const rows = (await db.all(sql`
    WITH RECURSIVE d(day) AS (
      SELECT ${today - (params.days - 1) * DAY_MS}
      UNION ALL
      SELECT day + ${DAY_MS} FROM d WHERE day < ${today}
    )
    SELECT strftime('%Y-%m-%d', d.day / 1000, 'unixepoch') AS date,
           count(s.issue_id) FILTER (WHERE s.state_type IS NOT 'canceled') AS scope,
           count(s.issue_id) FILTER (WHERE s.state_type IN ('started', 'completed')) AS started,
           count(s.issue_id) FILTER (WHERE s.state_type = 'completed') AS completed
      FROM d
      LEFT JOIN (
        SELECT s.issue_id, s.state_type, s.entered_at, s.left_at
          FROM issue_status s
          JOIN issue i ON i.id = s.issue_id
         WHERE i.project_id = ${projectId} ${initiativeFilter}
      ) s ON s.entered_at < d.day + ${DAY_MS}
         AND (s.left_at IS NULL OR s.left_at >= d.day + ${DAY_MS})
     GROUP BY d.day
     ORDER BY d.day`)) as unknown as BurnupDay[];
  const days = rows.map((r) => ({
    date: r.date,
    scope: Number(r.scope),
    started: Number(r.started),
    completed: Number(r.completed),
  }));
  return { days, forecast: forecastCompletion(days, params.forecastWeeks * 7), targetDate };
}

// The initiative's target date, so the chart can draw it; null when the whole
// project is charted. An initiative from another project is a 404, not an empty
// chart, so a wrong id does not read as an initiative with no issues.
async function initiativeTargetDate(
  db: Db,
  projectId: number,
  initiativeId: number | null,
): Promise<string | null> {
  if (initiativeId == null) return null;
  const [row] = await db
    .select({ targetDate: initiative.targetDate })
    .from(initiative)
    .where(and(eq(initiative.id, initiativeId), eq(initiative.projectId, projectId)))
    .limit(1);
  if (!row) throw new HttpError(404, 'Initiative not found');
  return row.targetDate;
}

// The buffer Linear's project graph puts around its projected date.
const RANGE_BUFFER = 0.4;

// A completion date from two rates over the whole weeks inside the last
// `windowDays` days of the series, the latest week weighted heaviest (a window
// with no whole week uses the plain rates): the closing rate, and the scope's
// growth rate. The days to go cover today's remaining issues plus the ones
// expected to appear while they are closed — one round, not compounded, so a
// scope growing faster than it is closed still gets a date. No date when nothing
// was closed in the window or nothing is left — the widget says so instead of
// drawing a line to infinity.
export function forecastCompletion(days: BurnupDay[], windowDays: number): BurnupForecast {
  const last = days[days.length - 1];
  if (!last) {
    return {
      windowDays: 0,
      velocityPerDay: 0,
      scopeGrowthPerDay: 0,
      remaining: 0,
      projectedScope: 0,
      projectedDate: null,
      optimisticDate: null,
      pessimisticDate: null,
    };
  }
  const lastIndex = days.length - 1;
  const startIndex = Math.max(0, lastIndex - windowDays);
  const velocity = rateOver(days, startIndex, 'completed');
  const growth = Math.max(0, rateOver(days, startIndex, 'scope'));
  const remaining = Math.max(0, last.scope - last.completed);
  const daysForRemaining = velocity > 0 && remaining > 0 ? remaining / velocity : null;
  const expected = daysForRemaining === null ? 0 : Math.round(growth * daysForRemaining);
  const daysToGo = daysForRemaining === null ? null : (remaining + expected) / velocity;
  const dateAt = (factor: number) =>
    daysToGo === null ? null : addDays(last.date, Math.ceil(daysToGo * factor));
  return {
    windowDays: lastIndex - startIndex,
    velocityPerDay: round2(velocity),
    scopeGrowthPerDay: round2(growth),
    remaining,
    projectedScope: last.scope + expected,
    projectedDate: dateAt(1),
    optimisticDate: dateAt(1 - RANGE_BUFFER),
    pessimisticDate: dateAt(1 + RANGE_BUFFER),
  };
}

// The daily rate of `key` over the whole weeks between startIndex and the last
// day, the latest week weighted n, the earliest 1; the plain rate over the span
// when there is no whole week, 0 for a single point.
function rateOver(days: BurnupDay[], startIndex: number, key: 'completed' | 'scope'): number {
  const lastIndex = days.length - 1;
  const weeks = Math.floor((lastIndex - startIndex) / 7);
  if (weeks === 0) {
    const span = lastIndex - startIndex;
    return span > 0 ? (days[lastIndex]![key] - days[startIndex]![key]) / span : 0;
  }
  let sum = 0;
  let weightSum = 0;
  for (let i = 0; i < weeks; i++) {
    const end = lastIndex - i * 7;
    const weight = weeks - i;
    sum += (weight * (days[end]![key] - days[end - 7]![key])) / 7;
    weightSum += weight;
  }
  return sum / weightSum;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// 'YYYY-MM-DD' plus n days, computed in UTC so the local timezone never shifts the
// calendar date.
function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// --- Project-wide activity feed --------------------------------------------------

export interface ActivityCursor {
  ts: string;
  id: number;
}

export interface ActivityItem {
  id: number;
  issueId: number;
  issueSequence: number;
  issueTitle: string;
  kind: string;
  actorUserId: string | null;
  actorName: string | null;
  body: string | null;
  action: string | null;
  payload: ActivityPayload;
  createdAt: string;
}

export interface ActivityPage {
  items: ActivityItem[];
  nextCursor: ActivityCursor | null;
}

// One page of the project's activity feed, newest first, keyset-paginated by
// (created_at, id) exactly like the per-issue feed. Optional filters narrow by
// action kind, actor, and — for the dashboard widget's issue filter — a set of
// issue ids the client resolved from a work items filter set. An empty issueIds array
// means "the filter matched no issues", so the feed is empty.
export async function listActivity(
  db: Db,
  projectId: number,
  opts: {
    before?: ActivityCursor | null;
    limit?: number;
    actorUserId?: string | null;
    action?: string | null;
    issueIds?: number[] | null;
    from?: Date;
    to?: Date;
  } = {},
): Promise<ActivityPage> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const before = opts.before ?? null;

  if (opts.issueIds && opts.issueIds.length === 0) return { items: [], nextCursor: null };

  const conds = [eq(issue.projectId, projectId)];
  if (opts.issueIds) conds.push(inArray(issueActivity.issueId, opts.issueIds));
  if (opts.actorUserId != null) conds.push(eq(issueActivity.actorUserId, opts.actorUserId));
  if (opts.action) conds.push(eq(issueActivity.action, opts.action));
  if (opts.from) conds.push(gte(issueActivity.createdAt, opts.from));
  if (opts.to) conds.push(lt(issueActivity.createdAt, opts.to));
  if (before)
    conds.push(
      sql`(${issueActivity.createdAt}, ${issueActivity.id}) < (CAST(${before.ts} AS INTEGER), CAST(${before.id} AS INTEGER))`,
    );

  const rows = await db
    .select({
      id: issueActivity.id,
      issueId: issueActivity.issueId,
      issueSequence: issue.sequenceNumber,
      issueTitle: issue.title,
      kind: issueActivity.kind,
      actorUserId: issueActivity.actorUserId,
      actorName: issueActivity.actorName,
      body: issueActivity.body,
      action: issueActivity.action,
      payload: issueActivity.payload,
      createdAt: issueActivity.createdAt,
      cursorTs: sql<string>`CAST(${issueActivity.createdAt} AS TEXT)`,
    })
    .from(issueActivity)
    .innerJoin(issue, eq(issue.id, issueActivity.issueId))
    .where(and(...conds))
    .orderBy(desc(issueActivity.createdAt), desc(issueActivity.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map((row) => ({
      id: row.id,
      // The inner join on issueActivity.issueId excludes initiative rows, so
      // issueId is always present here despite the column being nullable.
      issueId: row.issueId as number,
      issueSequence: row.issueSequence,
      issueTitle: row.issueTitle,
      kind: row.kind,
      actorUserId: row.actorUserId,
      actorName: row.actorName,
      body: row.body,
      action: row.action,
      payload: row.payload,
      createdAt: iso(row.createdAt),
    })),
    nextCursor: hasMore && last ? { ts: last.cursorTs, id: last.id } : null,
  };
}

// --- Agent runs (project-wide feed) ----------------------------------------------

export interface AgentRunFeedItem {
  id: number;
  status: string;
  trigger: AgentRunTrigger;
  agentId: number;
  agentName: string;
  issueId: number | null;
  issueSequence: number | null;
  lastError: string | null;
  createdAt: string;
}

// The project's agent runs, newest first, optionally narrowed to one status. A run
// carries the project it worked in; ai_agent is joined for the agent name and issue
// when the run is issue-triggered.
export async function listAgentRunFeed(
  db: Db,
  projectId: number,
  opts: { status?: string | null; limit?: number } = {},
): Promise<AgentRunFeedItem[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
  const conds = [eq(agentRun.projectId, projectId)];
  if (opts.status) conds.push(eq(agentRun.status, opts.status));

  const rows = await db
    .select({
      id: agentRun.id,
      status: agentRun.status,
      trigger: agentRun.trigger,
      agentId: agentRun.agentId,
      agentName: aiAgent.username,
      issueId: agentRun.issueId,
      issueSequence: issue.sequenceNumber,
      lastError: agentRun.lastError,
      createdAt: agentRun.createdAt,
    })
    .from(agentRun)
    .innerJoin(aiAgent, eq(aiAgent.id, agentRun.agentId))
    .leftJoin(issue, eq(issue.id, agentRun.issueId))
    .where(and(...conds))
    .orderBy(desc(agentRun.id))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    trigger: r.trigger as AgentRunFeedItem['trigger'],
    agentId: r.agentId,
    agentName: r.agentName,
    issueId: r.issueId,
    issueSequence: r.issueSequence,
    lastError: r.lastError,
    createdAt: iso(r.createdAt),
  }));
}

// --- Agent run health (counts by status over a window) ---------------------------

export interface AgentRunStatsDto {
  total: number;
  success: number;
  failed: number;
  pending: number;
}

// Agent run outcome counts over the last `days` days for the project. Backs the
// agent health widget's success rate and failure count.
export async function getAgentRunStats(
  db: Db,
  projectId: number,
  days: number,
): Promise<AgentRunStatsDto> {
  const rows = await db
    .select({ status: agentRun.status, count: sql<number>`count(*)` })
    .from(agentRun)
    .where(
      and(
        eq(agentRun.projectId, projectId),
        gte(agentRun.createdAt, new Date(Date.now() - days * DAY_MS)),
      ),
    )
    .groupBy(agentRun.status);

  const stats: AgentRunStatsDto = { total: 0, success: 0, failed: 0, pending: 0 };
  for (const r of rows) {
    stats.total += r.count;
    if (r.status === 'success') stats.success = r.count;
    else if (r.status === 'failed') stats.failed = r.count;
    else if (r.status === 'pending') stats.pending = r.count;
  }
  return stats;
}

// --- Webhook delivery health -----------------------------------------------------

export interface WebhookStatsDto {
  total: number;
  success: number;
  failed: number;
  pending: number;
  activeWebhooks: number;
  disabledWebhooks: number;
}

// Webhook delivery outcome counts over the last `days` days plus the current
// active/disabled subscription split (a dead endpoint is auto-disabled once its
// consecutive failures cross the worker threshold). Backs the webhook health widget.
export async function getWebhookStats(
  db: Db,
  projectId: number,
  days: number,
): Promise<WebhookStatsDto> {
  const deliveryRows = await db
    .select({ status: webhookDelivery.status, count: sql<number>`count(*)` })
    .from(webhookDelivery)
    .innerJoin(webhook, eq(webhook.id, webhookDelivery.webhookId))
    .where(
      and(
        eq(webhook.projectId, projectId),
        gte(webhookDelivery.createdAt, new Date(Date.now() - days * DAY_MS)),
      ),
    )
    .groupBy(webhookDelivery.status);

  const webhookRows = await db
    .select({ isActive: webhook.isActive, count: sql<number>`count(*)` })
    .from(webhook)
    .where(eq(webhook.projectId, projectId))
    .groupBy(webhook.isActive);

  const stats: WebhookStatsDto = {
    total: 0,
    success: 0,
    failed: 0,
    pending: 0,
    activeWebhooks: 0,
    disabledWebhooks: 0,
  };
  for (const r of deliveryRows) {
    stats.total += r.count;
    if (r.status === 'success') stats.success = r.count;
    else if (r.status === 'failed') stats.failed = r.count;
    else if (r.status === 'pending') stats.pending = r.count;
  }
  for (const r of webhookRows) {
    if (r.isActive) stats.activeWebhooks = r.count;
    else stats.disabledWebhooks = r.count;
  }
  return stats;
}

// --- Agent workload (per-agent delegated issues and run outcomes) ----------------

export interface AgentWorkloadItem {
  agentId: number;
  agentName: string;
  kind: string;
  delegatedOpen: number;
  runsTotal: number;
  runsSuccess: number;
  runsFailed: number;
}

// Per-agent workload for the project: how many open issues each agent is currently
// delegated, and its lifetime run outcomes. Three cheap grouped reads merged in
// memory (one per source), keyed by the agent's bot user id and agent id.
export async function getAgentWorkload(db: Db, projectId: number): Promise<AgentWorkloadItem[]> {
  const agents = await db
    .select({ id: aiAgent.id, userId: aiAgent.userId, name: aiAgent.username, kind: aiAgent.kind })
    .from(aiAgent)
    .innerJoin(
      projectMember,
      and(eq(projectMember.userId, aiAgent.userId), eq(projectMember.projectId, projectId)),
    );
  if (agents.length === 0) return [];

  const delegatedRows = await db
    .select({ userId: issue.delegateUserId, count: sql<number>`count(*)` })
    .from(issue)
    .innerJoin(projectColumn, eq(projectColumn.id, issue.columnId))
    .where(and(eq(issue.projectId, projectId), isNotNull(issue.delegateUserId), OPEN_STATES))
    .groupBy(issue.delegateUserId);
  const delegatedByUser = new Map(delegatedRows.map((r) => [r.userId, r.count]));

  const runRows = await db
    .select({
      agentId: agentRun.agentId,
      total: sql<number>`count(*)`,
      success: sql<number>`count(*) filter (where ${agentRun.status} = 'success')`,
      failed: sql<number>`count(*) filter (where ${agentRun.status} = 'failed')`,
    })
    .from(agentRun)
    .where(eq(agentRun.projectId, projectId))
    .groupBy(agentRun.agentId);
  const runsByAgent = new Map(runRows.map((r) => [r.agentId, r]));

  return agents
    .map((a) => {
      const runs = runsByAgent.get(a.id);
      return {
        agentId: a.id,
        agentName: a.name,
        kind: a.kind,
        delegatedOpen: delegatedByUser.get(a.userId) ?? 0,
        runsTotal: runs?.total ?? 0,
        runsSuccess: runs?.success ?? 0,
        runsFailed: runs?.failed ?? 0,
      };
    })
    .sort(
      (a, b) =>
        b.delegatedOpen - a.delegatedOpen ||
        b.runsTotal - a.runsTotal ||
        a.agentName.localeCompare(b.agentName),
    );
}
