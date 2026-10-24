import {
  type Db,
  batchAll,
  chunk,
  agentRun,
  customField,
  customFieldOption,
  issue,
  issueFieldOption,
  issueFieldValue,
  issueKeyAlias,
  issueLabel,
  issueLink,
  issueType,
  issueWatcher,
  label,
  project as projectTable,
  projectColumn,
  projectDocumentIssue,
  projectMember,
} from '@repo/db';
import { and, asc, eq, inArray, notInArray, or, sql } from 'drizzle-orm';
import { HttpError } from '#shared/lib';
import type { ProjectRow } from '#modules/projects/service';
import { assertWipLimit } from '#modules/columns/service';
import { getIssue, recordParentChange, type IssueRow } from './service';
import { recordActivity, textSide } from './activity';
import { recordStatusChange } from './status-history';
import { recordCycleChange } from './cycle-history';
import { emitIssueEvent } from './webhook-payload';
import { queueStatusRuns } from '#modules/agents/schedules/issue-runs';

// Moves an issue, with its subtasks, to another project of the same team. Column,
// type, labels and custom fields belong to one project, so they are matched by name
// in the target and dropped when there is no match. Links and documents must stay
// inside one project, so those that reach an issue left behind are removed.
export async function moveIssue(
  db: Db,
  issueId: number,
  target: ProjectRow,
  columnId: number | undefined,
  actorUserId: string,
): Promise<IssueRow> {
  const [root] = await db
    .select({ id: issue.id, projectId: issue.projectId, parentId: issue.parentId })
    .from(issue)
    .where(eq(issue.id, issueId));
  if (!root) throw new HttpError(404, 'Issue not found');
  if (root.projectId === target.id)
    throw new HttpError(400, 'The issue is already in this project');
  const [source] = await db
    .select({ key: projectTable.key, teamId: projectTable.teamId })
    .from(projectTable)
    .where(eq(projectTable.id, root.projectId));
  if (source.teamId !== target.teamId)
    throw new HttpError(400, 'An issue can only move to a project of the same team');

  const moved = await db
    .select({
      id: issue.id,
      parentId: issue.parentId,
      sequenceNumber: issue.sequenceNumber,
      cycleId: issue.cycleId,
      assigneeUserId: issue.assigneeUserId,
      delegateUserId: issue.delegateUserId,
      columnName: projectColumn.name,
      stateType: projectColumn.stateType,
      typeName: issueType.name,
    })
    .from(issue)
    .innerJoin(projectColumn, eq(projectColumn.id, issue.columnId))
    .leftJoin(issueType, eq(issueType.id, issue.typeId))
    .where(or(eq(issue.id, issueId), eq(issue.parentId, issueId)))
    .orderBy(sql`${issue.id} <> ${issueId}`, asc(issue.sequenceNumber));
  const movedIds = moved.map((r) => r.id);

  const columns = await db
    .select({ id: projectColumn.id, name: projectColumn.name, stateType: projectColumn.stateType })
    .from(projectColumn)
    .where(eq(projectColumn.projectId, target.id))
    .orderBy(asc(projectColumn.position));
  if (columns.length === 0) throw new HttpError(400, 'The target project has no columns');
  if (columnId !== undefined && !columns.some((c) => c.id === columnId))
    throw new HttpError(400, 'Column must belong to the target project');
  const mapColumn = (name: string, stateType: string) =>
    (
      columns.find((c) => c.name === name) ??
      columns.find((c) => c.stateType === stateType) ??
      columns[0]
    ).id;

  const types = await db
    .select({ id: issueType.id, name: issueType.name, isDefault: issueType.isDefault })
    .from(issueType)
    .where(eq(issueType.projectId, target.id));
  const defaultTypeId = types.find((t) => t.isDefault)?.id ?? null;
  const mapType = (name: string | null) => types.find((t) => t.name === name)?.id ?? defaultTypeId;

  const members = new Set(
    (
      await db
        .select({ userId: projectMember.userId })
        .from(projectMember)
        .where(eq(projectMember.projectId, target.id))
    ).map((r) => r.userId),
  );
  const member = (userId: string | null) => (userId && members.has(userId) ? userId : null);

  const plans = moved.map((r) => ({
    ...r,
    newColumnId:
      r.id === issueId && columnId !== undefined ? columnId : mapColumn(r.columnName, r.stateType),
    newTypeId: mapType(r.typeName),
  }));
  const perColumn = new Map<number, number>();
  for (const p of plans) perColumn.set(p.newColumnId, (perColumn.get(p.newColumnId) ?? 0) + 1);
  for (const [id, incoming] of perColumn) await assertWipLimit(db, id, incoming);

  const labels = await mapLabels(db, movedIds, target.id);
  const fields = await mapFields(db, movedIds, target.id);

  // One atomic D1 batch. Everything above was read without a lock, so the batch checks
  // for itself that nothing moved meanwhile: the alias rows below take each moved issue's
  // id from a sub-select that is NULL (a NOT NULL violation that rolls the whole batch
  // back) when the issue already left the source project, or when the root gained a
  // subtask since it was read. The numbers are reserved by the first statement and read
  // back by the updates, so a simultaneous move into the same project gets other ones.
  const stillThere = (id: number) =>
    id === issueId
      ? sql<number>`(select ${issue.id} from ${issue} where ${issue.id} = ${id} and ${issue.projectId} = ${root.projectId} and (select count(*) from ${issue} where ${issue.parentId} = ${id}) = ${moved.length - 1})`
      : sql<number>`(select ${issue.id} from ${issue} where ${issue.id} = ${id} and ${issue.projectId} = ${root.projectId})`;
  const newSequence = (i: number) =>
    sql<number>`(select ${projectTable.nextSequence} - ${moved.length} + ${i} from ${projectTable} where ${projectTable.id} = ${target.id})`;
  const memberIds = JSON.stringify([...members]);
  try {
    await batchAll(db, [
      ...moved.map((r) =>
        db.insert(issueKeyAlias).values({
          projectId: root.projectId,
          sequenceNumber: r.sequenceNumber,
          issueId: stillThere(r.id),
        }),
      ),
      db
        .update(projectTable)
        .set({ nextSequence: sql`${projectTable.nextSequence} + ${moved.length}` })
        .where(eq(projectTable.id, target.id)),
      ...plans.map((p, i) =>
        db
          .update(issue)
          .set({
            projectId: target.id,
            sequenceNumber: newSequence(i),
            columnId: p.newColumnId,
            typeId: p.newTypeId,
            parentId: p.id === issueId ? null : p.parentId,
            cycleId: null,
            initiativeId: null,
            assigneeUserId: member(p.assigneeUserId),
            delegateUserId: member(p.delegateUserId),
            position: sql`(select coalesce(max(${issue.position}), 0) + 1000 from ${issue} where ${issue.columnId} = ${p.newColumnId})`,
            updatedAt: new Date(),
          })
          .where(eq(issue.id, p.id)),
      ),
      db.delete(issueLabel).where(inArray(issueLabel.issueId, movedIds)),
      ...chunk(labels, 40).map((rows) => db.insert(issueLabel).values(rows)),
      db.delete(issueFieldOption).where(inArray(issueFieldOption.issueId, movedIds)),
      ...chunk(fields.options, 30).map((rows) => db.insert(issueFieldOption).values(rows)),
      ...fields.values.map((v) =>
        v.fieldId === null
          ? db.delete(issueFieldValue).where(eq(issueFieldValue.id, v.id))
          : db
              .update(issueFieldValue)
              .set({
                fieldId: v.fieldId,
                ...(v.valueUserId ? { valueUserId: member(v.valueUserId) } : {}),
              })
              .where(eq(issueFieldValue.id, v.id)),
      ),
      db
        .delete(issueLink)
        .where(
          or(
            and(
              inArray(issueLink.sourceIssueId, movedIds),
              notInArray(issueLink.targetIssueId, movedIds),
            ),
            and(
              inArray(issueLink.targetIssueId, movedIds),
              notInArray(issueLink.sourceIssueId, movedIds),
            ),
          ),
        ),
      db.delete(projectDocumentIssue).where(inArray(projectDocumentIssue.issueId, movedIds)),
      db
        .delete(issueWatcher)
        .where(
          and(
            inArray(issueWatcher.issueId, movedIds),
            sql`${issueWatcher.userId} NOT IN (SELECT value FROM json_each(${memberIds}))`,
          ),
        ),
      db
        .update(agentRun)
        .set({ status: 'canceled', executionStartedAt: null, finishedAt: new Date() })
        .where(and(inArray(agentRun.issueId, movedIds), eq(agentRun.status, 'pending'))),
    ]);
  } catch (error) {
    if (/NOT NULL/i.test(String(error) + String((error as Error)?.cause ?? '')))
      throw new HttpError(409, 'The issue changed while it was being moved; try again');
    throw error;
  }

  for (const p of plans) {
    await recordStatusChange(db, [p.id], p.newColumnId);
    await recordCycleChange(db, p.id, p.cycleId, null);
    const after = (await getIssue(db, p.id))!;
    await recordActivity(
      db,
      p.id,
      [
        {
          action: 'moved',
          from: textSide(`${source.key}-${p.sequenceNumber}`),
          to: textSide(after.identifier),
        },
      ],
      actorUserId,
    );
    if (p.id === issueId && p.parentId !== null)
      await recordParentChange(db, p.id, p.parentId, null, actorUserId);
    await emitIssueEvent(db, 'issue.updated', after, actorUserId);
    await queueStatusRuns(db, [p.id], p.newColumnId, actorUserId);
  }
  return (await getIssue(db, issueId))!;
}

// The target project's labels the moved issues carry, matched by name.
async function mapLabels(
  db: Db,
  issueIds: number[],
  targetProjectId: number,
): Promise<{ issueId: number; labelId: number }[]> {
  const targetLabel = db
    .select({ id: label.id, name: label.name })
    .from(label)
    .where(eq(label.projectId, targetProjectId))
    .as('target_label');
  return db
    .select({ issueId: issueLabel.issueId, labelId: targetLabel.id })
    .from(issueLabel)
    .innerJoin(label, eq(label.id, issueLabel.labelId))
    .innerJoin(targetLabel, eq(targetLabel.name, label.name))
    .where(inArray(issueLabel.issueId, issueIds));
}

// Each custom field value of the moved issues paired with the target field of the
// same name and kind (null when there is none, or when another value of the issue
// already took it), and the select options re-pointed at the target field's option of
// the same value.
async function mapFields(db: Db, issueIds: number[], targetProjectId: number) {
  const targetFields = await db
    .select({ id: customField.id, name: customField.name, fieldType: customField.fieldType })
    .from(customField)
    .where(eq(customField.projectId, targetProjectId));
  const findField = (name: string, fieldType: string) =>
    targetFields.find((f) => f.name === name && f.fieldType === fieldType)?.id ?? null;

  const valueRows = await db
    .select({
      id: issueFieldValue.id,
      issueId: issueFieldValue.issueId,
      name: customField.name,
      fieldType: customField.fieldType,
      valueUserId: issueFieldValue.valueUserId,
    })
    .from(issueFieldValue)
    .innerJoin(customField, eq(customField.id, issueFieldValue.fieldId))
    .where(inArray(issueFieldValue.issueId, issueIds));
  const taken = new Set<string>();
  const values = valueRows.map((v) => {
    const fieldId = findField(v.name, v.fieldType);
    const key = `${v.issueId}:${fieldId}`;
    if (fieldId === null || taken.has(key)) return { ...v, fieldId: null };
    taken.add(key);
    return { ...v, fieldId };
  });

  const optionRows = await db
    .select({
      issueId: issueFieldOption.issueId,
      name: customField.name,
      fieldType: customField.fieldType,
      value: customFieldOption.value,
    })
    .from(issueFieldOption)
    .innerJoin(customField, eq(customField.id, issueFieldOption.fieldId))
    .innerJoin(customFieldOption, eq(customFieldOption.id, issueFieldOption.optionId))
    .where(inArray(issueFieldOption.issueId, issueIds));
  const targetFieldIds = targetFields.map((f) => f.id);
  const targetOptions = targetFieldIds.length
    ? await db
        .select({
          id: customFieldOption.id,
          fieldId: customFieldOption.fieldId,
          value: customFieldOption.value,
        })
        .from(customFieldOption)
        .where(inArray(customFieldOption.fieldId, targetFieldIds))
    : [];
  const seen = new Set<string>();
  const options = optionRows.flatMap((o) => {
    const fieldId = findField(o.name, o.fieldType);
    const option = targetOptions.find((t) => t.fieldId === fieldId && t.value === o.value);
    if (fieldId === null || !option) return [];
    const key = `${o.issueId}:${option.id}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ issueId: o.issueId, fieldId, optionId: option.id }];
  });
  return { values, options };
}
