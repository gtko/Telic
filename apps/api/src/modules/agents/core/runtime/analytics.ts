import { aiAgent, modelPrice, project, team, user, type Db } from '@repo/db';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { iso, num } from '#shared/lib';
import { estimateCost, priceKey, type CallUsage, type OwnPrices } from './model-pricing';

// The figures behind the agent dashboard, read from the traces the runtime records
// (see observability.ts). One trace is one run: its root span carries the team, the
// agent and the project in metadata, and below it is a `model_inference` span for every
// call the run made to a model, with the provider, the model and the token counts. The
// spans hold no foreign keys of ours, so everything is scoped through that metadata and
// the names are read separately.
//
// The scope is a list of teams: one team, or every team of a workspace. `projectIds`
// narrows it to those projects, for a member who may read only some. The window is
// asked for in days and always read twice: the period itself and the one before it, so
// every headline figure carries what it moved from. Both come back in a single pass over
// the spans, grouped by the bucket each row falls in — an hour for a window of a day, a
// day for anything longer — and split by when the row itself started, since the first
// bucket of a window starts before the window does.
//
// Traces are deleted once past the retention window, so a window longer than the
// retention shows only what is still stored.

// What a group of model calls read, wrote and cost. `cost` is null until a call of the
// group could be priced: the price table names no such provider and model.
interface Usage {
  inputTokens: number;
  outputTokens: number;
  cost: number | null;
}

export interface AgentAnalyticsTotals extends Usage {
  runs: number;
  errors: number;
}

export interface AgentAnalytics {
  from: string;
  to: string;
  totals: AgentAnalyticsTotals;
  previous: AgentAnalyticsTotals;
  models: (Usage & { provider: string; model: string; calls: number })[];
  agents: (AgentAnalyticsTotals & { agentId: number; name: string })[];
  projects: (AgentAnalyticsTotals & { projectId: number; name: string })[];
  teams: (AgentAnalyticsTotals & { teamId: number; name: string })[];
  tokensPerDay: (Usage & { day: string })[];
}

// The period a dashboard reads and the one before it. A window of a day is grouped by
// the hour, since by the day its chart would hold one or two points.
export interface AnalyticsWindow {
  from: Date;
  to: Date;
  previousFrom: Date;
  bucket: 'hour' | 'day';
}

export interface AnalyticsScope {
  teamIds: number[];
  projectIds?: number[] | null;
}

// Whether the scope reads nothing at all, which no query is sent for.
function emptyScope(scope: AnalyticsScope): boolean {
  return scope.teamIds.length === 0 || scope.projectIds?.length === 0;
}

export async function workspaceScope(db: Db, workspaceId: number): Promise<AnalyticsScope> {
  const rows = await db.select({ id: team.id }).from(team).where(eq(team.workspaceId, workspaceId));
  return { teamIds: rows.map((row) => row.id) };
}

// The prices the workspace of the scope set itself, which the dashboard costs calls
// with before the built-in table. The teams of one scope share a workspace.
export async function ownPrices(db: Db, scope: AnalyticsScope): Promise<OwnPrices> {
  if (scope.teamIds.length === 0) return new Map();
  const rows = await db
    .selectDistinct({
      provider: modelPrice.provider,
      model: modelPrice.model,
      input: modelPrice.input,
      output: modelPrice.output,
      cacheRead: modelPrice.cacheRead,
      cacheWrite: modelPrice.cacheWrite,
    })
    .from(modelPrice)
    .innerJoin(team, eq(team.workspaceId, modelPrice.workspaceId))
    .where(inArray(team.id, scope.teamIds));
  return new Map(rows.map((row) => [priceKey(row.provider, row.model), row]));
}

// The scope narrowed to one project, when one is asked for. A project it does not read
// leaves it reading nothing.
export function onlyProject(scope: AnalyticsScope, projectId?: number): AnalyticsScope {
  if (projectId == null) return scope;
  const readable = !scope.projectIds || scope.projectIds.includes(projectId);
  return { ...scope, projectIds: readable ? [projectId] : [] };
}

// The projects the scope reads, by name: what it may be narrowed to.
export async function analyticsProjects(
  db: Db,
  scope: AnalyticsScope,
): Promise<{ projectId: number; name: string }[]> {
  if (emptyScope(scope)) return [];
  return db
    .select({ projectId: project.id, name: project.name })
    .from(project)
    .where(
      and(
        inArray(project.teamId, scope.teamIds),
        scope.projectIds ? inArray(project.id, scope.projectIds) : undefined,
      ),
    )
    .orderBy(project.name);
}

export function analyticsWindow(days: number): AnalyticsWindow {
  const bucket = days <= 1 ? 'hour' : 'day';
  const to = new Date();
  const windowMs = days * 24 * 60 * 60 * 1000;
  const from = new Date(to.getTime() - windowMs);
  return { from, to, previousFrom: new Date(from.getTime() - windowMs), bucket };
}

// The runs of the scope since `from`, one row per trace, as a statement to put in a
// WITH clause. `metadata` is the whole of what the run carried, for a reader that
// groups by more of it; its `runId` is ours on a queued run. The team, agent and project
// are columns of the root span (see span-exporter.ts), so the scope is an index lookup.
export function tracedRuns(scope: AnalyticsScope, from: Date): SQL {
  // One bound parameter per list, however long: D1 allows 100 per statement.
  const ids = (list: number[]) => sql`(SELECT value FROM json_each(${JSON.stringify(list)}))`;
  const projects = scope.projectIds ? sql` AND r.project_id IN ${ids(scope.projectIds)}` : sql``;
  return sql`
    SELECT r.trace_id AS trace_id,
           r.team_id AS team_id,
           r.agent_id AS agent_id,
           r.project_id AS project_id,
           r.started_at AS started_at,
           r.ended_at AS ended_at,
           (r.error IS NOT NULL) AS failed,
           r.metadata AS metadata
      FROM ai_spans r
     WHERE r.parent_span_id IS NULL
       AND r.team_id IN ${ids(scope.teamIds)}
       AND r.started_at >= ${from.getTime()}${projects}
  `;
}

// The start of the bucket a row falls in, as the ISO string the chart reads.
function bucketOf(bucket: 'hour' | 'day') {
  const format = bucket === 'hour' ? '%Y-%m-%dT%H:00:00.000Z' : '%Y-%m-%dT00:00:00.000Z';
  return sql`strftime(${format}, s.started_at / 1000, 'unixepoch')`;
}

// The bucket comes back as text.
function dayOf(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

// One row per bucket, period, team, agent, project and model: the model calls the runs
// of that bucket made. Fine enough to fold into every panel, and coarse enough that a long
// window stays a few hundred rows. A project belongs to one team, so the team adds no
// rows of its own. The token sums are plain numbers.
type CallRow = {
  day: unknown;
  in_window: boolean;
  team_id: number | null;
  agent_id: number | null;
  project_id: number | null;
  provider: string | null;
  model: string | null;
  calls: number;
  input_tokens: unknown;
  output_tokens: unknown;
  cache_read: unknown;
  cache_write: unknown;
};

async function modelCalls(
  db: Db,
  scope: AnalyticsScope,
  window: AnalyticsWindow,
): Promise<CallRow[]> {
  const rows = await db.all<Omit<CallRow, 'in_window'> & { in_window: number }>(sql`
    WITH runs AS (${tracedRuns(scope, window.previousFrom)})
    SELECT ${bucketOf(window.bucket)} AS day,
           s.started_at >= ${window.from.getTime()} AS in_window,
           runs.team_id,
           runs.agent_id,
           runs.project_id,
           s.provider AS provider,
           s.model AS model,
           count(*) AS calls,
           coalesce(sum(s.input_tokens), 0) AS input_tokens,
           coalesce(sum(s.output_tokens), 0) AS output_tokens,
           coalesce(sum(s.cache_read), 0) AS cache_read,
           coalesce(sum(s.cache_write), 0) AS cache_write
      FROM ai_spans s
      JOIN runs ON runs.trace_id = s.trace_id
     WHERE s.span_type = 'model_inference'
     GROUP BY 1, 2, 3, 4, 5, 6, 7
  `);
  return rows.map((row) => ({ ...row, in_window: row.in_window === 1 }));
}

// The models the runs of the scope called since `from`, with how many calls each: the
// models a workspace's price list starts from.
export async function modelsCalled(
  db: Db,
  scope: AnalyticsScope,
  from: Date,
): Promise<{ provider: string; model: string; calls: number }[]> {
  if (emptyScope(scope)) return [];
  return db.all<{ provider: string; model: string; calls: number }>(sql`
    WITH runs AS (${tracedRuns(scope, from)})
    SELECT s.provider AS provider,
           s.model AS model,
           count(*) AS calls
      FROM ai_spans s
      JOIN runs ON runs.trace_id = s.trace_id
     WHERE s.span_type = 'model_inference'
       AND coalesce(s.provider, '') <> ''
       AND coalesce(s.model, '') <> ''
     GROUP BY 1, 2
     ORDER BY calls DESC, 1, 2
  `);
}

type RunRow = {
  in_window: boolean;
  team_id: number | null;
  agent_id: number | null;
  project_id: number | null;
  runs: number;
  errors: number;
};

async function runsPerPeriod(
  db: Db,
  scope: AnalyticsScope,
  window: AnalyticsWindow,
): Promise<RunRow[]> {
  const rows = await db.all<Omit<RunRow, 'in_window'> & { in_window: number }>(sql`
    WITH runs AS (${tracedRuns(scope, window.previousFrom)})
    SELECT started_at >= ${window.from.getTime()} AS in_window,
           team_id,
           agent_id,
           project_id,
           count(*) AS runs,
           coalesce(sum(CASE WHEN failed THEN 1 ELSE 0 END), 0) AS errors
      FROM runs
     GROUP BY 1, 2, 3, 4
  `);
  return rows.map((row) => ({ ...row, in_window: row.in_window === 1 }));
}

function callUsage(row: CallRow): CallUsage {
  return {
    inputTokens: num(row.input_tokens),
    outputTokens: num(row.output_tokens),
    cacheReadTokens: num(row.cache_read),
    cacheWriteTokens: num(row.cache_write),
  };
}

function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cost: null };
}

function emptyTotals(): AgentAnalyticsTotals {
  return { runs: 0, errors: 0, ...emptyUsage() };
}

function addUsage(entry: Usage, usage: CallUsage, cost: number | null): void {
  entry.inputTokens += usage.inputTokens;
  entry.outputTokens += usage.outputTokens;
  if (cost != null) entry.cost = (entry.cost ?? 0) + cost;
}

function addRuns(entry: AgentAnalyticsTotals, row: RunRow): void {
  entry.runs += row.runs;
  entry.errors += row.errors;
}

function entryOf<K, V>(map: Map<K, V>, key: K, init: () => V): V {
  let entry = map.get(key);
  if (!entry) {
    entry = init();
    map.set(key, entry);
  }
  return entry;
}

const tokensOf = (entry: Usage) => entry.inputTokens + entry.outputTokens;
const byTokens = (a: Usage, b: Usage) => tokensOf(b) - tokensOf(a);

export async function getAgentAnalytics(
  db: Db,
  scope: AnalyticsScope,
  days: number,
): Promise<AgentAnalytics> {
  const window = analyticsWindow(days);
  const totals = emptyTotals();
  const previous = emptyTotals();
  const result: AgentAnalytics = {
    from: iso(window.from),
    to: iso(window.to),
    totals,
    previous,
    models: [],
    agents: [],
    projects: [],
    teams: [],
    tokensPerDay: [],
  };
  if (emptyScope(scope)) return result;

  const [calls, runs, agentRows, projectRows, teamRows, own] = await Promise.all([
    modelCalls(db, scope, window),
    runsPerPeriod(db, scope, window),
    db
      .select({ id: aiAgent.id, name: user.name })
      .from(aiAgent)
      .innerJoin(user, eq(user.id, aiAgent.userId))
      .where(inArray(aiAgent.teamId, scope.teamIds)),
    db
      .select({ id: project.id, name: project.name })
      .from(project)
      .where(inArray(project.teamId, scope.teamIds)),
    db.select({ id: team.id, name: team.name }).from(team).where(inArray(team.id, scope.teamIds)),
    ownPrices(db, scope),
  ]);

  const agentNames = new Map(agentRows.map((row) => [row.id, row.name]));
  const projectNames = new Map(projectRows.map((row) => [row.id, row.name]));
  const teamNames = new Map(teamRows.map((row) => [row.id, row.name]));
  const byModel = new Map<string, AgentAnalytics['models'][number]>();
  const byAgent = new Map<number, AgentAnalytics['agents'][number]>();
  const byProject = new Map<number, AgentAnalytics['projects'][number]>();
  const byTeam = new Map<number, AgentAnalytics['teams'][number]>();
  const byDay = new Map<string, AgentAnalytics['tokensPerDay'][number]>();
  // A deleted agent or project keeps its figures under an empty name.
  const agentEntry = (id: number) =>
    entryOf(byAgent, id, () => ({ agentId: id, name: agentNames.get(id) ?? '', ...emptyTotals() }));
  const projectEntry = (id: number) =>
    entryOf(byProject, id, () => ({
      projectId: id,
      name: projectNames.get(id) ?? '',
      ...emptyTotals(),
    }));
  const teamEntry = (id: number) =>
    entryOf(byTeam, id, () => ({ teamId: id, name: teamNames.get(id) ?? '', ...emptyTotals() }));

  for (const row of calls) {
    const usage = callUsage(row);
    const provider = row.provider ?? '';
    const model = row.model ?? '';
    const cost = provider && model ? estimateCost(provider, model, usage, row.calls, own) : null;
    if (!row.in_window) {
      addUsage(previous, usage, cost);
      continue;
    }
    addUsage(totals, usage, cost);
    const modelEntry = entryOf(byModel, `${provider}/${model}`, () => ({
      provider,
      model,
      calls: 0,
      ...emptyUsage(),
    }));
    modelEntry.calls += row.calls;
    addUsage(modelEntry, usage, cost);
    if (row.agent_id != null) addUsage(agentEntry(row.agent_id), usage, cost);
    if (row.project_id != null) addUsage(projectEntry(row.project_id), usage, cost);
    if (row.team_id != null) addUsage(teamEntry(row.team_id), usage, cost);
    const key = iso(dayOf(row.day));
    addUsage(
      entryOf(byDay, key, () => ({ day: key, ...emptyUsage() })),
      usage,
      cost,
    );
  }

  for (const row of runs) {
    if (!row.in_window) {
      addRuns(previous, row);
      continue;
    }
    addRuns(totals, row);
    if (row.agent_id != null) addRuns(agentEntry(row.agent_id), row);
    if (row.project_id != null) addRuns(projectEntry(row.project_id), row);
    if (row.team_id != null) addRuns(teamEntry(row.team_id), row);
  }

  result.models = [...byModel.values()].sort(byTokens);
  result.agents = [...byAgent.values()].sort(byTokens);
  result.projects = [...byProject.values()].sort(byTokens);
  result.teams = [...byTeam.values()].sort(byTokens);
  result.tokensPerDay = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  return result;
}
