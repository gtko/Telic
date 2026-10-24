import {
  user,
  session,
  oauthAccessToken,
  oauthRefreshToken,
  teamInvite,
  account,
  agentSkill,
  agentTool,
  aiAgent,
  initiative,
  issue,
  issueActivity,
  project,
  projectDashboard,
  projectMember,
  team,
  teamMember,
  teamRole,
  projectView,
  workspaceManager,
  type Db,
  chunk,
} from '@repo/db';
import {
  and,
  desc,
  eq,
  exists,
  like,
  inArray,
  isNotNull,
  isNull,
  notExists,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { AnySQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { accountsManagedByScim } from '@repo/auth';
import { iso } from '#shared/lib';
import { deleteAccount } from '#shared/account-deletion';
import {
  defaultMemberPermissions,
  fullPermissions,
  normalizePermissions,
  type Permissions,
} from '#shared/permissions';
import { listAllMembers, listMemberContexts } from '#modules/members/service';
import type { TeamStanding } from '#modules/teams/service';

// Data access for the instance directories (god mode): every account and every
// project on this instance. It reads across the better-auth tables (user, session,
// account) and across projects the caller is not a member of, which no
// project-scoped store may do — every function here is behind the god guard.

// The instance owner keeps god mode; an agent's account follows its agent; with SCIM the
// identity provider decides.
export type ActiveLock = 'owner' | 'agent' | 'scim';

export interface InstanceUserRow {
  id: string;
  name: string;
  email: string;
  image: string | null;
  emailVerified: boolean;
  // The global better-auth role: "god" for the instance owner, "user" otherwise.
  role: string;
  // True when this user is an AI agent's bot user. Agents are created on a
  // project's AI Agents screen, not by signing up.
  isAgent: boolean;
  // The sign-in methods linked to the account ("credential", "google", …).
  providers: string[];
  projectCount: number;
  // False when the account is deactivated (user.active), by god or the instance's SCIM
  // provider: it cannot open a session until it is reactivated.
  active: boolean;
  // Why god cannot switch `active` here, or null when it can.
  activeLock: ActiveLock | null;
  // The start of the most recent session, or null when the user never signed in.
  lastSeenAt: string | null;
  createdAt: string;
}

// A project the user can reach, with the access their membership resolves to.
export interface InstanceUserProject {
  projectId: number;
  projectKey: string;
  projectName: string;
  role: 'owner' | 'member';
  roleId: number | null;
  roleName: string | null;
  // The effective matrix: full for an owner, the assigned role's matrix for a
  // member, the default member matrix when no role is assigned.
  permissions: Permissions;
  // How many owners the project has. 1 on a project this user owns means deleting
  // the account would leave the project with nobody who can manage it, unless it is in a
  // workspace of theirs.
  ownerCount: number;
  // Whether the project's team is in a workspace this user owns. That workspace passes to
  // the instance owner with the account, and with it what the user owned alone there.
  inOwnWorkspace: boolean;
  joinedAt: string;
}

export interface InstanceUserDetail extends InstanceUserRow {
  projects: InstanceUserProject[];
}

type UserRow = typeof user.$inferSelect;

// The effective matrix of a membership: full for an owner, the assigned role's
// matrix for a member, the default member matrix when no role is assigned.
function resolvePermissions(role: 'owner' | 'member', rolePermissions: unknown): Permissions {
  if (role === 'owner') return fullPermissions();
  if (!rolePermissions) return defaultMemberPermissions();
  return normalizePermissions(rolePermissions);
}

// The per-user facts that live in other tables. Collected in one grouped query
// each and joined in memory, so the user query stays a plain select.
interface UserFacts {
  agents: Set<string>;
  providers: Map<string, string[]>;
  projectCounts: Map<string, number>;
  lastSeen: Map<string, Date>;
}

async function loadUserFacts(db: Db, userIds: string[]): Promise<UserFacts> {
  if (userIds.length === 0) {
    return {
      agents: new Set(),
      providers: new Map(),
      projectCounts: new Map(),
      lastSeen: new Map(),
    };
  }
  const [agentRows, accountRows, memberRows, sessionRows] = await Promise.all([
    db.select({ userId: aiAgent.userId }).from(aiAgent).where(inArray(aiAgent.userId, userIds)),
    db
      .select({ userId: account.userId, providerId: account.providerId })
      .from(account)
      .where(inArray(account.userId, userIds)),
    db
      .select({ userId: projectMember.userId, count: sql<number>`count(*)` })
      .from(projectMember)
      .where(inArray(projectMember.userId, userIds))
      .groupBy(projectMember.userId),
    // Session start times, reduced to the latest per user below. Aggregating in
    // SQL would return the max as a driver-formatted string, not a Date.
    db
      .select({ userId: session.userId, createdAt: session.createdAt })
      .from(session)
      .where(inArray(session.userId, userIds)),
  ]);

  const providers = new Map<string, string[]>();
  for (const r of accountRows) {
    const list = providers.get(r.userId) ?? [];
    if (!list.includes(r.providerId)) list.push(r.providerId);
    providers.set(r.userId, list);
  }

  const lastSeen = new Map<string, Date>();
  for (const r of sessionRows) {
    const current = lastSeen.get(r.userId);
    if (!current || r.createdAt > current) lastSeen.set(r.userId, r.createdAt);
  }

  return {
    agents: new Set(agentRows.map((r) => r.userId)),
    providers,
    projectCounts: new Map(memberRows.map((r) => [r.userId, r.count])),
    lastSeen,
  };
}

function activeLockOf(role: string, isAgent: boolean, scim: boolean): ActiveLock | null {
  if (role === 'god') return 'owner';
  if (isAgent) return 'agent';
  return scim ? 'scim' : null;
}

function toRow(r: UserRow, facts: UserFacts, scim: boolean): InstanceUserRow {
  const lastSeen = facts.lastSeen.get(r.id) ?? null;
  const role = r.role ?? 'user';
  const isAgent = facts.agents.has(r.id);
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    image: r.image,
    emailVerified: r.emailVerified,
    role,
    isAgent,
    providers: facts.providers.get(r.id) ?? [],
    projectCount: facts.projectCounts.get(r.id) ?? 0,
    active: r.active !== false,
    activeLock: activeLockOf(role, isAgent, scim),
    lastSeenAt: lastSeen ? iso(lastSeen) : null,
    createdAt: iso(r.createdAt),
  };
}

export interface InstanceUserPage {
  items: InstanceUserRow[];
  // How many accounts match the filters, ignoring the page window.
  total: number;
}

// Which accounts the directory lists: real people, the bot users behind AI agents,
// or both.
export const USER_KINDS = ['human', 'agent', 'all'] as const;
export type UserKind = (typeof USER_KINDS)[number];

// One page of accounts, newest first. `search` matches the name or the email;
// `kind` narrows to people or agent bot users. Both filters run in SQL, so the page
// window and the total count agree.
export async function listInstanceUsers(
  db: Db,
  options: {
    search?: string;
    kind: UserKind;
    limit: number;
    offset: number;
  },
): Promise<InstanceUserPage> {
  const term = options.search?.trim();
  const isAgent = db
    .select({ n: sql`1` })
    .from(aiAgent)
    .where(eq(aiAgent.userId, user.id));
  const where = and(
    term ? or(like(user.name, `%${term}%`), like(user.email, `%${term}%`)) : undefined,
    options.kind === 'human'
      ? notExists(isAgent)
      : options.kind === 'agent'
        ? exists(isAgent)
        : undefined,
  );

  const [rows, totals] = await Promise.all([
    db
      .select()
      .from(user)
      .where(where)
      .orderBy(desc(user.createdAt))
      .limit(options.limit)
      .offset(options.offset),
    db
      .select({ count: sql<number>`count(*)` })
      .from(user)
      .where(where),
  ]);

  const facts = await loadUserFacts(
    db,
    rows.map((r) => r.id),
  );
  const scim = await accountsManagedByScim();
  return { items: rows.map((r) => toRow(r, facts, scim)), total: totals[0]?.count ?? 0 };
}

// One account with the projects it can reach. Returns null for an unknown id.
export async function getInstanceUser(db: Db, userId: string): Promise<InstanceUserDetail | null> {
  const rows = await db.select().from(user).where(eq(user.id, userId));
  const row = rows[0];
  if (!row) return null;

  const [facts, memberships, ownedWorkspaces] = await Promise.all([
    loadUserFacts(db, [row.id]),
    db
      .select({
        projectId: project.id,
        projectKey: project.key,
        projectName: project.name,
        workspaceId: team.workspaceId,
        role: projectMember.role,
        roleId: projectMember.roleId,
        roleName: teamRole.name,
        permissions: teamRole.permissions,
        joinedAt: projectMember.createdAt,
      })
      .from(projectMember)
      .innerJoin(project, eq(project.id, projectMember.projectId))
      .innerJoin(team, eq(team.id, project.teamId))
      .leftJoin(teamRole, eq(teamRole.id, projectMember.roleId))
      .where(eq(projectMember.userId, userId))
      .orderBy(project.name),
    db
      .select({ id: workspaceManager.workspaceId })
      .from(workspaceManager)
      .where(and(eq(workspaceManager.userId, userId), eq(workspaceManager.role, 'owner'))),
  ]);
  const owned = new Set(ownedWorkspaces.map((w) => w.id));

  const ownerCounts = await countOwnersByProject(
    db,
    memberships.map((m) => m.projectId),
  );

  const projects: InstanceUserProject[] = memberships.map((m) => {
    const role = m.role === 'owner' ? 'owner' : 'member';
    return {
      projectId: m.projectId,
      projectKey: m.projectKey,
      projectName: m.projectName,
      role,
      roleId: m.roleId,
      roleName: m.roleName,
      ownerCount: ownerCounts.get(m.projectId) ?? 0,
      inOwnWorkspace: owned.has(m.workspaceId),
      permissions: resolvePermissions(role, m.permissions),
      joinedAt: iso(m.joinedAt),
    };
  });

  return { ...toRow(row, facts, await accountsManagedByScim()), projects };
}

// How many owners each of the given projects has, keyed by project id.
async function countOwnersByProject(db: Db, projectIds: number[]): Promise<Map<number, number>> {
  if (projectIds.length === 0) return new Map();
  const rows = await db
    .select({ projectId: projectMember.projectId, count: sql<number>`count(*)` })
    .from(projectMember)
    .where(and(eq(projectMember.role, 'owner'), inArray(projectMember.projectId, projectIds)))
    .groupBy(projectMember.projectId);
  return new Map(rows.map((r) => [r.projectId, r.count]));
}

// Removes the account. Every table that points at a user either cascades (its
// sessions, accounts, memberships, notifications, preferences) or sets the
// reference to null (assignee, activity actor, invites), so this is a single
// delete.
export async function deleteInstanceUser(db: Db, userId: string): Promise<void> {
  await deleteAccount(db, userId);
}

// Deactivates or reactivates an account without deleting it, through the same user.active
// a SCIM provider writes: the auth session hook and the request guard refuse it, API keys
// included, which therefore stay and work again once it is reactivated. Its sessions, MCP
// OAuth tokens and pending invites are dropped. Returns the updated user, or null if gone.
export async function setInstanceUserActive(
  db: Db,
  userId: string,
  active: boolean,
): Promise<InstanceUserDetail | null> {
  if (!(await getInstanceUser(db, userId))) return null;
  // Marked first, so a sign-in that lands while the revocation runs is refused a session.
  await db.update(user).set({ active }).where(eq(user.id, userId));
  if (!active) {
    await db.delete(session).where(eq(session.userId, userId));
    await db.delete(oauthRefreshToken).where(eq(oauthRefreshToken.userId, userId));
    await db.delete(oauthAccessToken).where(eq(oauthAccessToken.userId, userId));
    // Their pending invites would otherwise keep the registration gate open.
    await db
      .delete(teamInvite)
      .where(and(eq(teamInvite.invitedByUserId, userId), eq(teamInvite.status, 'pending')));
  }
  return getInstanceUser(db, userId);
}

// ── Project directory ────────────────────────────────────────────────────────

// What a project holds, counted across its dependent tables. Read for the list and
// the detail alike, so a row in the directory already carries everything.
export interface InstanceProjectCounts {
  memberCount: number;
  issueCount: number;
  archivedIssueCount: number;
  initiativeCount: number;
  dashboardCount: number;
  viewCount: number;
  agentCount: number;
  skillCount: number;
  toolCount: number;
}

export interface InstanceProjectRow extends InstanceProjectCounts {
  id: number;
  key: string;
  name: string;
  description: string;
  mcpEnabled: boolean;
  // The most recent entry in the project's issue feed, or null when nothing has
  // happened in it yet.
  lastActivityAt: string | null;
  createdAt: string;
}

// One member of the project, with the access their membership resolves to. The
// mirror of InstanceUserProject: same facts, read from the project's side.
export interface InstanceProjectMember {
  userId: string;
  name: string;
  email: string;
  // The handle they are mentioned by, @username. An agent's bot user carries the
  // agent's handle, not one of its own.
  username: string | null;
  image: string | null;
  isAgent: boolean;
  role: 'owner' | 'member';
  roleId: number | null;
  roleName: string | null;
  permissions: Permissions;
  description: string;
  timezone: string;
  joinedAt: string;
}

export interface InstanceProjectDetail extends InstanceProjectRow {
  members: InstanceProjectMember[];
}

export interface InstanceProjectPage {
  items: InstanceProjectRow[];
  // How many projects match the search, ignoring the page window.
  total: number;
}

// How many rows each of the given projects can draw on in a team-scoped table (the
// skill library, the configured tools): they belong to the team that owns the project,
// so two projects of one team report the same number.
async function countByTeamOfProject(
  db: Db,
  table: SQLiteTable,
  teamIdColumn: AnySQLiteColumn,
  projectIds: number[],
): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  for (const slice of chunk(projectIds, 90)) {
    const rows = await db
      .select({ projectId: project.id, count: sql<number>`count(${teamIdColumn})` })
      .from(project)
      .leftJoin(table, eq(teamIdColumn, project.teamId))
      .where(inArray(project.id, slice))
      .groupBy(project.id);
    for (const r of rows) counts.set(r.projectId, r.count);
  }
  return counts;
}

const countAt = (counts: Map<number, number>, id: number) => counts.get(id) ?? 0;

// How many rows each of the given owners has in a table that points at them, keyed by
// the owner id: a project-scoped table by project, a team-scoped one by team.
async function countByOwner(
  db: Db,
  table: SQLiteTable,
  ownerIdColumn: AnySQLiteColumn,
  ownerIds: number[],
  extra?: SQL,
): Promise<Map<number, number>> {
  // D1 binds at most 100 parameters per statement: long owner lists go in slices.
  const counts = new Map<number, number>();
  for (const slice of chunk(ownerIds, 90)) {
    const rows = await db
      .select({ ownerId: ownerIdColumn, count: sql<number>`count(*)` })
      .from(table)
      .where(and(inArray(ownerIdColumn, slice), extra))
      .groupBy(ownerIdColumn);
    for (const r of rows) counts.set(r.ownerId as number, r.count);
  }
  return counts;
}

type ProjectFacts = InstanceProjectCounts & { lastActivityAt: string | null };

const EMPTY_FACTS: ProjectFacts = {
  memberCount: 0,
  issueCount: 0,
  archivedIssueCount: 0,
  initiativeCount: 0,
  dashboardCount: 0,
  viewCount: 0,
  agentCount: 0,
  skillCount: 0,
  toolCount: 0,
  lastActivityAt: null,
};

// The counts and the last feed entry for the given projects, each in one grouped
// query and joined in memory, so the project query stays a plain select.
async function loadProjectFacts(
  db: Db,
  projectIds: number[],
): Promise<(id: number) => ProjectFacts> {
  if (projectIds.length === 0) return () => EMPTY_FACTS;

  const [
    members,
    issues,
    archivedIssues,
    initiatives,
    dashboards,
    views,
    agents,
    skills,
    tools,
    activityRows,
  ] = await Promise.all([
    countByOwner(db, projectMember, projectMember.projectId, projectIds),
    countByOwner(db, issue, issue.projectId, projectIds, isNull(issue.archivedAt)),
    countByOwner(db, issue, issue.projectId, projectIds, isNotNull(issue.archivedAt)),
    countByOwner(db, initiative, initiative.projectId, projectIds),
    countByOwner(db, projectDashboard, projectDashboard.projectId, projectIds),
    countByOwner(db, projectView, projectView.projectId, projectIds),
    // An agent belongs to a team and works in the projects it is a member of, so the
    // count per project is its memberships, not its own rows.
    countByOwner(
      db,
      projectMember,
      projectMember.projectId,
      projectIds,
      sql`exists (select 1 from ${aiAgent} where ${aiAgent.userId} = ${projectMember.userId})`,
    ),
    countByTeamOfProject(db, agentSkill, agentSkill.teamId, projectIds),
    countByTeamOfProject(db, agentTool, agentTool.teamId, projectIds),
    // The feed has no project column of its own; it reaches one through its issue.
    // Reduced to the latest per project below, because aggregating in SQL would
    // return the max as a driver-formatted string, not a Date.
    db
      .select({ projectId: issue.projectId, createdAt: issueActivity.createdAt })
      .from(issueActivity)
      .innerJoin(issue, eq(issue.id, issueActivity.issueId))
      .where(inArray(issue.projectId, projectIds)),
  ]);

  const lastActivity = new Map<number, Date>();
  for (const r of activityRows) {
    const current = lastActivity.get(r.projectId);
    if (!current || r.createdAt > current) lastActivity.set(r.projectId, r.createdAt);
  }

  return (id: number): ProjectFacts => {
    const activeAt = lastActivity.get(id);
    return {
      memberCount: countAt(members, id),
      issueCount: countAt(issues, id),
      archivedIssueCount: countAt(archivedIssues, id),
      initiativeCount: countAt(initiatives, id),
      dashboardCount: countAt(dashboards, id),
      viewCount: countAt(views, id),
      agentCount: countAt(agents, id),
      skillCount: countAt(skills, id),
      toolCount: countAt(tools, id),
      lastActivityAt: activeAt ? iso(activeAt) : null,
    };
  };
}

type ProjectRow = typeof project.$inferSelect;

function toProjectRow(r: ProjectRow, facts: ProjectFacts): InstanceProjectRow {
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    description: r.description,
    mcpEnabled: r.mcpEnabled,
    createdAt: iso(r.createdAt),
    ...facts,
  };
}

// One page of projects, newest first. `search` matches the key or the name and runs
// in SQL, so the page window and the total count agree.
export async function listInstanceProjects(
  db: Db,
  options: {
    search?: string;
    limit: number;
    offset: number;
  },
): Promise<InstanceProjectPage> {
  const term = options.search?.trim();
  const where = term
    ? or(like(project.key, `%${term}%`), like(project.name, `%${term}%`))
    : undefined;

  const [rows, totals] = await Promise.all([
    db
      .select()
      .from(project)
      .where(where)
      .orderBy(desc(project.createdAt))
      .limit(options.limit)
      .offset(options.offset),
    db
      .select({ count: sql<number>`count(*)` })
      .from(project)
      .where(where),
  ]);

  const facts = await loadProjectFacts(
    db,
    rows.map((r) => r.id),
  );
  const items = rows.map((r) => toProjectRow(r, facts(r.id)));
  return { items, total: totals[0]?.count ?? 0 };
}

// One project with its members and the access each membership resolves to. Returns
// null for an unknown id.
export async function getInstanceProject(
  db: Db,
  projectId: number,
): Promise<InstanceProjectDetail | null> {
  const rows = await db.select().from(project).where(eq(project.id, projectId));
  const row = rows[0];
  if (!row) return null;

  const [facts, memberships, contexts] = await Promise.all([
    loadProjectFacts(db, [row.id]),
    listAllMembers(db, projectId),
    listMemberContexts(db, projectId),
  ]);

  const members: InstanceProjectMember[] = memberships.flatMap((m) => {
    const context = contexts.get(m.userId);
    if (!context) return [];
    return [
      {
        userId: m.userId,
        name: m.name,
        email: m.email,
        username: m.username,
        image: m.image,
        isAgent: m.isAgent,
        role: m.role,
        roleId: m.roleId,
        roleName: m.roleName,
        permissions: context.permissions,
        description: m.description,
        timezone: m.timezone,
        joinedAt: m.createdAt,
      },
    ];
  });
  members.sort((a, b) => a.name.localeCompare(b.name));

  return { ...toProjectRow(row, facts(row.id)), members };
}

// ── Team directory ───────────────────────────────────────────────────────────

// What a team holds, counted across the tables it owns and the projects it owns.
// Read for the list and the detail alike, so a row in the directory already carries
// everything.
export interface InstanceTeamCounts {
  memberCount: number;
  projectCount: number;
  issueCount: number;
  agentCount: number;
  skillCount: number;
  toolCount: number;
  roleCount: number;
}

export interface InstanceTeamRow extends InstanceTeamCounts {
  id: number;
  name: string;
  mcpEnabled: boolean;
  createdAt: string;
}

export interface InstanceTeamProject {
  id: number;
  key: string;
  name: string;
  mcpEnabled: boolean;
  memberCount: number;
  issueCount: number;
  createdAt: string;
}

// One member of the team. The role is the fixed team rank, not a project role, and
// 'agent' is the bot user of an ai_agent.
export interface InstanceTeamMember {
  userId: string;
  name: string;
  email: string;
  image: string | null;
  isAgent: boolean;
  role: TeamStanding;
  joinedAt: string;
}

export interface InstanceTeamPage {
  items: InstanceTeamRow[];
  // How many teams match the search, ignoring the page window.
  total: number;
}

export interface InstanceTeamProjectPage {
  items: InstanceTeamProject[];
  total: number;
}

export interface InstanceTeamMemberPage {
  items: InstanceTeamMember[];
  total: number;
}

const EMPTY_TEAM_COUNTS: InstanceTeamCounts = {
  memberCount: 0,
  projectCount: 0,
  issueCount: 0,
  agentCount: 0,
  skillCount: 0,
  toolCount: 0,
  roleCount: 0,
};

// The counts for the given teams, each in one grouped query and joined in memory,
// so the team query stays a plain select.
async function loadTeamCounts(
  db: Db,
  teamIds: number[],
): Promise<(id: number) => InstanceTeamCounts> {
  if (teamIds.length === 0) return () => EMPTY_TEAM_COUNTS;

  const [members, projects, issues, agents, skills, tools, roles] = await Promise.all([
    countByOwner(db, teamMember, teamMember.teamId, teamIds),
    countByOwner(db, project, project.teamId, teamIds),
    // Issues have no team column; they reach one through their project.
    db
      .select({ teamId: project.teamId, count: sql<number>`count(*)` })
      .from(issue)
      .innerJoin(project, eq(project.id, issue.projectId))
      .where(and(inArray(project.teamId, teamIds), isNull(issue.archivedAt)))
      .groupBy(project.teamId)
      .then((rows) => new Map(rows.map((r) => [r.teamId, r.count]))),
    countByOwner(db, aiAgent, aiAgent.teamId, teamIds),
    countByOwner(db, agentSkill, agentSkill.teamId, teamIds),
    countByOwner(db, agentTool, agentTool.teamId, teamIds),
    countByOwner(db, teamRole, teamRole.teamId, teamIds),
  ]);

  return (id) => ({
    memberCount: countAt(members, id),
    projectCount: countAt(projects, id),
    issueCount: countAt(issues, id),
    agentCount: countAt(agents, id),
    skillCount: countAt(skills, id),
    toolCount: countAt(tools, id),
    roleCount: countAt(roles, id),
  });
}

type TeamRow = typeof team.$inferSelect;

function toTeamRow(r: TeamRow, counts: InstanceTeamCounts): InstanceTeamRow {
  return {
    id: r.id,
    name: r.name,
    mcpEnabled: r.mcpEnabled,
    createdAt: iso(r.createdAt),
    ...counts,
  };
}

// One page of teams, newest first. `search` matches the name and runs in SQL, so the
// page window and the total count agree.
export async function listInstanceTeams(
  db: Db,
  options: {
    search?: string;
    limit: number;
    offset: number;
  },
): Promise<InstanceTeamPage> {
  const term = options.search?.trim();
  const where = term ? like(team.name, `%${term}%`) : undefined;

  const [rows, totals] = await Promise.all([
    db
      .select()
      .from(team)
      .where(where)
      .orderBy(desc(team.createdAt))
      .limit(options.limit)
      .offset(options.offset),
    db
      .select({ count: sql<number>`count(*)` })
      .from(team)
      .where(where),
  ]);

  const counts = await loadTeamCounts(
    db,
    rows.map((r) => r.id),
  );
  return { items: rows.map((r) => toTeamRow(r, counts(r.id))), total: totals[0]?.count ?? 0 };
}

// One team with what it holds. Its projects and its members are their own paged
// routes, so a large team is never loaded whole. Returns null for an unknown id.
export async function getInstanceTeam(db: Db, teamId: number): Promise<InstanceTeamRow | null> {
  const rows = await db.select().from(team).where(eq(team.id, teamId));
  const row = rows[0];
  if (!row) return null;

  const counts = await loadTeamCounts(db, [row.id]);
  return toTeamRow(row, counts(row.id));
}

// One page of the projects a team owns, by key. `search` matches the key or the name.
export async function listInstanceTeamProjects(
  db: Db,
  teamId: number,
  options: { search?: string; limit: number; offset: number },
): Promise<InstanceTeamProjectPage> {
  const term = options.search?.trim();
  const where = and(
    eq(project.teamId, teamId),
    term ? or(like(project.key, `%${term}%`), like(project.name, `%${term}%`)) : undefined,
  );

  const [rows, totals] = await Promise.all([
    db
      .select({
        id: project.id,
        key: project.key,
        name: project.name,
        mcpEnabled: project.mcpEnabled,
        createdAt: project.createdAt,
        memberCount: sql<number>`count(distinct ${projectMember.userId})`,
        issueCount: sql<number>`count(distinct ${issue.id})`,
      })
      .from(project)
      .leftJoin(projectMember, eq(projectMember.projectId, project.id))
      .leftJoin(issue, and(eq(issue.projectId, project.id), isNull(issue.archivedAt)))
      .where(where)
      .groupBy(project.id)
      .orderBy(project.key)
      .limit(options.limit)
      .offset(options.offset),
    db
      .select({ count: sql<number>`count(*)` })
      .from(project)
      .where(where),
  ]);

  return {
    items: rows.map((p) => ({ ...p, createdAt: iso(p.createdAt) })),
    total: totals[0]?.count ?? 0,
  };
}

// One page of the team's members, people and agents alike, by name. `search` matches
// the name or the address.
export async function listInstanceTeamMembers(
  db: Db,
  teamId: number,
  options: { search?: string; limit: number; offset: number },
): Promise<InstanceTeamMemberPage> {
  const term = options.search?.trim();
  const where = and(
    eq(teamMember.teamId, teamId),
    term ? or(like(user.name, `%${term}%`), like(user.email, `%${term}%`)) : undefined,
  );

  const [rows, totals] = await Promise.all([
    db
      .select({
        userId: user.id,
        name: user.name,
        email: user.email,
        image: user.image,
        agentId: aiAgent.id,
        role: teamMember.role,
        joinedAt: teamMember.createdAt,
      })
      .from(teamMember)
      .innerJoin(user, eq(user.id, teamMember.userId))
      .leftJoin(aiAgent, eq(aiAgent.userId, teamMember.userId))
      .where(where)
      .orderBy(user.name)
      .limit(options.limit)
      .offset(options.offset),
    db
      .select({ count: sql<number>`count(*)` })
      .from(teamMember)
      .innerJoin(user, eq(user.id, teamMember.userId))
      .where(where),
  ]);

  return {
    items: rows.map((m) => ({
      userId: m.userId,
      name: m.name,
      email: m.email,
      image: m.image,
      isAgent: m.agentId !== null,
      role: m.role as TeamStanding,
      joinedAt: iso(m.joinedAt),
    })),
    total: totals[0]?.count ?? 0,
  };
}

// Marks the account's email address as confirmed and returns the updated user.
// Returns null for an unknown id.
export async function verifyInstanceUserEmail(
  db: Db,
  userId: string,
): Promise<InstanceUserDetail | null> {
  const updated = await db
    .update(user)
    .set({ emailVerified: true })
    .where(eq(user.id, userId))
    .returning({ id: user.id });
  if (updated.length === 0) return null;
  return getInstanceUser(db, userId);
}
