import { type Db, projectDashboard } from '@repo/db';
import { and, eq, sql } from 'drizzle-orm';
import { iso, num } from '#shared/lib';

// Saved dashboards: the analytics tabs of a project. layout is a jsonb blob owned
// by the UI (an ordered list of widget entries); this layer stores and returns it
// without inspecting its shape. position orders the tabs.

export interface DashboardRow {
  id: number;
  projectId: number;
  name: string;
  icon: string | null;
  layout: unknown;
  position: number;
  createdAt: string;
}

function mapDashboard(row: typeof projectDashboard.$inferSelect): DashboardRow {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    icon: row.icon,
    layout: row.layout,
    position: num(row.position),
    createdAt: iso(row.createdAt),
  };
}

export async function listDashboards(db: Db, projectId: number): Promise<DashboardRow[]> {
  const rows = await db
    .select()
    .from(projectDashboard)
    .where(eq(projectDashboard.projectId, projectId))
    .orderBy(projectDashboard.position, projectDashboard.id);
  return rows.map(mapDashboard);
}

// New dashboards go to the end of the tab row (max position + 1). layout is stored
// verbatim in the jsonb column.
export async function createDashboard(
  db: Db,
  input: {
    projectId: number;
    name: string;
    icon?: string | null;
    layout?: unknown;
  },
): Promise<DashboardRow> {
  const [{ pos }] = await db
    .select({ pos: sql<number>`COALESCE(MAX(${projectDashboard.position}) + 1, 0)` })
    .from(projectDashboard)
    .where(eq(projectDashboard.projectId, input.projectId));
  const [row] = await db
    .insert(projectDashboard)
    .values({
      projectId: input.projectId,
      name: input.name,
      icon: input.icon ?? null,
      layout: input.layout ?? [],
      position: Number(pos),
    })
    .returning();
  return mapDashboard(row);
}

export async function getDashboard(db: Db, id: number): Promise<DashboardRow | null> {
  const rows = await db.select().from(projectDashboard).where(eq(projectDashboard.id, id));
  return rows[0] ? mapDashboard(rows[0]) : null;
}

// Updates only the provided fields. layout is replaced wholesale (not merged),
// since the UI always sends the full blob.
export async function updateDashboard(
  db: Db,
  id: number,
  patch: { name?: string; icon?: string | null; layout?: unknown },
): Promise<DashboardRow | null> {
  const set: Partial<typeof projectDashboard.$inferInsert> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.icon !== undefined) set.icon = patch.icon;
  if (patch.layout !== undefined) set.layout = patch.layout;
  if (Object.keys(set).length === 0) return getDashboard(db, id);
  const [row] = await db
    .update(projectDashboard)
    .set(set)
    .where(eq(projectDashboard.id, id))
    .returning();
  return row ? mapDashboard(row) : null;
}

export async function deleteDashboard(db: Db, id: number): Promise<void> {
  await db.delete(projectDashboard).where(eq(projectDashboard.id, id));
}

// Sets each dashboard's position to its index in orderedIds, in one D1 batch, so the tab
// order the UI sends is stored exactly. Ids not on the project are ignored.
export async function reorderDashboards(
  db: Db,
  projectId: number,
  orderedIds: number[],
): Promise<DashboardRow[]> {
  if (orderedIds.length > 0) {
    const updates = orderedIds.map((id, position) =>
      db
        .update(projectDashboard)
        .set({ position })
        .where(and(eq(projectDashboard.id, id), eq(projectDashboard.projectId, projectId))),
    );
    await db.batch(updates as [(typeof updates)[number], ...(typeof updates)[number][]]);
  }
  return listDashboards(db, projectId);
}
