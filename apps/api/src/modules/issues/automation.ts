import { type Db, issue, projectColumn } from '@repo/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { getSubtaskAutomationSettings } from '#modules/projects/service';
import { listSubtasks } from './subtasks';
import { updateIssue, type IssueRow } from './service';
import type { ActivityActor } from './activity';

// The subtask automations a column change triggers, both off unless the project
// turns them on (modules/projects/service.ts). A closed issue is one sitting in a
// column whose stateType is 'completed' or 'canceled'.
//
// The hierarchy is one level deep, so an issue is either a subtask or a parent and
// only one of the two rules applies to it. Each rule writes through updateIssue, so
// the moved issues get their own activity entries and webhooks — and re-enter this
// function. That does not loop: a rule skips an issue already in the target column,
// which is where the nested pass finds every issue it would move.

const CLOSED_STATE_TYPES = ['completed', 'canceled'];

export async function applySubtaskAutomation(
  db: Db,
  after: IssueRow,
  actorUserId?: ActivityActor,
): Promise<void> {
  const settings = await getSubtaskAutomationSettings(db, after.projectId);
  if (!settings.completeParent && !settings.closeSubtasks) return;
  if (!(await isClosedColumn(db, after.columnId))) return;

  if (after.parentId !== null) {
    if (settings.completeParent) await completeParent(db, after.parentId, after, actorUserId);
    return;
  }
  if (settings.closeSubtasks) await closeSubtasks(db, after, actorUserId);
}

// Moves the issue's parent into the column the issue was just closed in, once every
// other subtask is closed too. Archived subtasks are off the board and do not hold
// the parent open; an archived parent is left where it is rather than brought back.
// A parent already closed keeps its own column: the rule has nothing left to do.
async function completeParent(
  db: Db,
  parentId: number,
  subtask: IssueRow,
  actorUserId?: ActivityActor,
): Promise<void> {
  const siblingColumnIds = (await listSubtasks(db, parentId))
    .filter((s) => !s.archived && s.id !== subtask.id)
    .map((s) => s.columnId);
  const parentColumnId = await activeColumn(db, parentId);
  if (parentColumnId === null) return;
  const closed = await closedColumnIds(db, [...siblingColumnIds, parentColumnId]);
  if (closed.has(parentColumnId)) return;
  if (siblingColumnIds.some((id) => !closed.has(id))) return;
  await updateIssue(db, parentId, { columnId: subtask.columnId }, actorUserId, {
    skipIfColumnFull: true,
  });
}

// Moves the issue's still-open subtasks into the column it was just closed in.
async function closeSubtasks(db: Db, parent: IssueRow, actorUserId?: ActivityActor): Promise<void> {
  const subtasks = (await listSubtasks(db, parent.id)).filter((s) => !s.archived);
  const closed = await closedColumnIds(
    db,
    subtasks.map((s) => s.columnId),
  );
  for (const subtask of subtasks)
    if (!closed.has(subtask.columnId))
      await updateIssue(db, subtask.id, { columnId: parent.columnId }, actorUserId, {
        skipIfColumnFull: true,
      });
}

async function isClosedColumn(db: Db, columnId: number): Promise<boolean> {
  return (await closedColumnIds(db, [columnId])).has(columnId);
}

// The subset of the given column ids whose stateType counts as closed.
async function closedColumnIds(db: Db, columnIds: number[]): Promise<Set<number>> {
  const ids = [...new Set(columnIds)];
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: projectColumn.id })
    .from(projectColumn)
    .where(
      and(inArray(projectColumn.id, ids), inArray(projectColumn.stateType, CLOSED_STATE_TYPES)),
    );
  return new Set(rows.map((r) => r.id));
}

// The issue's column, or null when it is gone or archived.
async function activeColumn(db: Db, issueId: number): Promise<number | null> {
  const [row] = await db
    .select({ columnId: issue.columnId })
    .from(issue)
    .where(and(eq(issue.id, issueId), isNull(issue.archivedAt)));
  return row?.columnId ?? null;
}
