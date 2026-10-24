import {
  project,
  projectMember,
  scimGroup,
  scimGroupMapping,
  scimGroupMember,
  scimUser,
  teamMember,
  appSetting,
  batchAll,
  setSetting,
  teamWorkspaceId,
  user,
  type Db,
} from '@repo/db';
import { and, eq, isNotNull, isNull, like, or, sql } from 'drizzle-orm';
import { workspacesWithOwnScim } from '@repo/auth';
import { removeMember, setMembership, type MemberRole } from '#modules/members/service';
import { listSeatHolderIds } from '#modules/teams/service';
import { getLimits } from '#shared/limits';

// Turns provisioned group membership into project membership, and into the team
// membership it stands on. This is the only place either row is written from SCIM,
// and it only ever touches rows it owns (`source: 'scim'`) — a membership somebody
// set up through an invite is left exactly as it is, in either direction.
//
// Called after a group's members or its mappings change, a person becomes active, or a
// workspace turns SCIM of its own on or off.

interface Desired {
  role: MemberRole;
  roleId: number | null;
}

// A Worker invocation may run about 1000 D1 queries. A reconciliation over many projects
// or a large group can exceed that, so it spends from a budget and, when the budget runs
// out, parks the projects it did not finish as pending cursors; `resumeReconcile` (run by
// the scheduled handler, one tick at a time) picks them up. Choice: a cron re-trigger
// rather than a queue message, since no queue binding exists for it and the work is
// idempotent — a tick recomputes each pending project's difference and applies what is
// still missing, so a crash, a duplicate tick or a half-done project loses nothing.
export const RECONCILE_QUERY_BUDGET = 900;
// What reading one project (its mappings, members, limits, seats) costs at most, before
// any write: a project is not started with less than this left.
const PROJECT_READ_COST = 12;
const PENDING_PREFIX = 'scim.reconcile.pending.';

export class QueryBudget {
  constructor(public left: number) {}
  // Takes `n` queries from the budget; false (and nothing taken) when too few are left.
  spend(n = 1): boolean {
    if (this.left < n) return false;
    this.left -= n;
    return true;
  }
}

// One setting key per project, so two requests parking projects never overwrite each
// other (a single list would be a read-modify-write that D1 cannot make atomic).
async function parkPending(db: Db, projectIds: number[]): Promise<void> {
  for (const id of projectIds) await setSetting(db, `${PENDING_PREFIX}${id}`, 1);
}

export async function pendingReconcileProjects(db: Db): Promise<number[]> {
  const rows = await db
    .select({ key: appSetting.key })
    .from(appSetting)
    .where(like(appSetting.key, `${PENDING_PREFIX}%`))
    .orderBy(appSetting.key);
  return rows.map((row) => Number(row.key.slice(PENDING_PREFIX.length)));
}

// Reconciles the projects within the query budget and parks the rest. Returns whether
// all of them finished.
export async function reconcileProjects(
  db: Db,
  projectIds: number[],
  budget = new QueryBudget(RECONCILE_QUERY_BUDGET),
): Promise<boolean> {
  const todo = [...new Set(projectIds)];
  for (let i = 0; i < todo.length; i += 1) {
    const projectId = todo[i]!;
    if (budget.left >= PROJECT_READ_COST && (await reconcileProject(db, projectId, budget))) {
      await db.delete(appSetting).where(eq(appSetting.key, `${PENDING_PREFIX}${projectId}`));
      continue;
    }
    await parkPending(db, todo.slice(i));
    return false;
  }
  return true;
}

// One tick of the scheduled handler: continues the parked projects with a fresh budget.
export async function resumeReconcile(db: Db): Promise<{ remaining: number }> {
  const pending = await pendingReconcileProjects(db);
  if (pending.length === 0) return { remaining: 0 };
  await reconcileProjects(db, pending);
  return { remaining: (await pendingReconcileProjects(db)).length };
}

// The group members whose mappings grant a project of this workspace, as a condition on
// `scimGroup`, `scimUser` and `user`. A person a workspace's provider deactivated is
// granted nothing by its groups. An account the instance's provider deactivated keeps
// what it had: it cannot sign in, and is back where it was once reactivated. The
// instance's groups grant nothing in a workspace that set up SCIM of its own.
async function grantingMembers(db: Db, workspaceId: number) {
  const active = or(isNull(scimUser.active), eq(scimUser.active, true));
  if ((await workspacesWithOwnScim(db)).includes(workspaceId)) {
    return and(isNotNull(scimGroup.workspaceId), active);
  }
  return or(active, and(isNull(scimGroup.workspaceId), eq(user.active, false)));
}

// Who the mappings say should be a member of this project. A user reachable
// through two mappings resolves to the strongest: 'owner' beats 'member', and among
// equals the lowest mapping id wins, so the result does not depend on row order.
async function desiredMembers(
  db: Db,
  projectId: number,
  workspaceId: number,
): Promise<Map<string, Desired>> {
  const granting = await grantingMembers(db, workspaceId);
  const rows = await db
    .select({
      userId: scimGroupMember.userId,
      role: scimGroupMapping.role,
      roleId: scimGroupMapping.roleId,
    })
    .from(scimGroupMapping)
    .innerJoin(scimGroupMember, eq(scimGroupMember.groupId, scimGroupMapping.groupId))
    .innerJoin(scimGroup, eq(scimGroup.id, scimGroupMapping.groupId))
    .innerJoin(user, eq(user.id, scimGroupMember.userId))
    .leftJoin(
      scimUser,
      and(
        sql`${scimUser.workspaceId} IS ${scimGroup.workspaceId}`,
        eq(scimUser.userId, scimGroupMember.userId),
      ),
    )
    .where(and(eq(scimGroupMapping.projectId, projectId), granting))
    .orderBy(scimGroupMapping.id);

  const desired = new Map<string, Desired>();
  for (const row of rows) {
    const role = row.role as MemberRole;
    const current = desired.get(row.userId);
    if (current && (current.role === 'owner' || role !== 'owner')) continue;
    // Owners bypass the permission matrix, so they carry no custom role.
    desired.set(row.userId, { role, roleId: role === 'owner' ? null : row.roleId });
  }
  return desired;
}

// False when the budget ran out before the project was fully reconciled: what was
// written stays, and the next run recomputes the difference.
async function reconcileProject(db: Db, projectId: number, budget: QueryBudget): Promise<boolean> {
  const [owner] = await db
    .select({ teamId: project.teamId })
    .from(project)
    .where(eq(project.id, projectId));
  budget.spend(PROJECT_READ_COST);
  if (!owner) return true;
  const workspaceId = await teamWorkspaceId(owner.teamId, db);
  const desired = await desiredMembers(db, projectId, workspaceId);
  const existing = await db
    .select({
      userId: projectMember.userId,
      role: projectMember.role,
      roleId: projectMember.roleId,
      source: projectMember.source,
    })
    .from(projectMember)
    .where(eq(projectMember.projectId, projectId));

  const byUser = new Map(existing.map((row) => [row.userId, row]));
  // A seat ceiling stops the provider from adding people the workspace has no room for.
  // Those already in it keep their membership and still join the project.
  const { maxSeats } = await getLimits(db, workspaceId);
  const seats =
    maxSeats > 0 ? new Set(await listSeatHolderIds(db, workspaceId)) : new Set<string>();
  // Tracked as rows change so the last-owner guard below stays correct without
  // re-counting after every write.
  let owners = existing.filter((row) => row.role === 'owner').length;

  for (const [userId, want] of desired) {
    const have = byUser.get(userId);
    if (!have) {
      if (maxSeats > 0 && !seats.has(userId)) {
        if (seats.size >= maxSeats) continue;
        seats.add(userId);
      }
      // A project membership only exists on top of one in the team that owns the
      // project, so the group grants that first. It never raises an existing rank. One
      // atomic batch: the team row never stands without its project row.
      if (!budget.spend(2)) return false;
      await batchAll(db, [
        db
          .insert(teamMember)
          .values({ teamId: owner.teamId, userId, role: 'member', source: 'scim' })
          .onConflictDoNothing(),
        db.insert(projectMember).values({
          projectId,
          userId,
          role: want.role,
          roleId: want.roleId,
          source: 'scim',
        }),
      ]);
      if (want.role === 'owner') owners += 1;
      continue;
    }
    // A membership a person set up outranks the identity provider: the group adds
    // nothing on top of it and never takes it away.
    if (have.source !== 'scim') continue;
    if (have.role === want.role && have.roleId === want.roleId) continue;
    if (have.role === 'owner' && want.role !== 'owner' && owners <= 1) continue;
    if (!budget.spend(2)) return false;
    await setMembership(db, projectId, userId, want.role, want.roleId);
    if (have.role === 'owner' && want.role !== 'owner') owners -= 1;
    if (have.role !== 'owner' && want.role === 'owner') owners += 1;
  }

  for (const row of existing) {
    if (row.source !== 'scim' || desired.has(row.userId)) continue;
    // A project without an owner has nobody who can manage its members, so the
    // last one stays even when the group no longer grants it.
    if (row.role === 'owner' && owners <= 1) continue;
    if (!budget.spend(4)) return false;
    await removeMember(db, projectId, row.userId);
    await dropUnusedTeamMembership(db, owner.teamId, row.userId);
    if (row.role === 'owner') owners -= 1;
  }
  return true;
}

// The team membership the group granted goes when the last project it granted in
// that team does. Only a row the reconciliation owns: one somebody set up by hand is
// left alone, as their project membership is, and so is a row whose rank was raised
// afterwards — a team is left with owners and managers it did not have to re-appoint.
export async function dropUnusedTeamMembership(
  db: Db,
  teamId: number,
  userId: string,
): Promise<void> {
  const remaining = await db
    .select({ projectId: projectMember.projectId })
    .from(projectMember)
    .innerJoin(project, eq(project.id, projectMember.projectId))
    .where(and(eq(project.teamId, teamId), eq(projectMember.userId, userId)))
    .limit(1);
  if (remaining.length > 0) return;
  await db
    .delete(teamMember)
    .where(
      and(
        eq(teamMember.teamId, teamId),
        eq(teamMember.userId, userId),
        eq(teamMember.role, 'member'),
        eq(teamMember.source, 'scim'),
      ),
    );
}

// The projects a group currently grants membership in. Read before and after a
// change so reconciliation covers the projects it was removed from as well.
export async function mappedProjectIds(db: Db, groupId: string): Promise<number[]> {
  const rows = await db
    .select({ projectId: scimGroupMapping.projectId })
    .from(scimGroupMapping)
    .where(eq(scimGroupMapping.groupId, groupId));
  return rows.map((row) => row.projectId);
}
