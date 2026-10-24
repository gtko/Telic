// Membership invariants of the teams service on a local D1: a team keeps an owner, a
// project keeps an owner, a ceiling holds, whatever the order concurrent requests land in.
// D1 runs one writer at a time, so N parallel calls interleave at statement/batch
// boundaries: the guards in the batches are what these tests prove.
import {
  abortBatchWhen,
  isGuardViolation,
  project,
  projectColumn,
  projectMember,
  team,
  teamMember,
  teamRole,
  user,
  workspace,
  workspaceManager,
  createWorkspace,
  type Db,
} from '@repo/db';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDb, type TestDb } from '#tests/helpers/d1';
import {
  createTeam,
  dropWorkspaceMemberships,
  insertOwnedTeam,
  leaveTeam,
  removeTeamMember,
  setTeamMemberRole,
} from '#modules/teams/service';
import { createOwnWorkspace, transferWorkspace } from '#modules/workspaces/service';
import { deleteRole } from '#modules/roles/service';
import { removeMember } from '#modules/members/service';

// The limits are read from the instance settings through a global db; the suite sets them.
const limits = vi.hoisted(() => ({ maxTeams: 0, ownedWorkspaces: 1 }));
vi.mock('#shared/limits', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#shared/limits')>()),
  getLimits: async () => ({ maxTeams: limits.maxTeams, maxSeats: 0 }),
  getOwnedWorkspaceLimit: () => limits.ownedWorkspaces,
}));
vi.mock('@repo/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@repo/auth')>()),
  forgetPersonalWorkspace: () => undefined,
  getAuthSettings: async () => ({ personalWorkspaces: true }),
}));

let t: TestDb;
let db: Db;
let seq = 0;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
});
afterAll(() => t.dispose());

async function mkUser(label: string): Promise<string> {
  const id = `${label}-${++seq}`;
  await db.insert(user).values({ id, name: id, email: `${id}@example.com` });
  return id;
}

async function mkTeam(owners: string[], members: string[] = []) {
  const workspaceId = await createWorkspace(db, `W${++seq}`, owners[0]!);
  const { team: row } = await insertOwnedTeam(db, workspaceId, `T${seq}`, owners[0]!);
  for (const id of owners.slice(1)) {
    await db.insert(teamMember).values({ teamId: row.id, userId: id, role: 'owner' });
  }
  for (const id of members) {
    await db.insert(teamMember).values({ teamId: row.id, userId: id, role: 'member' });
  }
  return { teamId: row.id, workspaceId };
}

async function mkProject(teamId: number, owners: string[], members: string[] = []) {
  const key = `P${++seq}`;
  const [{ id }] = await db
    .insert(project)
    .values({ teamId, key, name: key })
    .returning({ id: project.id });
  await db
    .insert(projectMember)
    .values([
      ...owners.map((userId) => ({ projectId: id, userId, role: 'owner' })),
      ...members.map((userId) => ({ projectId: id, userId, role: 'member' })),
    ]);
  return { projectId: id, key };
}

const ownersOf = async (teamId: number) =>
  (
    await db
      .select({ userId: teamMember.userId })
      .from(teamMember)
      .where(and(eq(teamMember.teamId, teamId), eq(teamMember.role, 'owner')))
  ).map((r) => r.userId);

const outcome = (results: PromiseSettledResult<unknown>[]) => ({
  ok: results.filter((r) => r.status === 'fulfilled').length,
  refused: results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => (r.reason as { status?: number }).status),
});

describe('abortBatchWhen', () => {
  it('aborts the whole batch and rolls back what ran before it', async () => {
    const id = await mkUser('guard');
    const failing = db.batch([
      db.insert(workspace).values({ name: 'ghost' }),
      abortBatchWhen(db, sql`1 = 1`) as never,
      db.insert(workspaceManager).values({ workspaceId: 999_999, userId: id, role: 'owner' }),
    ]);
    const err = await failing.then(
      () => null,
      (e: unknown) => e,
    );
    expect(isGuardViolation(err)).toBe(true);
    expect(await db.$count(workspace, eq(workspace.name, 'ghost'))).toBe(0);
  });

  it('lets the batch through when the violation does not hold', async () => {
    await db.batch([
      abortBatchWhen(db, sql`1 = 0`) as never,
      db.insert(workspace).values({ name: 'fine' }),
    ]);
    expect(await db.$count(workspace, eq(workspace.name, 'fine'))).toBe(1);
  });
});

describe('createTeam', () => {
  it('writes the team, its owner and the default role together', async () => {
    const owner = await mkUser('o');
    const workspaceId = await createWorkspace(db, 'WC', owner);
    limits.maxTeams = 0;
    const created = await createTeam(db, 'Alpha', 'alpha-c', owner, workspaceId);
    expect(created.role).toBe('owner');
    expect(await ownersOf(created.id)).toEqual([owner]);
    const roles = await db.select().from(teamRole).where(eq(teamRole.teamId, created.id));
    expect(roles.map((r) => [r.name, r.isDefault])).toEqual([['Member', true]]);
  });

  it('leaves nothing behind when the slug is taken', async () => {
    const owner = await mkUser('o');
    const workspaceId = await createWorkspace(db, 'WD', owner);
    limits.maxTeams = 0;
    await createTeam(db, 'One', 'dup-slug', owner, workspaceId);
    const teams = await db.$count(team);
    const members = await db.$count(teamMember);
    const roles = await db.$count(teamRole);
    await expect(createTeam(db, 'Two', 'dup-slug', owner, workspaceId)).rejects.toMatchObject({
      status: 409,
      message: 'Another team already uses this slug',
    });
    expect([await db.$count(team), await db.$count(teamMember), await db.$count(teamRole)]).toEqual(
      [teams, members, roles],
    );
  });

  it('holds the team ceiling against requests racing for the last places', async () => {
    const owner = await mkUser('o');
    const workspaceId = await createWorkspace(db, 'WE', owner);
    limits.maxTeams = 2;
    const results = await Promise.allSettled(
      [1, 2, 3, 4].map((n) => createTeam(db, `R${n}`, `race-${seq}-${n}`, owner, workspaceId)),
    );
    limits.maxTeams = 0;
    expect(outcome(results)).toEqual({ ok: 2, refused: [409, 409] });
    expect(await db.$count(team, eq(team.workspaceId, workspaceId))).toBe(2);
  });
});

describe('last owner of a team', () => {
  it('lets only one of two owners leave at once', async () => {
    const [a, b] = [await mkUser('a'), await mkUser('b')];
    const { teamId } = await mkTeam([a, b]);
    const results = await Promise.allSettled([leaveTeam(db, teamId, a), leaveTeam(db, teamId, b)]);
    expect(outcome(results)).toEqual({ ok: 1, refused: [409] });
    expect(await ownersOf(teamId)).toHaveLength(1);
  });

  it('lets only one of N owners remove the others at once', async () => {
    const ids = await Promise.all(['a', 'b', 'c'].map(mkUser));
    const { teamId } = await mkTeam(ids);
    // Every owner removes the next one: a ring, so any sequence of wins leaves >= 1 owner.
    const results = await Promise.allSettled(
      ids.map((id, i) => removeTeamMember(db, teamId, id, ids[(i + 1) % ids.length]!)),
    );
    const { ok } = outcome(results);
    expect(ok).toBeGreaterThanOrEqual(1);
    expect((await ownersOf(teamId)).length).toBe(3 - ok);
    expect((await ownersOf(teamId)).length).toBeGreaterThanOrEqual(1);
  });

  it('refuses to remove or leave as the only owner, with the right message', async () => {
    const [a, b] = [await mkUser('a'), await mkUser('b')];
    const { teamId } = await mkTeam([a], [b]);
    await expect(leaveTeam(db, teamId, a)).rejects.toMatchObject({
      status: 409,
      message: 'The last owner cannot leave the team',
    });
    expect(await ownersOf(teamId)).toEqual([a]);
  });

  it('lets only one of two owners demote the other at once', async () => {
    const [a, b] = [await mkUser('a'), await mkUser('b')];
    const { teamId } = await mkTeam([a, b]);
    const results = await Promise.allSettled([
      setTeamMemberRole(db, teamId, { userId: a, role: 'owner' }, b, 'member'),
      setTeamMemberRole(db, teamId, { userId: b, role: 'owner' }, a, 'member'),
    ]);
    expect(outcome(results)).toEqual({ ok: 1, refused: [409] });
    expect(await ownersOf(teamId)).toHaveLength(1);
  });
});

describe('leaving a team', () => {
  it('takes the project memberships and column auto-assignments along', async () => {
    const [a, m] = [await mkUser('a'), await mkUser('m')];
    const { teamId } = await mkTeam([a], [m]);
    const { projectId } = await mkProject(teamId, [a], [m]);
    const [{ id: columnId }] = await db
      .insert(projectColumn)
      .values({ projectId, name: 'Todo', stateType: 'unstarted', position: 0, autoAssignUserId: m })
      .returning({ id: projectColumn.id });
    await leaveTeam(db, teamId, m);
    expect(await db.$count(teamMember, eq(teamMember.userId, m))).toBe(0);
    expect(await db.$count(projectMember, eq(projectMember.userId, m))).toBe(0);
    const [column] = await db.select().from(projectColumn).where(eq(projectColumn.id, columnId));
    expect(column!.autoAssignUserId).toBeNull();
  });

  it('refuses when the person owns a project alone, and changes nothing', async () => {
    const [a, b] = [await mkUser('a'), await mkUser('b')];
    const { teamId } = await mkTeam([a, b]);
    const { key } = await mkProject(teamId, [b]);
    await expect(leaveTeam(db, teamId, b)).rejects.toMatchObject({
      status: 409,
      message: `You are the only owner of ${key}. Give each one another owner first.`,
    });
    expect(await db.$count(teamMember, eq(teamMember.userId, b))).toBe(1);
  });

  it('keeps a project owner when two owners of a project leave at once', async () => {
    const [a, b, c] = [await mkUser('a'), await mkUser('b'), await mkUser('c')];
    const { teamId } = await mkTeam([a, c], [b]);
    const { projectId } = await mkProject(teamId, [b, c]);
    const results = await Promise.allSettled([leaveTeam(db, teamId, b), leaveTeam(db, teamId, c)]);
    expect(outcome(results)).toEqual({ ok: 1, refused: [409] });
    expect(
      await db.$count(
        projectMember,
        and(eq(projectMember.projectId, projectId), eq(projectMember.role, 'owner')),
      ),
    ).toBe(1);
  });

  it('refuses to end a membership the SCIM sync owns', async () => {
    const [a, m] = [await mkUser('a'), await mkUser('m')];
    const { teamId } = await mkTeam([a], []);
    await db.insert(teamMember).values({ teamId, userId: m, role: 'member', source: 'scim' });
    await expect(leaveTeam(db, teamId, m)).rejects.toMatchObject({
      status: 409,
      message: 'This membership is managed by SCIM',
    });
  });
});

describe('dropWorkspaceMemberships', () => {
  it('hands the sole ownership to the workspace owner, then removes the person', async () => {
    const [w, x] = [await mkUser('w'), await mkUser('x')];
    const { teamId: t1, workspaceId } = await mkTeam([w], [x]);
    // x owns a second team alone, and a project alone in the first.
    const second = await insertOwnedTeam(db, workspaceId, 'Second', x);
    const { projectId } = await mkProject(t1, [x]);
    await dropWorkspaceMemberships(db, workspaceId, x);

    expect(await db.$count(teamMember, eq(teamMember.userId, x))).toBe(0);
    expect(await ownersOf(second.team.id)).toEqual([w]);
    const [owner] = await db
      .select()
      .from(projectMember)
      .where(and(eq(projectMember.projectId, projectId), eq(projectMember.role, 'owner')));
    expect(owner!.userId).toBe(w);
    expect(await db.$count(projectMember, eq(projectMember.userId, x))).toBe(0);
  });
});

describe('workspaces', () => {
  it('lets one of two simultaneous workspace creations through', async () => {
    const u = await mkUser('u');
    limits.ownedWorkspaces = 1;
    const current = { id: u, role: 'user' } as never;
    const results = await Promise.allSettled([
      createOwnWorkspace(db, current, 'A'),
      createOwnWorkspace(db, current, 'B'),
    ]);
    expect(outcome(results)).toEqual({ ok: 1, refused: [409] });
    expect(
      await db.$count(
        workspaceManager,
        and(eq(workspaceManager.userId, u), eq(workspaceManager.role, 'owner')),
      ),
    ).toBe(1);
  });

  it('transfers ownership atomically and keeps a single owner', async () => {
    const [o, n] = [await mkUser('o'), await mkUser('n')];
    const workspaceId = await createWorkspace(db, 'WT', o);
    await db.insert(workspaceManager).values({ workspaceId, userId: n, role: 'admin' });
    limits.ownedWorkspaces = 0;
    await transferWorkspace(db, workspaceId, o, n);
    const rows = await db
      .select({ userId: workspaceManager.userId, role: workspaceManager.role })
      .from(workspaceManager)
      .where(eq(workspaceManager.workspaceId, workspaceId));
    expect(Object.fromEntries(rows.map((r) => [r.userId, r.role]))).toEqual({
      [o]: 'admin',
      [n]: 'owner',
    });
  });
});

describe('roles and project members', () => {
  it('moves everything off a deleted role in one batch', async () => {
    const [a, m] = [await mkUser('a'), await mkUser('m')];
    const { teamId } = await mkTeam([a], [m]);
    const { projectId } = await mkProject(teamId, [a], [m]);
    const [from, to] = await db
      .insert(teamRole)
      .values([
        { teamId, name: 'From', isDefault: false, permissions: {} as never },
        { teamId, name: 'To', isDefault: false, permissions: {} as never },
      ])
      .returning({ id: teamRole.id });
    await db
      .update(projectMember)
      .set({ roleId: from!.id })
      .where(and(eq(projectMember.projectId, projectId), eq(projectMember.userId, m)));
    await deleteRole(db, teamId, from!.id, to!.id);
    expect(await db.$count(teamRole, eq(teamRole.id, from!.id))).toBe(0);
    const [row] = await db
      .select()
      .from(projectMember)
      .where(and(eq(projectMember.projectId, projectId), eq(projectMember.userId, m)));
    expect(row!.roleId).toBe(to!.id);
  });

  it('removes a project member and clears their column auto-assignment together', async () => {
    const [a, m] = [await mkUser('a'), await mkUser('m')];
    const { teamId } = await mkTeam([a], [m]);
    const { projectId } = await mkProject(teamId, [a], [m]);
    const [{ id: columnId }] = await db
      .insert(projectColumn)
      .values({ projectId, name: 'Todo', stateType: 'unstarted', position: 0, autoAssignUserId: m })
      .returning({ id: projectColumn.id });
    await removeMember(db, projectId, m);
    expect(await db.$count(projectMember, eq(projectMember.userId, m))).toBe(0);
    const [column] = await db.select().from(projectColumn).where(eq(projectColumn.id, columnId));
    expect(column!.autoAssignUserId).toBeNull();
  });
});
