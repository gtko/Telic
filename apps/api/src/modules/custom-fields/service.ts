import {
  type Db,
  batchAll,
  chunk,
  type BatchStatement,
  agentFieldTrigger,
  aiAgent,
  customField,
  customFieldOption,
  issueFieldOption,
  issueFieldValue,
} from '@repo/db';
import { and, asc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { HttpError } from '#shared/lib';
import { getIssueTypeById } from '#modules/issue-types/service';

// Data access for custom fields and their options. Every field belongs to a
// project. A field with issue_type_id NULL is project-wide (applies to every
// issue in its project); a field with issue_type_id set only applies to issues
// of that type. Deleting a field removes its options and any values/selections
// set on issues (ON DELETE CASCADE on the field_id foreign keys).

export type CustomFieldType =
  | 'text'
  | 'markdown'
  | 'url'
  | 'number'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'datetime_range'
  | 'select'
  | 'multi_select'
  | 'member';

// Who a member field may hold. Null for every other field type.
export type MemberScope = 'all' | 'humans' | 'agents';

export interface CustomFieldOptionRow {
  id: number;
  value: string;
  color: string;
  position: number;
}

export interface CustomFieldRow {
  id: number;
  issueTypeId: number | null;
  name: string;
  fieldType: CustomFieldType;
  memberScope: MemberScope | null;
  showInBody: boolean;
  position: number;
  options: CustomFieldOptionRow[];
}

function mapField(
  row: typeof customField.$inferSelect,
  options: CustomFieldOptionRow[],
): CustomFieldRow {
  return {
    id: row.id,
    issueTypeId: row.issueTypeId,
    name: row.name,
    fieldType: row.fieldType as CustomFieldType,
    memberScope: row.memberScope as MemberScope | null,
    showInBody: row.showInBody,
    position: row.position,
    options,
  };
}

// Loads the options for the given field ids, grouped by field, each list ordered
// by position. Returns an empty map for no ids.
async function optionsByField(
  db: Db,
  fieldIds: number[],
): Promise<Map<number, CustomFieldOptionRow[]>> {
  const byField = new Map<number, CustomFieldOptionRow[]>();
  if (fieldIds.length === 0) return byField;
  const rows = (
    await Promise.all(
      chunk(fieldIds).map((ids) =>
        db.select().from(customFieldOption).where(inArray(customFieldOption.fieldId, ids)),
      ),
    )
  )
    .flat()
    .sort((a, b) => a.position - b.position);
  for (const o of rows) {
    let list = byField.get(o.fieldId);
    if (!list) byField.set(o.fieldId, (list = []));
    list.push({ id: o.id, value: o.value, color: o.color, position: o.position });
  }
  return byField;
}

// Fields of one project. With issueTypeId, returns the project-wide fields plus
// that type's own fields; without it, only the project-wide fields. With allTypes,
// returns every field of the project regardless of type scope (used by the board
// payload, which filters by type on the client).
export async function listCustomFields(
  db: Db,
  projectId: number,
  opts: { issueTypeId?: number; allTypes?: boolean } = {},
): Promise<CustomFieldRow[]> {
  const conds: SQL[] = [eq(customField.projectId, projectId)];
  if (!opts.allTypes) {
    if (opts.issueTypeId != null) {
      conds.push(
        or(isNull(customField.issueTypeId), eq(customField.issueTypeId, opts.issueTypeId))!,
      );
    } else {
      conds.push(isNull(customField.issueTypeId));
    }
  }
  const fields = await db
    .select()
    .from(customField)
    .where(and(...conds))
    .orderBy(asc(customField.position));
  const options = await optionsByField(
    db,
    fields.map((f) => f.id),
  );
  return fields.map((f) => mapField(f, options.get(f.id) ?? []));
}

// The ids of the member fields of the given projects an agent can be set into: the ones
// whose scope holds agents. These are the fields an agent may carry a run trigger for.
export async function listAgentMemberFieldIds(db: Db, projectIds: number[]): Promise<number[]> {
  if (projectIds.length === 0) return [];
  const rows = (
    await Promise.all(
      chunk(projectIds).map((ids) =>
        db
          .select({ id: customField.id })
          .from(customField)
          .where(
            and(
              inArray(customField.projectId, ids),
              eq(customField.fieldType, 'member'),
              inArray(customField.memberScope, ['all', 'agents']),
            ),
          ),
      ),
    )
  ).flat();
  return rows.map((r) => r.id);
}

// One field by id, scoped to its project so a field id from another project is
// not matched. Returns null when no field of that id exists in the project.
export async function getCustomFieldById(
  db: Db,
  projectId: number,
  id: number,
): Promise<CustomFieldRow | null> {
  const rows = await db
    .select()
    .from(customField)
    .where(and(eq(customField.id, id), eq(customField.projectId, projectId)));
  if (!rows[0]) return null;
  const options = await optionsByField(db, [id]);
  return mapField(rows[0], options.get(id) ?? []);
}

export async function createCustomField(
  db: Db,
  input: {
    projectId: number;
    issueTypeId?: number | null;
    name: string;
    fieldType: CustomFieldType;
    memberScope?: MemberScope | null;
    showInBody?: boolean;
    options?: string[];
  },
): Promise<CustomFieldRow> {
  const issueTypeId = input.issueTypeId ?? null;
  if (issueTypeId != null) {
    const type = await getIssueTypeById(db, issueTypeId);
    if (!type || type.projectId !== input.projectId) {
      throw new HttpError(400, 'issueTypeId does not belong to this project');
    }
  }
  const options = input.options ?? [];
  // One batch, so a rejected option list leaves no field behind. The position is
  // computed by the INSERT itself (no read-then-write), and the options point at the
  // field just inserted: D1 runs a batch alone, so the highest id of the project's
  // fields is the new one (last_insert_rowid() would move on after the first option).
  const [created] = await db.batch([
    db
      .insert(customField)
      .values({
        projectId: input.projectId,
        issueTypeId,
        name: input.name,
        fieldType: input.fieldType,
        memberScope: input.fieldType === 'member' ? (input.memberScope ?? 'all') : null,
        showInBody: input.showInBody ?? false,
        position: sql`(select coalesce(max(position), -1) + 1 from ${customField} where project_id = ${input.projectId} and issue_type_id is ${issueTypeId})`,
      })
      .returning({ id: customField.id }),
    ...options.map((value, index) =>
      db.insert(customFieldOption).values({
        fieldId: sql`(select max(id) from ${customField} where project_id = ${input.projectId})`,
        value,
        position: index,
      }),
    ),
  ]);
  return (await getCustomFieldById(db, input.projectId, created[0]!.id))!;
}

function holdsOptions(fieldType: CustomFieldType): boolean {
  return fieldType === 'select' || fieldType === 'multi_select';
}

// Every value issues hold in the field, both the scalar rows and the selections of
// its options. A value is written into the column of the type it was set under, so
// it is unreadable once the field carries another type.
function clearFieldValues(db: Db, fieldId: number) {
  return [
    db.delete(issueFieldValue).where(eq(issueFieldValue.fieldId, fieldId)),
    db.delete(issueFieldOption).where(eq(issueFieldOption.fieldId, fieldId)),
  ];
}

// Clears the members a narrowed scope no longer allows, leaving the rest in place.
// An agent is a member whose user id backs an ai_agent row.
function clearMembersOutOfScope(db: Db, fieldId: number, scope: MemberScope) {
  const isAgent = sql`EXISTS (SELECT 1 FROM ${aiAgent} WHERE ${aiAgent.userId} = ${issueFieldValue.valueUserId})`;
  return db
    .update(issueFieldValue)
    .set({ valueUserId: null })
    .where(
      and(eq(issueFieldValue.fieldId, fieldId), scope === 'humans' ? isAgent : sql`NOT ${isAgent}`),
    );
}

// Writes the option list a select field should end up with. An option that arrives
// with an id is renamed in place, so the issues holding it keep it; one that is left
// out is deleted, and its selections go with it.
function syncOptions(
  db: Db,
  fieldId: number,
  existing: CustomFieldOptionRow[],
  next: { id?: number; value: string }[],
) {
  const values = next.map((o) => o.value);
  if (new Set(values).size !== values.length) {
    throw new HttpError(400, 'Option values must be unique');
  }
  const byId = new Map(existing.map((o) => [o.id, o]));
  const kept = new Set(
    next.map((o) => o.id).filter((id): id is number => id != null && byId.has(id)),
  );
  const removed = existing.filter((o) => !kept.has(o.id)).map((o) => o.id);
  const statements: BatchStatement[] = [];
  for (const ids of chunk(removed)) {
    statements.push(db.delete(customFieldOption).where(inArray(customFieldOption.id, ids)));
  }
  for (const [position, option] of next.entries()) {
    if (option.id != null && kept.has(option.id)) {
      statements.push(
        db
          .update(customFieldOption)
          .set({ value: option.value, position })
          .where(eq(customFieldOption.id, option.id)),
      );
    } else {
      statements.push(
        db.insert(customFieldOption).values({ fieldId, value: option.value, position }),
      );
    }
  }
  return statements;
}

// Updates a field, scoped to its project. Returns null when no field of that id
// exists in the project. A field can be reshaped after creation, and the values
// issues already hold follow the reshape: changing the type clears them, narrowing
// a member scope clears the ones it no longer allows, and dropping an option clears
// the selections of it.
export async function updateCustomField(
  db: Db,
  projectId: number,
  id: number,
  patch: {
    name?: string;
    showInBody?: boolean;
    fieldType?: CustomFieldType;
    memberScope?: MemberScope;
    options?: { id?: number; value: string }[];
  },
): Promise<CustomFieldRow | null> {
  const current = await getCustomFieldById(db, projectId, id);
  if (!current) return null;

  const fieldType = patch.fieldType ?? current.fieldType;
  const typeChanged = fieldType !== current.fieldType;
  // A field that has just become a member field carries no scope yet, so it starts
  // at the same default a new one gets.
  let memberScope: MemberScope | null = null;
  if (fieldType === 'member') {
    memberScope = patch.memberScope ?? (typeChanged ? 'all' : current.memberScope);
  }

  // The statements are known once `current` is read, so they go in one atomic batch: a
  // rejected option list (duplicate value) leaves the field untouched.
  const statements: BatchStatement[] = [
    db
      .update(customField)
      .set({
        name: patch.name ?? current.name,
        showInBody: patch.showInBody ?? current.showInBody,
        fieldType,
        memberScope,
      })
      .where(and(eq(customField.id, id), eq(customField.projectId, projectId))),
  ];
  if (typeChanged) {
    statements.push(...clearFieldValues(db, id));
    if (!holdsOptions(fieldType)) {
      statements.push(db.delete(customFieldOption).where(eq(customFieldOption.fieldId, id)));
    }
  } else if (memberScope != null && memberScope !== current.memberScope) {
    if (memberScope !== 'all') statements.push(clearMembersOutOfScope(db, id, memberScope));
  }

  // A field that no longer takes agents drops its agent triggers: kept, they would
  // arm again on their own once the field takes agents anew.
  if (fieldType !== 'member' || memberScope === 'humans') {
    statements.push(db.delete(agentFieldTrigger).where(eq(agentFieldTrigger.fieldId, id)));
  }

  if (patch.options && holdsOptions(fieldType)) {
    statements.push(...syncOptions(db, id, current.options, patch.options));
  }
  await batchAll(db, statements);

  return getCustomFieldById(db, projectId, id);
}

// Deletes a field, scoped to its project. Returns true when a row was removed.
export async function deleteCustomField(db: Db, projectId: number, id: number): Promise<boolean> {
  const deleted = await db
    .delete(customField)
    .where(and(eq(customField.id, id), eq(customField.projectId, projectId)))
    .returning({ id: customField.id });
  return deleted.length > 0;
}
