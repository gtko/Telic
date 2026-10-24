import { eq, sql } from 'drizzle-orm';
import type { DbExecutor } from './client';
import { team, workspace, workspaceManager } from './schema';

export async function teamWorkspaceId(teamId: number, executor: DbExecutor): Promise<number> {
  const [row] = await executor
    .select({ workspaceId: team.workspaceId })
    .from(team)
    .where(eq(team.id, teamId));
  if (!row) throw new Error(`Team ${teamId} does not exist`);
  return row.workspaceId;
}

// A workspace with `ownerId` as its owner. The two inserts go in one D1 batch, which D1 runs
// atomically, so neither row is written without the other; the owner row takes the id of
// the workspace inserted just before it in the batch.
export async function createWorkspace(
  executor: DbExecutor,
  name: string,
  ownerId: string,
): Promise<number> {
  const [created] = await executor.batch([
    executor.insert(workspace).values({ name }).returning({ id: workspace.id }),
    executor
      .insert(workspaceManager)
      .values({ workspaceId: sql`last_insert_rowid()`, userId: ownerId, role: 'owner' }),
  ]);
  return created[0]!.id;
}
