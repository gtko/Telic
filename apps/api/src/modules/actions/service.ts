import { batchAll, projectAction, type Db } from '@repo/db';
import { and, eq, sql } from 'drizzle-orm';
import { iso, num } from '#shared/lib';

// Manual actions: saved macros on a project. condition is a filter set deciding
// which issues the action applies to (empty = always); effect is a partial issue
// patch applied in one update. Both jsonb blobs are owned by the UI; this layer
// stores and returns them without inspecting their shape.

export interface ActionRow {
  id: number;
  projectId: number;
  name: string;
  icon: string;
  condition: unknown;
  effect: unknown;
  position: number;
  createdAt: string;
}

function mapAction(row: typeof projectAction.$inferSelect): ActionRow {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    icon: row.icon,
    condition: row.condition,
    effect: row.effect,
    position: num(row.position),
    createdAt: iso(row.createdAt),
  };
}

export async function listActions(db: Db, projectId: number): Promise<ActionRow[]> {
  const rows = await db
    .select()
    .from(projectAction)
    .where(eq(projectAction.projectId, projectId))
    .orderBy(projectAction.position, projectAction.id);
  return rows.map(mapAction);
}

// New actions go to the end of the list (max position + 1). condition/effect are
// stored verbatim in the jsonb columns.
export async function createAction(
  db: Db,
  input: {
    projectId: number;
    name: string;
    icon?: string;
    condition?: unknown;
    effect?: unknown;
  },
): Promise<ActionRow> {
  const [{ pos }] = await db
    .select({ pos: sql<number>`COALESCE(MAX(${projectAction.position}) + 1, 0)` })
    .from(projectAction)
    .where(eq(projectAction.projectId, input.projectId));
  const [row] = await db
    .insert(projectAction)
    .values({
      projectId: input.projectId,
      name: input.name,
      icon: input.icon ?? '',
      condition: input.condition ?? {},
      effect: input.effect ?? {},
      position: Number(pos),
    })
    .returning();
  return mapAction(row);
}

export async function getAction(db: Db, id: number): Promise<ActionRow | null> {
  const rows = await db.select().from(projectAction).where(eq(projectAction.id, id));
  return rows[0] ? mapAction(rows[0]) : null;
}

// Updates only the provided fields. condition/effect are replaced wholesale (not
// merged), since the UI always sends the full blob.
export async function updateAction(
  db: Db,
  id: number,
  patch: { name?: string; icon?: string; condition?: unknown; effect?: unknown },
): Promise<ActionRow | null> {
  const set: Partial<typeof projectAction.$inferInsert> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.icon !== undefined) set.icon = patch.icon;
  if (patch.condition !== undefined) set.condition = patch.condition;
  if (patch.effect !== undefined) set.effect = patch.effect;
  if (Object.keys(set).length === 0) return getAction(db, id);
  const [row] = await db.update(projectAction).set(set).where(eq(projectAction.id, id)).returning();
  return row ? mapAction(row) : null;
}

export async function deleteAction(db: Db, id: number): Promise<void> {
  await db.delete(projectAction).where(eq(projectAction.id, id));
}

// Sets each action's position to its index in orderedIds, in one atomic batch, so
// the order the UI sends is stored exactly. Ids not on the project are ignored.
export async function reorderActions(
  db: Db,
  projectId: number,
  orderedIds: number[],
): Promise<ActionRow[]> {
  await batchAll(
    db,
    orderedIds.map((id, position) =>
      db
        .update(projectAction)
        .set({ position })
        .where(and(eq(projectAction.id, id), eq(projectAction.projectId, projectId))),
    ),
  );
  return listActions(db, projectId);
}
