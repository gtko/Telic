import { and, asc, eq, isNull } from 'drizzle-orm';
import { type Db, issue, projectColumn, sentryIssue } from '@repo/db';
import { HttpError } from '#shared/lib';
import type { ProjectRow } from '#modules/projects/service';
import { addIssueLink } from '#modules/issues/links';
import { attachFieldValues, getIssues, updateIssue, type IssueRow } from '#modules/issues/service';
import { getIssueState, ignoreLinkedSentryIssues, nextIssuePosition } from './service';

// The issues of the project in its triage column, in position order.
export async function listTriageIssues(db: Db, project: ProjectRow): Promise<IssueRow[]> {
  const rows = await db
    .select({ id: issue.id })
    .from(issue)
    .innerJoin(projectColumn, eq(projectColumn.id, issue.columnId))
    .where(
      and(
        eq(issue.projectId, project.id),
        isNull(issue.archivedAt),
        eq(projectColumn.stateType, 'triage'),
      ),
    );
  const issues = await getIssues(
    db,
    rows.map((row) => row.id),
  );
  issues.sort((a, b) => a.position - b.position);
  await attachFieldValues(db, issues);
  return issues;
}

export function acceptIssue(
  db: Db,
  project: ProjectRow,
  issueId: number,
  actorUserId: string,
): Promise<IssueRow> {
  return moveFromTriage(db, project, issueId, 'backlog', actorUserId);
}

export async function rejectIssue(
  db: Db,
  project: ProjectRow,
  issueId: number,
  actorUserId: string,
): Promise<IssueRow> {
  const rejected = await moveFromTriage(db, project, issueId, 'canceled', actorUserId);
  ignoreLinkedSentryIssues(db, issueId);
  return rejected;
}

// Links the issue as a duplicate of the target and repoints its Sentry links to the target, so
// later Sentry events land on it. The issue moves to canceled last: a failure before that
// leaves it in triage.
export async function mergeIssue(
  db: Db,
  project: ProjectRow,
  issueId: number,
  targetIssueId: number,
  actorUserId: string,
): Promise<IssueRow> {
  if (targetIssueId === issueId) throw new HttpError(400, 'An issue cannot be merged into itself');
  const target = await getIssueState(db, targetIssueId);
  if (!target || target.projectId !== project.id)
    throw new HttpError(404, 'Target issue not found');
  if (target.stateType === 'triage' || target.stateType === 'canceled')
    throw new HttpError(400, 'A duplicate cannot be merged into a triaged or canceled issue');

  await assertInTriage(db, project, issueId);
  const canceledColumnId = await firstColumnId(db, project.id, 'canceled');
  await addIssueLink(db, issueId, targetIssueId, 'duplicates', actorUserId);
  await db
    .update(sentryIssue)
    .set({ issueId: targetIssueId })
    .where(eq(sentryIssue.issueId, issueId));
  return moveIssue(db, issueId, canceledColumnId, actorUserId);
}

async function assertInTriage(db: Db, project: ProjectRow, issueId: number): Promise<void> {
  const state = await getIssueState(db, issueId);
  if (!state || state.projectId !== project.id) throw new HttpError(404, 'Issue not found');
  if (state.stateType !== 'triage') throw new HttpError(400, 'Issue is not in triage');
}

async function moveFromTriage(
  db: Db,
  project: ProjectRow,
  issueId: number,
  stateType: 'backlog' | 'canceled',
  actorUserId: string,
): Promise<IssueRow> {
  await assertInTriage(db, project, issueId);
  const columnId = await firstColumnId(db, project.id, stateType);
  return moveIssue(db, issueId, columnId, actorUserId);
}

async function moveIssue(
  db: Db,
  issueId: number,
  columnId: number,
  actorUserId: string,
): Promise<IssueRow> {
  const moved = await updateIssue(
    db,
    issueId,
    { columnId, position: await nextIssuePosition(db, columnId) },
    actorUserId,
  );
  if (!moved) throw new HttpError(404, 'Issue not found');
  return moved;
}

// The first column of a state type by position: the column triage sends an issue to.
async function firstColumnId(
  db: Db,
  projectId: number,
  stateType: 'backlog' | 'canceled',
): Promise<number> {
  const [row] = await db
    .select({ id: projectColumn.id })
    .from(projectColumn)
    .where(and(eq(projectColumn.projectId, projectId), eq(projectColumn.stateType, stateType)))
    .orderBy(asc(projectColumn.position))
    .limit(1);
  if (!row) throw new HttpError(400, `The project has no ${stateType} column`);
  return row.id;
}
