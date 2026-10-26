import { and, eq, sql } from 'drizzle-orm';
import { waitUntil } from 'cloudflare:workers';
import { type Db, getSentryConfig, issue, projectColumn, sentryIssue, sentryRoute } from '@repo/db';

// Every other column is created with a position of 0 or more (createColumn and
// reorderColumns), so -1 sorts the triage column first. The unique (project, position)
// also makes a concurrent creation insert nothing instead of a second triage column.
const TRIAGE_POSITION = -1;

async function findTriageColumnId(db: Db, projectId: number): Promise<number | null> {
  const [row] = await db
    .select({ id: projectColumn.id })
    .from(projectColumn)
    .where(and(eq(projectColumn.projectId, projectId), eq(projectColumn.stateType, 'triage')))
    .limit(1);
  return row?.id ?? null;
}

// The id of the project's triage column, created on first use.
export async function getTriageColumn(db: Db, projectId: number): Promise<number> {
  const existing = await findTriageColumnId(db, projectId);
  if (existing !== null) return existing;
  await db
    .insert(projectColumn)
    .values({ projectId, name: 'Triage', stateType: 'triage', position: TRIAGE_POSITION })
    .onConflictDoNothing();
  const created = await findTriageColumnId(db, projectId);
  if (created === null) throw new Error(`Triage column of project ${projectId} is missing`);
  return created;
}

// The position that puts an issue after the others of its column, as createIssue does.
export async function nextIssuePosition(db: Db, columnId: number): Promise<number> {
  const [row] = await db
    .select({ max: sql<number>`coalesce(max(${issue.position}), 0)` })
    .from(issue)
    .where(eq(issue.columnId, columnId));
  return row.max + 1000;
}

// The Telic project a Sentry project is routed to, or null when it is not routed.
export async function findSentryRouteProjectId(
  db: Db,
  sentryProjectSlug: string,
): Promise<number | null> {
  const [row] = await db
    .select({ projectId: sentryRoute.projectId })
    .from(sentryRoute)
    .where(eq(sentryRoute.sentryProjectSlug, sentryProjectSlug));
  return row?.projectId ?? null;
}

export async function findSentryIssueLink(
  db: Db,
  sentryIssueId: string,
): Promise<{ issueId: number } | null> {
  const [row] = await db
    .select({ issueId: sentryIssue.issueId })
    .from(sentryIssue)
    .where(eq(sentryIssue.sentryIssueId, sentryIssueId));
  return row ?? null;
}

// Links a Sentry issue to a Telic issue. Returns false when the Sentry issue was already
// linked, so a concurrent delivery that created its own issue can take that one back.
export async function linkSentryIssue(
  db: Db,
  sentryIssueId: string,
  issueId: number,
  lastEventAt: Date | null,
): Promise<boolean> {
  const inserted = await db
    .insert(sentryIssue)
    .values({ sentryIssueId, issueId, lastEventAt })
    .onConflictDoNothing()
    .returning({ sentryIssueId: sentryIssue.sentryIssueId });
  return inserted.length > 0;
}

export async function getIssueState(
  db: Db,
  issueId: number,
): Promise<{ id: number; projectId: number; stateType: string } | null> {
  const [row] = await db
    .select({
      id: issue.id,
      projectId: issue.projectId,
      stateType: projectColumn.stateType,
    })
    .from(issue)
    .innerJoin(projectColumn, eq(projectColumn.id, issue.columnId))
    .where(eq(issue.id, issueId));
  return row ?? null;
}

// Sets the status of a Sentry issue through the Sentry API. Does nothing when no auth
// token or organization is configured. A failure is logged, never thrown.
export async function updateSentryIssueStatus(
  db: Db,
  sentryIssueId: string,
  status: 'resolved' | 'ignored',
): Promise<void> {
  try {
    const config = await getSentryConfig(db);
    if (!config.authToken || !config.orgSlug) return;
    const url = `https://sentry.io/api/0/organizations/${encodeURIComponent(config.orgSlug)}/issues/${encodeURIComponent(sentryIssueId)}/`;
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${config.authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status }),
    });
    if (!response.ok)
      console.error(`[sentry] status update of issue ${sentryIssueId} failed: ${response.status}`);
  } catch (err) {
    console.error(`[sentry] status update of issue ${sentryIssueId} failed:`, err);
  }
}

// Runs a Sentry call after the response is sent: waitUntil keeps the Worker alive until it
// settles, so the request neither waits for it nor fails with it. An error is logged only.
function inBackground(label: string, task: () => Promise<void>): void {
  try {
    waitUntil(task().catch((err) => console.error(`[sentry] ${label} failed:`, err)));
  } catch (err) {
    console.error(`[sentry] ${label} failed:`, err);
  }
}

// Resolves the Sentry issues linked to a Telic issue, when the issue sits in a completed column.
export function resolveSentryIssuesOnCompletion(db: Db, issueId: number): void {
  inBackground(`resolve of issue ${issueId}`, async () => {
    const rows = await db
      .select({ sentryIssueId: sentryIssue.sentryIssueId, stateType: projectColumn.stateType })
      .from(sentryIssue)
      .innerJoin(issue, eq(issue.id, sentryIssue.issueId))
      .innerJoin(projectColumn, eq(projectColumn.id, issue.columnId))
      .where(eq(sentryIssue.issueId, issueId));
    if (rows[0]?.stateType !== 'completed') return;
    for (const row of rows) await updateSentryIssueStatus(db, row.sentryIssueId, 'resolved');
  });
}

// Ignores the Sentry issues linked to a Telic issue.
export function ignoreLinkedSentryIssues(db: Db, issueId: number): void {
  inBackground(`ignore of issue ${issueId}`, async () => {
    const rows = await db
      .select({ sentryIssueId: sentryIssue.sentryIssueId })
      .from(sentryIssue)
      .where(eq(sentryIssue.issueId, issueId));
    for (const row of rows) await updateSentryIssueStatus(db, row.sentryIssueId, 'ignored');
  });
}
