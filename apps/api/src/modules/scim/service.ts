import {
  aiAgent,
  project,
  projectMember,
  scimGroup,
  scimGroupMapping,
  scimGroupMember,
  scimUser,
  team,
  teamMember,
  user,
  workspaceManager,
  batchAll,
  isForeignKeyViolation,
  isUniqueViolation,
  type BatchStatement,
  type Db,
} from '@repo/db';
import {
  and,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  notExists,
  or,
  sql,
  type Column,
} from 'drizzle-orm';
import { generateUsername } from '@repo/auth';
import { iso } from '#shared/lib';
import { deleteAccount } from '#shared/account-deletion';
import { countOwners } from '#modules/members/service';
import { dropWorkspaceMemberships } from '#modules/teams/service';
import { ScimError, type ScimFilter, type ScimGroupRecord, type ScimUserRecord } from './resource';
import { isScimEmailAllowed } from './email-policy';
import { mappedProjectIds, reconcileProjects } from './reconcile';

// Data access for the SCIM endpoints. Every call acts for the one provider the bearer
// token opened: a workspace's, or the instance's when `workspaceId` is null. What a
// provider says about a person — its own id for them and whether they are active — is
// kept per provider in `scim_user`.
//
// The instance's provider is set up by god in god mode and acts on the whole instance:
// it sees every account, keeps names and addresses in step, a deactivated account
// cannot sign in, and a delete removes the account. A workspace's, where a hosted build
// sets SCIM up per workspace, decides who has the workspace, not who has an account: it
// sees the accounts it linked and the people in the workspace's teams, deactivating or
// deleting someone takes them out of those teams, and their name, address and sign-in
// stay as they are.
//
// A create for an address that has no account inserts the `user` row directly rather
// than going through better-auth's sign-up — the same way an agent's bot user is
// written. That deliberately skips the instance registration gate, which is what
// makes a closed instance plus SSO a working combination.
//
// An AI agent's bot user is an account too, but it belongs to the project that
// created it, not to the identity provider: `notAnAgent` keeps every one of them out
// of /Users, so a sync cannot take an agent out of its team.

// What each resource can be filtered on. Advertised by ServiceProviderConfig and
// enforced by parseFilter, so the three never drift apart.
export const USER_FILTER_ATTRIBUTES = ['userName', 'externalId', 'emails.value'];
export const GROUP_FILTER_ATTRIBUTES = ['displayName', 'externalId'];

// True for every account that is not an AI agent's bot user. The same test the god
// user directory uses for its `human` filter.
function notAnAgent(db: Db) {
  return notExists(
    db
      .select({ n: sql`1` })
      .from(aiAgent)
      .where(eq(aiAgent.userId, user.id)),
  );
}

// A row of this provider, on a `workspace_id` column.
export function ofProvider(column: Column, workspaceId: number | null) {
  return workspaceId === null ? isNull(column) : eq(column, workspaceId);
}

// The unique key a provider's row conflicts on. The instance's rows have no workspace,
// so they are unique on a partial index of their own (see schema/scim.ts in @repo/db).
function scimUserConflict(workspaceId: number | null) {
  return workspaceId === null
    ? { target: scimUser.userId, targetWhere: isNull(scimUser.workspaceId) }
    : { target: [scimUser.workspaceId, scimUser.userId] };
}

function scimGroupConflict(workspaceId: number | null) {
  return workspaceId === null
    ? { target: scimGroup.displayName, where: isNull(scimGroup.workspaceId) }
    : { target: [scimGroup.workspaceId, scimGroup.displayName] };
}

// The join of an account to what this provider says about it. Every user query here
// left-joins it: a person in the workspace's teams the provider never wrote has no row.
function linkOf(workspaceId: number | null) {
  return and(eq(scimUser.userId, user.id), ofProvider(scimUser.workspaceId, workspaceId));
}

// The accounts a workspace's provider sees: the ones it wrote, and the people in the
// workspace's teams. The instance's provider, every account.
function inWorkspace(db: Db, workspaceId: number | null) {
  if (workspaceId === null) return notAnAgent(db);
  return and(
    notAnAgent(db),
    or(
      isNotNull(scimUser.userId),
      exists(
        db
          .select({ n: sql`1` })
          .from(teamMember)
          .innerJoin(team, eq(team.id, teamMember.teamId))
          .where(and(eq(teamMember.userId, user.id), eq(team.workspaceId, workspaceId))),
      ),
    ),
  );
}

// The address is the identity a SCIM sync and an OIDC/password sign-up share, but
// the two paths do not agree on case: better-auth stores whatever case a sign-up or
// an OIDC profile carried, while a SCIM `userName` typically arrives lowercased from
// a directory. Matching case-sensitively would miss an account that predates the
// sync and provision a duplicate instead of linking it.
function emailEq(email: string) {
  return eq(sql`lower(${user.email})`, email.trim().toLowerCase());
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  active: boolean | null;
  externalId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toUserRecord(row: UserRow): ScimUserRecord {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    // Null for a person the provider never wrote, who is active.
    active: row.active !== false,
    externalId: row.externalId,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

const userColumns = {
  id: user.id,
  email: user.email,
  name: user.name,
  active: scimUser.active,
  externalId: scimUser.externalId,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
};

// ── Users ─────────────────────────────────────────────────────────────────────

function userWhere(db: Db, workspaceId: number | null, filter: ScimFilter | null) {
  const seen = inWorkspace(db, workspaceId);
  if (!filter) return seen;
  if (filter.attribute === 'externalid') return and(seen, eq(scimUser.externalId, filter.value));
  return and(seen, emailEq(filter.value));
}

export async function listScimUsers(
  db: Db,
  workspaceId: number | null,
  options: { filter: ScimFilter | null; startIndex: number; count: number },
): Promise<{ records: ScimUserRecord[]; total: number }> {
  const where = userWhere(db, workspaceId, options.filter);
  const [rows, totals] = await Promise.all([
    db
      .select(userColumns)
      .from(user)
      .leftJoin(scimUser, linkOf(workspaceId))
      .where(where)
      .orderBy(user.createdAt)
      .limit(options.count)
      .offset(options.startIndex - 1),
    db
      .select({ count: sql<number>`count(*)` })
      .from(user)
      .leftJoin(scimUser, linkOf(workspaceId))
      .where(where),
  ]);
  return { records: rows.map(toUserRecord), total: totals[0]?.count ?? 0 };
}

export async function getScimUser(
  db: Db,
  workspaceId: number | null,
  id: string,
): Promise<ScimUserRecord | null> {
  const rows = await db
    .select(userColumns)
    .from(user)
    .leftJoin(scimUser, linkOf(workspaceId))
    .where(and(eq(user.id, id), inWorkspace(db, workspaceId)));
  return rows[0] ? toUserRecord(rows[0]) : null;
}

// The role is what grants god mode, and nothing about the instance owner's standing is
// the identity provider's to change.
function assertNotGod(role: string | null, action: string): void {
  if (role === 'god')
    throw new ScimError(409, `An instance owner cannot be ${action} through SCIM`);
}

// The workspace owner runs its SCIM provisioning and receives what a deprovisioned
// person owned alone, so the workspace's own provider cannot take it from them. The
// instance's provider answers to the instance owner, whom assertNotGod covers, and
// nothing is handed over.
async function assertNotWorkspaceOwner(
  db: Db,
  workspaceId: number | null,
  userId: string,
): Promise<void> {
  if (workspaceId === null) return;
  const [owner] = await db
    .select({ userId: workspaceManager.userId })
    .from(workspaceManager)
    .where(
      and(
        eq(workspaceManager.workspaceId, workspaceId),
        eq(workspaceManager.userId, userId),
        eq(workspaceManager.role, 'owner'),
      ),
    );
  if (owner) {
    throw new ScimError(409, 'The workspace owner cannot be deprovisioned through SCIM');
  }
}

export async function createScimUser(
  db: Db,
  workspaceId: number | null,
  input: { email: string; name: string; active: boolean; externalId: string | null },
): Promise<ScimUserRecord> {
  const email = input.email.trim().toLowerCase();
  if (!(await isScimEmailAllowed(workspaceId, email))) {
    throw new ScimError(
      400,
      `The address '${input.email}' is not in an allowed domain`,
      'invalidValue',
    );
  }
  const [existing] = await db
    .select({ id: user.id, role: user.role, externalId: scimUser.externalId })
    .from(user)
    .leftJoin(scimUser, linkOf(workspaceId))
    .where(and(emailEq(email), notAnAgent(db)));
  if (existing) {
    assertNotGod(existing.role, 'provisioned');
    // A second create for an address this provider already linked is a retry, not a
    // new person — Okta repeats a create after a timeout — and must not silently
    // overwrite what the first one wrote with whatever the retry happens to carry.
    if (existing.externalId) {
      throw new ScimError(
        409,
        `A user with userName '${input.email}' already exists`,
        'uniqueness',
      );
    }
    if (!input.active) await assertNotWorkspaceOwner(db, workspaceId, existing.id);
  }

  // An address with an account is that person: the provider links it rather than
  // creating a second one, and leaves its name and username as the person set them.
  // For the instance's provider, `active` is the account's own: it decides whether the
  // account signs in at all.
  const instanceWide = workspaceId === null;
  const userId = existing?.id ?? crypto.randomUUID();
  const statements: BatchStatement[] = [];
  if (existing && instanceWide) {
    statements.push(db.update(user).set({ active: input.active }).where(eq(user.id, userId)));
  }
  if (!existing) {
    statements.push(
      db.insert(user).values({
        id: userId,
        email,
        name: input.name,
        emailVerified: true,
        role: 'user',
        // The @mention handle, derived from the address the same way a sign-up
        // derives it. The identity provider does not supply one.
        username: await generateUsername(email),
        active: instanceWide ? input.active : true,
      }),
    );
  }
  statements.push(
    db
      .insert(scimUser)
      .values({ workspaceId, userId, externalId: input.externalId, active: input.active })
      .onConflictDoUpdate({
        ...scimUserConflict(workspaceId),
        set: { externalId: input.externalId, active: input.active },
      }),
  );
  try {
    await batchAll(db, statements);
  } catch (err) {
    // Two creates for one address racing: the unique index on the address lets one in.
    if (!existing && isUniqueViolation(err)) {
      throw new ScimError(
        409,
        `A user with userName '${input.email}' already exists`,
        'uniqueness',
      );
    }
    throw err;
  }
  if (input.active) await reconcileProjects(db, await groupProjectIds(db, workspaceId, userId));
  else if (!instanceWide) await dropWorkspaceMemberships(db, workspaceId, userId);
  return (await getScimUser(db, workspaceId, userId))!;
}

// Writes what the provider says about a person: its id for them and whether they are
// active. The instance's provider writes their name and address too; for a workspace's,
// those are the person's own, and a PUT or PATCH that carries them leaves them as they
// are.
export async function updateScimUser(
  db: Db,
  workspaceId: number | null,
  id: string,
  patch: { email?: string; name?: string; active?: boolean; externalId?: string | null },
): Promise<ScimUserRecord | null> {
  const [target] = await db
    .select({ role: user.role, active: scimUser.active })
    .from(user)
    .leftJoin(scimUser, linkOf(workspaceId))
    .where(and(eq(user.id, id), inWorkspace(db, workspaceId)));
  if (!target) return null;
  assertNotGod(target.role, 'updated');
  const wasActive = target.active !== false;
  const active = patch.active ?? wasActive;
  if (wasActive && !active) await assertNotWorkspaceOwner(db, workspaceId, id);
  const instanceWide = workspaceId === null;
  if (instanceWide) await updateAccount(db, id, { ...patch, active });

  await db
    .insert(scimUser)
    .values({ workspaceId, userId: id, externalId: patch.externalId ?? null, active })
    .onConflictDoUpdate({
      ...scimUserConflict(workspaceId),
      set: { active, ...(patch.externalId !== undefined ? { externalId: patch.externalId } : {}) },
    });
  if (wasActive && !active && !instanceWide) await dropWorkspaceMemberships(db, workspaceId, id);
  // Back in the workspace: the groups they are still in grant their projects again.
  if (!wasActive && active) await reconcileProjects(db, await groupProjectIds(db, workspaceId, id));
  return getScimUser(db, workspaceId, id);
}

// The account as the instance's provider says it is: its name, its address, and
// whether it signs in. An address another account holds is refused, since a sign-in
// matches on it.
async function updateAccount(
  db: Db,
  id: string,
  patch: { email?: string; name?: string; active: boolean },
): Promise<void> {
  const email = patch.email?.trim().toLowerCase();
  if (email) {
    const [clash] = await db
      .select({ id: user.id })
      .from(user)
      .where(and(emailEq(email), notAnAgent(db)));
    if (clash && clash.id !== id) {
      throw new ScimError(
        409,
        `A user with userName '${patch.email}' already exists`,
        'uniqueness',
      );
    }
  }
  await db
    .update(user)
    .set({
      ...(email ? { email } : {}),
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      active: patch.active,
      updatedAt: new Date(),
    })
    .where(eq(user.id, id));
}

// The projects the provider's groups grant this person.
async function groupProjectIds(
  db: Db,
  workspaceId: number | null,
  userId: string,
): Promise<number[]> {
  const rows = await db
    .select({ projectId: scimGroupMapping.projectId })
    .from(scimGroupMapping)
    .innerJoin(scimGroupMember, eq(scimGroupMember.groupId, scimGroupMapping.groupId))
    .innerJoin(scimGroup, eq(scimGroup.id, scimGroupMapping.groupId))
    .where(and(ofProvider(scimGroup.workspaceId, workspaceId), eq(scimGroupMember.userId, userId)));
  return rows.map((row) => row.projectId);
}

// Some identity providers embed group membership on the user instead of, or as well
// as, pushing separate Group resources — this is what makes a sync grant project
// access without the operator ever configuring a Group push. A named group that
// does not exist yet is created, the way a group pushed through POST /Groups would
// be; the user is added to each one, and every project already mapped to one of
// them is reconciled so membership takes effect immediately.
//
// Additive only: a name missing from a later sync is not removed here. Which
// provider is authoritative for a group is a per-workspace choice — a provider that
// also pushes Group resources removes a member through PATCH /Groups, and one that
// only ever embeds `groups` on the user never lists a name it wants revoked, so
// there is nothing to compare against without one of the two mechanisms winning
// over the other by accident.
export async function syncEmbeddedGroups(
  db: Db,
  workspaceId: number | null,
  userId: string,
  displayNames: string[],
): Promise<void> {
  if (displayNames.length === 0) return;
  const groupIds: string[] = [];
  for (const displayName of displayNames) {
    const created = await db
      .insert(scimGroup)
      .values({ workspaceId, displayName })
      .onConflictDoNothing(scimGroupConflict(workspaceId))
      .returning({ id: scimGroup.id });
    if (created[0]) {
      groupIds.push(created[0].id);
      continue;
    }
    const existing = await db
      .select({ id: scimGroup.id })
      .from(scimGroup)
      .where(
        and(ofProvider(scimGroup.workspaceId, workspaceId), eq(scimGroup.displayName, displayName)),
      );
    groupIds.push(existing[0]!.id);
  }
  await db
    .insert(scimGroupMember)
    .values(groupIds.map((groupId) => ({ groupId, userId })))
    .onConflictDoNothing();
  const projectIds = (
    await Promise.all(groupIds.map((groupId) => mappedProjectIds(db, groupId)))
  ).flat();
  await reconcileProjects(db, projectIds);
}

// For a workspace's provider, unlinks a person from it and takes them out of the
// workspace: its teams, its projects and its groups. The account stays. The instance's
// provider removes the account, the way god mode does; deprovisioning normally arrives
// as `active: false` instead.
export async function deleteScimUser(
  db: Db,
  workspaceId: number | null,
  id: string,
): Promise<void> {
  const [target] = await db
    .select({ role: user.role })
    .from(user)
    .leftJoin(scimUser, linkOf(workspaceId))
    .where(and(eq(user.id, id), inWorkspace(db, workspaceId)));
  // An agent's bot user and an account outside the workspace are not part of its
  // SCIM user surface at all, so they answer the same way an unknown id does.
  if (!target) throw new ScimError(404, `User '${id}' not found`);
  assertNotGod(target.role, 'deleted');
  if (workspaceId === null) {
    if (await ownsProjectAlone(db, id)) {
      throw new ScimError(
        409,
        'This user is the only owner of a project. Deactivate them instead, or hand the ' +
          'project over to another owner first.',
      );
    }
    await deleteAccount(db, id);
    return;
  }
  await assertNotWorkspaceOwner(db, workspaceId, id);

  await dropWorkspaceMemberships(db, workspaceId, id);
  await batchAll(db, [
    db
      .delete(scimGroupMember)
      .where(
        and(
          eq(scimGroupMember.userId, id),
          inArray(
            scimGroupMember.groupId,
            db
              .select({ id: scimGroup.id })
              .from(scimGroup)
              .where(eq(scimGroup.workspaceId, workspaceId)),
          ),
        ),
      ),
    db.delete(scimUser).where(and(eq(scimUser.workspaceId, workspaceId), eq(scimUser.userId, id))),
  ]);
}

// Whether this user owns a project alone outside the workspaces they own. Deleting the
// account would leave it with nobody who can manage its members; the ones in their own
// workspaces pass to the instance owner with the workspace (releaseOwnedWorkspaces).
async function ownsProjectAlone(db: Db, userId: string): Promise<boolean> {
  const owned = await db
    .select({ projectId: projectMember.projectId })
    .from(projectMember)
    .innerJoin(project, eq(project.id, projectMember.projectId))
    .innerJoin(team, eq(team.id, project.teamId))
    .where(
      and(
        eq(projectMember.userId, userId),
        eq(projectMember.role, 'owner'),
        notExists(
          db
            .select({ n: sql`1` })
            .from(workspaceManager)
            .where(
              and(
                eq(workspaceManager.workspaceId, team.workspaceId),
                eq(workspaceManager.userId, userId),
                eq(workspaceManager.role, 'owner'),
              ),
            ),
        ),
      ),
    );
  for (const row of owned) {
    if ((await countOwners(db, row.projectId)) <= 1) return true;
  }
  return false;
}

// ── Groups ────────────────────────────────────────────────────────────────────

function groupWhere(workspaceId: number | null, filter: ScimFilter | null) {
  const own = ofProvider(scimGroup.workspaceId, workspaceId);
  if (!filter) return own;
  if (filter.attribute === 'externalid') {
    return and(own, eq(scimGroup.externalId, filter.value));
  }
  return and(own, eq(scimGroup.displayName, filter.value));
}

// Refuses a member id that names no account the provider sees.
async function assertKnownMembers(
  db: Db,
  workspaceId: number | null,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  const known = await db
    .select({ id: user.id })
    .from(user)
    .leftJoin(scimUser, linkOf(workspaceId))
    .where(and(inArray(user.id, ids), inWorkspace(db, workspaceId)));
  const knownIds = new Set(known.map((row) => row.id));
  const missing = ids.filter((id) => !knownIds.has(id));
  if (missing.length > 0) {
    throw new ScimError(400, `Unknown member id(s): ${missing.join(', ')}`, 'invalidValue');
  }
}

async function loadMembers(
  db: Db,
  groupIds: string[],
): Promise<Map<string, { userId: string; name: string }[]>> {
  const out = new Map<string, { userId: string; name: string }[]>();
  if (groupIds.length === 0) return out;
  const rows = await db
    .select({ groupId: scimGroupMember.groupId, userId: user.id, name: user.name })
    .from(scimGroupMember)
    .innerJoin(user, eq(user.id, scimGroupMember.userId))
    .where(inArray(scimGroupMember.groupId, groupIds))
    .orderBy(user.name);
  for (const row of rows) {
    const list = out.get(row.groupId) ?? [];
    list.push({ userId: row.userId, name: row.name });
    out.set(row.groupId, list);
  }
  return out;
}

async function toGroupRecords(
  db: Db,
  rows: {
    id: string;
    displayName: string;
    externalId: string | null;
    createdAt: Date;
    updatedAt: Date;
  }[],
): Promise<ScimGroupRecord[]> {
  const members = await loadMembers(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((row) => ({
    id: row.id,
    displayName: row.displayName,
    externalId: row.externalId,
    members: members.get(row.id) ?? [],
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  }));
}

export async function listScimGroups(
  db: Db,
  workspaceId: number | null,
  options: { filter: ScimFilter | null; startIndex: number; count: number },
): Promise<{ records: ScimGroupRecord[]; total: number }> {
  const where = groupWhere(workspaceId, options.filter);
  const [rows, totals] = await Promise.all([
    db
      .select()
      .from(scimGroup)
      .where(where)
      .orderBy(scimGroup.createdAt)
      .limit(options.count)
      .offset(options.startIndex - 1),
    db
      .select({ count: sql<number>`count(*)` })
      .from(scimGroup)
      .where(where),
  ]);
  return { records: await toGroupRecords(db, rows), total: totals[0]?.count ?? 0 };
}

export async function getScimGroup(
  db: Db,
  workspaceId: number | null,
  id: string,
): Promise<ScimGroupRecord | null> {
  const rows = await db
    .select()
    .from(scimGroup)
    .where(and(eq(scimGroup.id, id), ofProvider(scimGroup.workspaceId, workspaceId)));
  if (!rows[0]) return null;
  return (await toGroupRecords(db, rows))[0]!;
}

export async function createScimGroup(
  db: Db,
  workspaceId: number | null,
  input: { displayName: string; externalId: string | null; members: string[] },
): Promise<ScimGroupRecord> {
  const members = [...new Set(input.members)];
  await assertKnownMembers(db, workspaceId, members);
  // The unique indexes on (provider, displayName) decide between two creates racing for
  // one name: the id is chosen here so the members can ride in the same atomic batch.
  const created = { id: crypto.randomUUID() };
  try {
    await batchAll(db, [
      db.insert(scimGroup).values({
        id: created.id,
        workspaceId,
        displayName: input.displayName,
        externalId: input.externalId,
      }),
      ...(members.length > 0
        ? [
            db
              .insert(scimGroupMember)
              .values(members.map((userId) => ({ groupId: created.id, userId }))),
          ]
        : []),
    ]);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ScimError(409, `A group named '${input.displayName}' already exists`, 'uniqueness');
    }
    throw err;
  }
  await reconcileProjects(db, await mappedProjectIds(db, created.id));
  return (await getScimGroup(db, workspaceId, created.id))!;
}

export async function updateScimGroup(
  db: Db,
  workspaceId: number | null,
  id: string,
  patch: { displayName?: string; externalId?: string | null; members?: string[] },
): Promise<ScimGroupRecord | null> {
  const members = patch.members ? [...new Set(patch.members)] : undefined;
  if (members) {
    // A member the group already holds can have left the workspace's teams since it
    // was added; refusing it would block every later change to the group.
    const held = await db
      .select({ userId: scimGroupMember.userId })
      .from(scimGroupMember)
      .where(eq(scimGroupMember.groupId, id));
    const heldIds = new Set(held.map((row) => row.userId));
    await assertKnownMembers(
      db,
      workspaceId,
      members.filter((userId) => !heldIds.has(userId)),
    );
  }
  const [found] = await db
    .select({ id: scimGroup.id })
    .from(scimGroup)
    .where(and(eq(scimGroup.id, id), ofProvider(scimGroup.workspaceId, workspaceId)));
  if (!found) return null;
  // The unique index on (provider, displayName) refuses a rename onto another group's
  // name at write time, which a read-then-write check could not do under concurrency.
  try {
    await batchAll(db, [
      db
        .update(scimGroup)
        .set({
          ...(patch.displayName ? { displayName: patch.displayName } : {}),
          ...(patch.externalId !== undefined ? { externalId: patch.externalId } : {}),
          updatedAt: new Date(),
        })
        .where(eq(scimGroup.id, id)),
      ...(members
        ? [
            db.delete(scimGroupMember).where(eq(scimGroupMember.groupId, id)),
            ...(members.length > 0
              ? [
                  db
                    .insert(scimGroupMember)
                    .values(members.map((userId) => ({ groupId: id, userId }))),
                ]
              : []),
          ]
        : []),
    ]);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ScimError(409, `A group named '${patch.displayName}' already exists`, 'uniqueness');
    }
    if (isForeignKeyViolation(err)) return null; // the group was deleted in between
    throw err;
  }
  await reconcileProjects(db, await mappedProjectIds(db, id));
  return getScimGroup(db, workspaceId, id);
}

export async function deleteScimGroup(
  db: Db,
  workspaceId: number | null,
  id: string,
): Promise<boolean> {
  // Read the mappings before the cascade removes them, so the projects the group
  // granted membership in are reconciled after it is gone.
  const projects = await mappedProjectIds(db, id);
  const deleted = await db
    .delete(scimGroup)
    .where(and(eq(scimGroup.id, id), ofProvider(scimGroup.workspaceId, workspaceId)))
    .returning({ id: scimGroup.id });
  if (deleted.length === 0) return false;
  await reconcileProjects(db, projects);
  return true;
}
