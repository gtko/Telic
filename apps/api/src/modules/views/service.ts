import { batchAll, type Db, projectView, projectViewFavorite } from '@repo/db';
import { and, eq, sql } from 'drizzle-orm';
import { iso, num } from '#shared/lib';

export interface ViewRow {
  id: number;
  projectId: number;
  name: string;
  icon: string | null;
  filters: unknown;
  display: unknown;
  position: number;
  // Unguessable token for the public read-only share link, or null when the view
  // is not shared.
  shareToken: string | null;
  // Whether the share link exposes the full issues (assignees, labels, custom
  // fields, activity) or only their title, description, state, type, priority,
  // dates, subtasks and links.
  shareExtended: boolean;
  createdAt: string;
}

function mapView(row: typeof projectView.$inferSelect): ViewRow {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    icon: row.icon,
    filters: row.filters,
    display: row.display,
    position: num(row.position),
    shareToken: row.shareToken,
    shareExtended: row.shareExtended,
    createdAt: iso(row.createdAt),
  };
}

export interface UserViewRow extends ViewRow {
  favorite: boolean;
}

export async function listViews(db: Db, projectId: number, userId: string): Promise<UserViewRow[]> {
  const rows = await db
    .select({ row: projectView, favoriteUserId: projectViewFavorite.userId })
    .from(projectView)
    .leftJoin(
      projectViewFavorite,
      and(eq(projectViewFavorite.viewId, projectView.id), eq(projectViewFavorite.userId, userId)),
    )
    .where(eq(projectView.projectId, projectId))
    .orderBy(projectView.position, projectView.id);
  return rows.map(({ row, favoriteUserId }) => ({
    ...mapView(row),
    favorite: favoriteUserId !== null,
  }));
}

export async function isFavoriteView(db: Db, viewId: number, userId: string): Promise<boolean> {
  const rows = await db
    .select({ viewId: projectViewFavorite.viewId })
    .from(projectViewFavorite)
    .where(and(eq(projectViewFavorite.viewId, viewId), eq(projectViewFavorite.userId, userId)));
  return rows.length > 0;
}

export async function addFavoriteView(db: Db, viewId: number, userId: string): Promise<void> {
  await db.insert(projectViewFavorite).values({ viewId, userId }).onConflictDoNothing();
}

export async function removeFavoriteView(db: Db, viewId: number, userId: string): Promise<void> {
  await db
    .delete(projectViewFavorite)
    .where(and(eq(projectViewFavorite.viewId, viewId), eq(projectViewFavorite.userId, userId)));
}

export async function createView(
  db: Db,
  input: {
    projectId: number;
    name: string;
    icon?: string | null;
    filters?: unknown;
    display?: unknown;
  },
): Promise<ViewRow> {
  // The position is computed by the INSERT itself, so simultaneous creations never share one.
  const [row] = await db
    .insert(projectView)
    .values({
      projectId: input.projectId,
      name: input.name,
      icon: input.icon ?? null,
      filters: input.filters ?? {},
      display: input.display ?? {},
      position: sql`(select coalesce(max(position) + 1, 0) from ${projectView} where project_id = ${input.projectId})`,
    })
    .returning();
  return mapView(row);
}

export async function getView(db: Db, id: number): Promise<ViewRow | null> {
  const rows = await db.select().from(projectView).where(eq(projectView.id, id));
  return rows[0] ? mapView(rows[0]) : null;
}

export async function updateView(
  db: Db,
  id: number,
  patch: { name?: string; icon?: string | null; filters?: unknown; display?: unknown },
): Promise<ViewRow | null> {
  const set: Partial<typeof projectView.$inferInsert> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.icon !== undefined) set.icon = patch.icon;
  if (patch.filters !== undefined) set.filters = patch.filters;
  if (patch.display !== undefined) set.display = patch.display;
  if (Object.keys(set).length === 0) return getView(db, id);
  const [row] = await db.update(projectView).set(set).where(eq(projectView.id, id)).returning();
  return row ? mapView(row) : null;
}

export async function deleteView(db: Db, id: number): Promise<void> {
  await db.delete(projectView).where(eq(projectView.id, id));
}

export async function reorderViews(
  db: Db,
  projectId: number,
  orderedIds: number[],
  userId: string,
): Promise<UserViewRow[]> {
  await batchAll(
    db,
    orderedIds.map((id, position) =>
      db
        .update(projectView)
        .set({ position })
        .where(and(eq(projectView.id, id), eq(projectView.projectId, projectId))),
    ),
  );
  return listViews(db, projectId, userId);
}
