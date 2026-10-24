// A local D1 (Miniflare) carrying the committed baseline, for the service-level *.vtest.ts
// suites run by vitest (see apps/api/vitest.config.ts). The services are called with this
// `db`, so they run against real D1 semantics: batches, RETURNING, one writer at a time.
import { createDb, createWorkspace, type Db } from '@repo/db';
import { project, projectColumn, projectMember, team, teamMember, user } from '@repo/db/schema';
import { Miniflare } from 'miniflare';
import type { ProjectRow } from '#modules/projects/service';
import { migrateD1 } from '../../../../../packages/db/src/migrate';

export interface TestDb {
  db: Db;
  dispose(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: 'test-db' },
  });
  const db = createDb((await mf.getD1Database('DB')) as unknown as Parameters<typeof createDb>[0]);
  // For the stand-ins of setup-vtest.ts that cannot be handed a db.
  (globalThis as { __vtestDb?: Db }).__vtestDb = db;
  await migrateD1(db);
  return { db, dispose: () => mf.dispose() };
}

export interface SeededProject {
  userId: string;
  teamId: number;
  projectId: number;
  key: string;
  // Ids of the columns, in board order.
  columnIds: number[];
}

// A user who owns a workspace, a team and a project with the given columns.
export async function seedProject(
  db: Db,
  opts: {
    key?: string;
    userId?: string;
    teamId?: number;
    columns?: { name: string; stateType: string }[];
  } = {},
): Promise<SeededProject> {
  const key = opts.key ?? 'MKT';
  const userId = opts.userId ?? `user-${key}`;
  let teamId = opts.teamId;
  if (teamId === undefined) {
    await db
      .insert(user)
      .values({ id: userId, name: userId, email: `${userId}@example.com` })
      .onConflictDoNothing();
    const workspaceId = await createWorkspace(db, `W-${key}`, userId);
    [{ id: teamId }] = await db
      .insert(team)
      .values({ workspaceId, name: `Team ${key}` })
      .returning({ id: team.id });
    await db.insert(teamMember).values({ teamId, userId, role: 'owner' });
  }
  const [{ id: projectId }] = await db
    .insert(project)
    .values({ teamId, key, name: `Project ${key}` })
    .returning({ id: project.id });
  await db.insert(projectMember).values({ projectId, userId, role: 'owner' });
  const columns = opts.columns ?? [
    { name: 'Backlog', stateType: 'backlog' },
    { name: 'Todo', stateType: 'unstarted' },
    { name: 'Done', stateType: 'completed' },
  ];
  const rows = await db
    .insert(projectColumn)
    .values(columns.map((column, position) => ({ projectId, ...column, position })))
    .returning({ id: projectColumn.id });
  return { userId, teamId, projectId, key, columnIds: rows.map((row) => row.id) };
}

// The slice of a ProjectRow the issue services read (id, key, team); the full row is
// built by mapProject, which reads the team's limits and is not under test here.
export function projectRowOf(seeded: SeededProject): ProjectRow {
  return { id: seeded.projectId, key: seeded.key, teamId: seeded.teamId } as ProjectRow;
}
