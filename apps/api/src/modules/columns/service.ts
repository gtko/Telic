import {
  type Db,
  projectColumn,
  issue,
  issueLabel,
  issueFieldValue,
  issueFieldOption,
} from '@repo/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { HttpError } from '#shared/lib';
import { getMembership } from '#modules/members/service';
import { recordActivityForIssues, statusSide } from '#modules/issues/activity';
import { getIssues } from '#modules/issues/service';
import { emitIssueEvents, issuePayloads } from '#modules/issues/webhook-payload';
import { emitWebhookEvents, projectEventWanted } from '#modules/webhooks/emit';
import { recordStatusChange } from '#modules/issues/status-history';

export interface ColumnRow {
  id: number;
  projectId: number;
  name: string;
  stateType: string;
  color: string;
  position: number;
  wipLimit: number | null;
  wipMode: string;
  autoAssignUserId: string | null;
}

function mapColumn(row: typeof projectColumn.$inferSelect): ColumnRow {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    stateType: row.stateType,
    color: row.color,
    position: row.position,
    wipLimit: row.wipLimit,
    wipMode: row.wipMode,
    autoAssignUserId: row.autoAssignUserId,
  };
}

async function assertAutoAssignee(
  db: Db,
  projectId: number,
  userId?: string | null,
): Promise<void> {
  if (!userId) return;
  if (!(await getMembership(db, projectId, userId)))
    throw new HttpError(400, 'Auto-assignee must be a project member');
}

export async function columnAutoAssignee(db: Db, columnId: number): Promise<string | null> {
  const [row] = await db
    .select({ userId: projectColumn.autoAssignUserId })
    .from(projectColumn)
    .where(eq(projectColumn.id, columnId));
  return row?.userId ?? null;
}

export const WIP_LIMIT_EXCEEDED = 'wip_limit_exceeded';

// The error for `incoming` issues entering a column that is at its work-in-progress
// limit, or null when they fit. Only an enforced limit ('hard') refuses; a soft one
// just drives the board's warning treatment. `incoming` is how many issues the write
// carries — a board drag can move a whole selection at once.
//
// Returned rather than thrown because the callers differ: a write a user asked for
// fails with it, while an automation moving issues on its own (subtask rules, a
// merged pull request) leaves the issue where it is instead of failing the action
// that set it off.
//
// The count and the write are separate statements, so two simultaneous moves can
// both pass and leave the column one over. That is left as is: a column over its
// limit is a state the board already has to render (a limit lowered under the
// current count does the same), and locking the column on every drag would cost
// more than the overshoot.
export async function wipLimitBreach(
  db: Db,
  columnId: number,
  incoming = 1,
): Promise<HttpError | null> {
  const [column] = await db
    .select({
      name: projectColumn.name,
      limit: projectColumn.wipLimit,
      mode: projectColumn.wipMode,
    })
    .from(projectColumn)
    .where(eq(projectColumn.id, columnId));
  if (!column || column.limit == null || column.mode !== 'hard') return null;

  // Archived issues are off the board, so they do not occupy the column.
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(issue)
    .where(and(eq(issue.columnId, columnId), isNull(issue.archivedAt)));
  if (count + incoming <= column.limit) return null;

  return new HttpError(
    409,
    `Column "${column.name}" is at its WIP limit of ${column.limit}`,
    WIP_LIMIT_EXCEEDED,
  );
}

// The same check for a write that must fail rather than skip.
export async function assertWipLimit(db: Db, columnId: number, incoming = 1): Promise<void> {
  const breach = await wipLimitBreach(db, columnId, incoming);
  if (breach) throw breach;
}

// The work items view's left-to-right order: sorting by state type before position
// keeps a newly added column next to the others of its type rather than at the end.
const STATE_TYPE_ORDER = sql`CASE ${projectColumn.stateType}
    WHEN 'triage' THEN -1
    WHEN 'backlog' THEN 0
    WHEN 'unstarted' THEN 1
    WHEN 'started' THEN 2
    WHEN 'completed' THEN 3
    WHEN 'canceled' THEN 4
    ELSE 5
  END`;

export async function listColumns(db: Db, projectId: number): Promise<ColumnRow[]> {
  const rows = await db
    .select()
    .from(projectColumn)
    .where(eq(projectColumn.projectId, projectId))
    .orderBy(STATE_TYPE_ORDER, projectColumn.position);
  return rows.map(mapColumn);
}

export async function createColumn(
  db: Db,
  input: {
    projectId: number;
    name: string;
    stateType: string;
    color?: string;
    wipLimit?: number | null;
    wipMode?: string;
    autoAssignUserId?: string | null;
  },
): Promise<ColumnRow> {
  await assertAutoAssignee(db, input.projectId, input.autoAssignUserId);
  // The position is computed by the INSERT itself, so two simultaneous creations get
  // distinct positions instead of colliding on UNIQUE(project_id, position).
  const [row] = await db
    .insert(projectColumn)
    .values({
      projectId: input.projectId,
      name: input.name,
      stateType: input.stateType,
      color: input.color ?? '#6b7280',
      position: sql`(select coalesce(max(position), -1) + 1 from ${projectColumn} where project_id = ${input.projectId})`,
      wipLimit: input.wipLimit ?? null,
      wipMode: input.wipMode ?? 'soft',
      autoAssignUserId: input.autoAssignUserId ?? null,
    })
    .returning();
  return mapColumn(row);
}

async function getColumnById(db: Db, id: number): Promise<ColumnRow | null> {
  const rows = await db.select().from(projectColumn).where(eq(projectColumn.id, id));
  return rows[0] ? mapColumn(rows[0]) : null;
}

// Scoped to projectId so a column id from another project resolves to null (the
// route turns that into a 404), never a cross-project edit.
export async function updateColumn(
  db: Db,
  id: number,
  projectId: number,
  patch: {
    name?: string;
    color?: string;
    stateType?: string;
    // null clears the limit; absent leaves it as it is.
    wipLimit?: number | null;
    wipMode?: string;
    // null clears the automatic assignment; absent leaves it as it is.
    autoAssignUserId?: string | null;
  },
): Promise<ColumnRow | null> {
  await assertAutoAssignee(db, projectId, patch.autoAssignUserId);
  const scope = and(eq(projectColumn.id, id), eq(projectColumn.projectId, projectId));
  const set: Partial<typeof projectColumn.$inferInsert> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.color !== undefined) set.color = patch.color;
  if (patch.stateType !== undefined) set.stateType = patch.stateType;
  if (patch.wipLimit !== undefined) set.wipLimit = patch.wipLimit;
  if (patch.wipMode !== undefined) set.wipMode = patch.wipMode;
  if (patch.autoAssignUserId !== undefined) set.autoAssignUserId = patch.autoAssignUserId;
  if (Object.keys(set).length === 0) {
    const rows = await db.select().from(projectColumn).where(scope);
    return rows[0] ? mapColumn(rows[0]) : null;
  }
  const [row] = await db.update(projectColumn).set(set).where(scope).returning();
  return row ? mapColumn(row) : null;
}

// Any column missing from orderedIds is appended in its current order. The two-pass
// update — shift every position out of range, then assign 0..n-1 — keeps the
// UNIQUE(project_id, position) constraint from seeing a transient duplicate. All the
// statements go in one D1 batch, which D1 runs atomically.
export async function reorderColumns(
  db: Db,
  projectId: number,
  orderedIds: number[],
): Promise<void> {
  const existing = await listColumns(db, projectId);
  const known = new Set(existing.map((c) => c.id));
  const finalOrder = orderedIds.filter((id) => known.has(id));
  for (const c of existing) if (!finalOrder.includes(c.id)) finalOrder.push(c.id);
  if (finalOrder.length === 0) return;

  await db.batch([
    db
      .update(projectColumn)
      .set({ position: sql`${projectColumn.position} + 1000000` })
      .where(eq(projectColumn.projectId, projectId)),
    ...finalOrder.map((id, index) =>
      db
        .update(projectColumn)
        .set({ position: index })
        .where(and(eq(projectColumn.id, id), eq(projectColumn.projectId, projectId))),
    ),
  ]);
}

export type DeleteColumnOptions = { mode: 'move'; targetColumnId: number } | { mode: 'delete' };

// Keep one backlog column per project. The column and its issues go in one D1 batch so
// neither is left half-deleted. The "last backlog column" rule is evaluated by the
// statements themselves: every statement of the batch carries the same guard, so two
// simultaneous deletions of the last two backlog columns cannot both pass (D1 runs one
// write batch at a time, and the second sees the first column gone), and a refused delete
// has changed nothing.
export async function deleteColumn(
  db: Db,
  columnId: number,
  projectId: number,
  opts: DeleteColumnOptions,
  actorUserId?: string | null,
): Promise<void> {
  const column = await getColumnById(db, columnId);
  if (!column || column.projectId !== projectId)
    throw new HttpError(404, `Column ${columnId} not found`);

  let target: ColumnRow | null = null;
  if (opts.mode === 'move') {
    target = await getColumnById(db, opts.targetColumnId);
    if (!target || target.projectId !== column.projectId)
      throw new HttpError(400, 'Target column must belong to the same project');
    if (target.id === column.id)
      throw new HttpError(400, 'Target column must differ from the deleted column');
  }

  // Built before the batch: the payloads name the column, which it deletes.
  let deletedPayloads: unknown[] = [];
  if (opts.mode === 'delete' && (await projectEventWanted(db, projectId, 'issue.deleted'))) {
    const rows = await db.select({ id: issue.id }).from(issue).where(eq(issue.columnId, columnId));
    deletedPayloads = await issuePayloads(
      db,
      await getIssues(
        db,
        rows.map((r) => r.id),
      ),
    );
  }

  // True while the column exists and deleting it leaves the project a backlog column.
  const deletable = sql`exists (
    select 1 from ${projectColumn} pc
    where pc.id = ${columnId}
      and (pc.state_type <> 'backlog'
        or (select count(*) from ${projectColumn} b
            where b.project_id = ${projectId} and b.state_type = 'backlog') > 1)
  )`;
  const inColumn = db.select({ id: issue.id }).from(issue).where(eq(issue.columnId, columnId));
  const deleteColumnRow = db
    .delete(projectColumn)
    .where(and(eq(projectColumn.id, columnId), deletable))
    .returning({ id: projectColumn.id });

  let movedIssueIds: number[] = [];
  let deletedRows: { id: number }[];
  if (opts.mode === 'move') {
    const [moved, deleted] = await db.batch([
      db
        .update(issue)
        .set({ columnId: opts.targetColumnId, updatedAt: new Date() })
        .where(and(eq(issue.columnId, columnId), deletable))
        .returning({ id: issue.id }),
      deleteColumnRow,
    ]);
    movedIssueIds = moved.map((r) => r.id);
    deletedRows = deleted;
  } else {
    const [, , , , deleted] = await db.batch([
      db
        .delete(issueFieldOption)
        .where(and(inArray(issueFieldOption.issueId, inColumn), deletable)),
      db.delete(issueFieldValue).where(and(inArray(issueFieldValue.issueId, inColumn), deletable)),
      db.delete(issueLabel).where(and(inArray(issueLabel.issueId, inColumn), deletable)),
      db.delete(issue).where(and(eq(issue.columnId, columnId), deletable)),
      deleteColumnRow,
    ]);
    deletedRows = deleted;
  }
  if (deletedRows.length === 0) {
    // Nothing ran: the column went away meanwhile, or it was one of the last two backlog
    // columns deleted together.
    if (await getColumnById(db, columnId))
      throw new HttpError(400, 'The last backlog column cannot be deleted');
    throw new HttpError(404, `Column ${columnId} not found`);
  }

  if (target) {
    await recordStatusChange(db, movedIssueIds, target.id);
    await recordActivityForIssues(
      db,
      movedIssueIds,
      { action: 'status', from: statusSide(column), to: statusSide(target) },
      actorUserId,
    );
    const moved = () => getIssues(db, movedIssueIds);
    await emitIssueEvents(db, projectId, 'issue.updated', moved, actorUserId);
    await emitIssueEvents(db, projectId, 'issue.state_changed', moved, actorUserId);
  } else {
    await emitWebhookEvents(
      db,
      projectId,
      'issue.deleted',
      async () => deletedPayloads,
      actorUserId,
    );
  }
}
