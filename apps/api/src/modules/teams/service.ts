import {
  agentSkill,
  agentTool,
  aiAgent,
  teamWorkspaceId,
  integrationCredential,
  issue,
  issueActivity,
  project,
  projectColumn,
  projectMember,
  team,
  teamInvite,
  teamMember,
  teamRole,
  user,
  workspace,
  workspaceManager,
  abortBatchWhen,
  batchAll,
  isGuardViolation,
  isUniqueViolation,
  type BatchStatement,
  type Db,
} from '@repo/db';
import { and, desc, eq, like, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { HttpError, iso } from '#shared/lib';
import { isReservedSlug, projectRefSql, teamRef } from './ref';
import { getLimits } from '#shared/limits';
import { defaultMemberPermissions, fullPermissions, type Permissions } from '#shared/permissions';
import {
  getMemberContext,
  getMembership,
  getMembershipSource,
  getTeamPermissions,
  listMembersPage,
  matchesFilters,
  type MemberFilters,
  type MemberRole,
  type MemberSource,
} from '#modules/members/service';
import { getStats, type StatsDto } from '#modules/analytics/service';
import { teamSkillObjectKeys } from '#modules/agents/skills/service';
import { deleteObjects } from '@repo/storage';
import {
  assertMayCreateTeam,
  projectWorkspaceGrant,
  workspaceGrant,
  workspaceGrants,
  workspaceHoldsWork,
} from '#modules/workspaces/service';
import {
  mergePermissions,
  projectAccess,
  teamAccess,
  type AccessVia,
} from '#shared/workspace-roles';

// The rank a person holds in a team.
export type TeamRole = 'owner' | 'manager' | 'member';

// What a team_member row can say. An agent's bot user belongs to the team and appears
// in its member list, but its standing grants nothing: what it may do is the team role
// on its ai_agent row.
export type TeamStanding = TeamRole | 'agent';

// Owners and managers run the team, so they hold everything it can grant. Everyone
// else — a member, and an agent — holds what their project roles in it grant.
export function runsTeam(standing: TeamStanding | null): boolean {
  return standing === 'owner' || standing === 'manager';
}

export interface TeamRow {
  id: number;
  workspaceId: number;
  name: string;
  slug: string | null;
  // How web URLs name the team: the slug, or the id while it has none.
  ref: string;
  // Whether the team is reachable over MCP at all. Off closes its own resources and
  // every project it owns, whichever projects it covers.
  mcpEnabled: boolean;
  // The caller's standing in the team, not a property of the team itself. An agent
  // reading its own team is 'agent', which runs nothing.
  role: TeamStanding;
  // 'workspace' when the caller is not in the team and reaches it through their role
  // in its workspace. Their source and joinedAt are then the team's defaults.
  via: AccessVia;
  // How the caller's own membership came about. 'scim' is the identity provider's, and
  // is left there rather than here.
  source: MemberSource;
  joinedAt: string;
  projectCount: number;
  memberCount: number;
  // How many of those members are owners: the last one cannot leave.
  ownerCount: number;
  // The roles the team's projects assign from, the integration credentials they run
  // on, the agents that work in them, and the skills and tools those agents use.
  // Counted here so the page shows them beside the section without opening it.
  roleCount: number;
  integrationCount: number;
  agentCount: number;
  skillCount: number;
  toolCount: number;
  createdAt: string;
}

// One member of a team, as the team detail lists them: a person, or the bot user of
// one of the team's agents. An agent carries the id and handle it is addressed by; its
// standing in the team is 'agent', and what it may do is the role each of its project
// memberships carries.
export interface TeamMemberRow {
  userId: string;
  name: string;
  email: string;
  image: string | null;
  role: TeamStanding;
  source: MemberSource;
  agentId: number | null;
  username: string | null;
  joinedAt: string;
}

// A project the team owns. `isMember` is the caller's own access to it: a team
// member sees every project of the team, but only opens the ones they belong to.
export interface TeamProjectRow {
  id: number;
  key: string;
  ref: string;
  name: string;
  description: string;
  // Whether the team's MCP reach covers this project. Only counts while the team's
  // own switch is on.
  mcpEnabled: boolean;
  memberCount: number;
  owners: { userId: string; name: string; image: string | null }[];
  isMember: boolean;
  archivedAt: string | null;
  createdAt: string;
}

// One page of the team's projects, with how many the caller reads in all.
export interface TeamProjectPage {
  items: TeamProjectRow[];
  total: number;
}

// A project as a picker reads it, plus the MCP reach the team's switches set.
export interface TeamProjectOption {
  id: number;
  key: string;
  ref: string;
  name: string;
  mcpEnabled: boolean;
}

// One member of a project the team owns. The access their membership resolves to is
// not carried here: it is the matrix of the role they hold, which the reader already
// has from the team's roles.
export interface TeamProjectMemberRow {
  userId: string;
  name: string;
  email: string;
  // The handle they are mentioned by, @username. An agent's bot user carries the
  // agent's handle.
  username: string | null;
  image: string | null;
  isAgent: boolean;
  role: MemberRole;
  roleId: number | null;
  roleName: string | null;
  // What the member does in the project, and which path their membership came from —
  // both needed by the panel, which edits the membership from there.
  description: string;
  source: MemberSource;
  timezone: string;
  joinedAt: string;
}

// One project of the team, opened: how it is doing, and where the reader stands in
// it. Its members are a page of their own, so a project with many of them is not
// loaded whole.
export interface TeamProjectDetail {
  // The most recent entry in the project's issue feed, or null when nothing has
  // happened in it yet.
  lastActivityAt: string | null;
  stats: StatsDto;
  // The reader's access to this project, or null when they only reach it through the
  // team. What they may do with its members is decided from it.
  viewer: {
    role: MemberRole;
    via: AccessVia;
    source: MemberSource;
    permissions: Permissions;
  } | null;
}

// One page of the team's members, with how many match the search.
export interface TeamMemberPage {
  items: TeamMemberRow[];
  total: number;
}

// One page of a project's members, with how many match the search.
export interface TeamProjectMemberPage {
  items: TeamProjectMemberRow[];
  total: number;
}

export interface TeamDetail extends TeamRow {
  // What the caller may do with the resources the team holds for all its projects.
  // Owners and managers run the team, so they get the full matrix; a member gets the
  // permissions of their project roles in it, merged.
  permissions: Permissions;
  // The people who run the team, owners first. Bounded by the standing they hold, so
  // it comes with the team rather than out of the paged member list.
  leads: TeamLeadRow[];
}

export interface TeamLeadRow {
  userId: string;
  name: string;
  email: string;
  image: string | null;
  role: 'owner' | 'manager';
}

// The caller's teams as DTOs, optionally narrowed to one: the teams they are in and
// the ones their role in a workspace reaches (workspace-roles.ts).
async function loadTeamRows(db: Db, userId: string, teamId?: number): Promise<TeamRow[]> {
  const grants = await workspaceGrants(db, userId);
  const grantedTeams = [...grants.keys()];
  const rows = await db
    .select({
      id: team.id,
      workspaceId: team.workspaceId,
      name: team.name,
      slug: team.slug,
      mcpEnabled: team.mcpEnabled,
      role: teamMember.role,
      source: teamMember.source,
      joinedAt: teamMember.createdAt,
      createdAt: team.createdAt,
    })
    .from(team)
    .leftJoin(teamMember, and(eq(teamMember.teamId, team.id), eq(teamMember.userId, userId)))
    .where(
      and(
        or(
          isNotNull(teamMember.userId),
          grantedTeams.length > 0 ? inArray(team.id, grantedTeams) : undefined,
        ),
        teamId === undefined ? undefined : eq(team.id, teamId),
      ),
    )
    .orderBy(team.id);
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const [
    projectCounts,
    memberCounts,
    roleCounts,
    integrationCounts,
    agentCounts,
    skillCounts,
    toolCounts,
  ] = await Promise.all([
    db
      .select({
        teamId: project.teamId,
        count: sql<number>`count(*)`,
        joined: sql<number>`count(${projectMember.userId})`,
      })
      .from(project)
      .leftJoin(
        projectMember,
        and(eq(projectMember.projectId, project.id), eq(projectMember.userId, userId)),
      )
      .where(inArray(project.teamId, ids))
      .groupBy(project.teamId),
    db
      .select({
        teamId: teamMember.teamId,
        count: sql<number>`count(*)`,
        owners: sql<number>`count(*) filter (where ${teamMember.role} = 'owner')`,
      })
      .from(teamMember)
      .where(inArray(teamMember.teamId, ids))
      .groupBy(teamMember.teamId),
    db
      .select({ teamId: teamRole.teamId, count: sql<number>`count(*)` })
      .from(teamRole)
      .where(inArray(teamRole.teamId, ids))
      .groupBy(teamRole.teamId),
    db
      .select({ teamId: integrationCredential.teamId, count: sql<number>`count(*)` })
      .from(integrationCredential)
      .where(inArray(integrationCredential.teamId, ids))
      .groupBy(integrationCredential.teamId),
    db
      .select({ teamId: aiAgent.teamId, count: sql<number>`count(*)` })
      .from(aiAgent)
      .where(inArray(aiAgent.teamId, ids))
      .groupBy(aiAgent.teamId),
    db
      .select({ teamId: agentSkill.teamId, count: sql<number>`count(*)` })
      .from(agentSkill)
      .where(inArray(agentSkill.teamId, ids))
      .groupBy(agentSkill.teamId),
    db
      .select({ teamId: agentTool.teamId, count: sql<number>`count(*)` })
      .from(agentTool)
      .where(inArray(agentTool.teamId, ids))
      .groupBy(agentTool.teamId),
  ]);
  const projects = new Map(projectCounts.map((r) => [r.teamId, r]));
  const members = new Map(memberCounts.map((r) => [r.teamId, r]));
  const roles = new Map(roleCounts.map((r) => [r.teamId, r.count]));
  const integrations = new Map(integrationCounts.map((r) => [r.teamId, r.count]));
  const agents = new Map(agentCounts.map((r) => [r.teamId, r.count]));
  const skills = new Map(skillCounts.map((r) => [r.teamId, r.count]));
  const tools = new Map(toolCounts.map((r) => [r.teamId, r.count]));

  return rows.map((row) => {
    const grant = grants.get(row.id) ?? null;
    const access = teamAccess(row.role as TeamStanding | null, grant)!;
    const standing = access.role;
    const projectCount = projects.get(row.id);
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      name: row.name,
      slug: row.slug,
      ref: teamRef(row),
      mcpEnabled: row.mcpEnabled,
      role: standing,
      via: access.via,
      source: (row.source as MemberSource | null) ?? 'invite',
      joinedAt: iso(row.joinedAt ?? row.createdAt),
      projectCount: (runsTeam(standing) || grant ? projectCount?.count : projectCount?.joined) ?? 0,
      memberCount: members.get(row.id)?.count ?? 0,
      ownerCount: members.get(row.id)?.owners ?? 0,
      roleCount: roles.get(row.id) ?? 0,
      integrationCount: integrations.get(row.id) ?? 0,
      agentCount: agents.get(row.id) ?? 0,
      skillCount: skills.get(row.id) ?? 0,
      toolCount: tools.get(row.id) ?? 0,
      createdAt: iso(row.createdAt),
    };
  });
}

// The teams the user belongs to. mcpOnly drops the ones with MCP switched off, so an
// MCP caller only sees the teams it can act in.
export async function listTeams(
  db: Db,
  userId: string,
  opts: { mcpOnly?: boolean } = {},
): Promise<TeamRow[]> {
  const rows = await loadTeamRows(db, userId);
  return opts.mcpOnly ? rows.filter((row) => row.mcpEnabled) : rows;
}

// The team's MCP switch alone, for the guard that runs on every team-scoped MCP call.
export async function teamMcpEnabled(db: Db, teamId: number): Promise<boolean> {
  const [row] = await db
    .select({ mcpEnabled: team.mcpEnabled })
    .from(team)
    .where(eq(team.id, teamId));
  return row?.mcpEnabled ?? false;
}

export async function getTeamProjectDefaults(
  db: Db,
  teamId: number,
): Promise<{ defaultAgentIds: number[] }> {
  const [row] = await db
    .select({ defaultAgentIds: team.defaultAgentIds })
    .from(team)
    .where(eq(team.id, teamId));
  const ids = row?.defaultAgentIds ?? [];
  if (!ids.length) return { defaultAgentIds: [] };
  const agents = await db
    .select({ id: aiAgent.id })
    .from(aiAgent)
    .where(and(eq(aiAgent.teamId, teamId), inArray(aiAgent.id, ids)));
  const available = new Set(agents.map((agent) => agent.id));
  return { defaultAgentIds: ids.filter((id) => available.has(id)) };
}

export async function setTeamProjectDefaults(
  db: Db,
  teamId: number,
  defaultAgentIds: number[],
): Promise<{ defaultAgentIds: number[] }> {
  const ids = [...new Set(defaultAgentIds)];
  if (ids.length) {
    const agents = await db
      .select({ id: aiAgent.id })
      .from(aiAgent)
      .where(and(eq(aiAgent.teamId, teamId), inArray(aiAgent.id, ids)));
    if (agents.length !== ids.length)
      throw new HttpError(400, 'Every default agent must belong to the team');
  }
  await db.update(team).set({ defaultAgentIds: ids }).where(eq(team.id, teamId));
  return { defaultAgentIds: ids };
}

// The team's MCP settings: the switch, and which of its projects it covers. Both are
// written from the team's MCP section — a project does not open itself.
export interface TeamMcpSettings {
  enabled: boolean;
  projects: { projectId: number; enabled: boolean }[];
}

async function getTeamMcp(db: Db, teamId: number): Promise<TeamMcpSettings> {
  const [rows, projects] = await Promise.all([
    db.select({ mcpEnabled: team.mcpEnabled }).from(team).where(eq(team.id, teamId)),
    db
      .select({ projectId: project.id, enabled: project.mcpEnabled })
      .from(project)
      .where(eq(project.teamId, teamId))
      .orderBy(project.key),
  ]);
  return { enabled: rows[0]?.mcpEnabled ?? false, projects };
}

// Applies a patch to the team's MCP settings and returns the result. A project of
// another team is ignored rather than written, so an id from elsewhere changes
// nothing.
export async function setTeamMcp(
  db: Db,
  teamId: number,
  patch: { enabled?: boolean; projects?: { projectId: number; enabled: boolean }[] },
): Promise<TeamMcpSettings> {
  if (patch.enabled !== undefined) {
    await db.update(team).set({ mcpEnabled: patch.enabled }).where(eq(team.id, teamId));
  }
  // Written as one statement per value rather than one per project, so a whole set
  // of checkboxes costs two.
  for (const enabled of [true, false]) {
    const ids = (patch.projects ?? []).filter((p) => p.enabled === enabled).map((p) => p.projectId);
    if (ids.length === 0) continue;
    await db
      .update(project)
      .set({ mcpEnabled: enabled })
      .where(and(eq(project.teamId, teamId), inArray(project.id, ids)));
  }
  return getTeamMcp(db, teamId);
}

export async function getTeamMembership(
  db: Db,
  teamId: number,
  userId: string,
): Promise<TeamStanding | null> {
  const rows = await db
    .select({ role: teamMember.role })
    .from(teamMember)
    .where(and(eq(teamMember.teamId, teamId), eq(teamMember.userId, userId)));
  return rows[0] ? (rows[0].role as TeamStanding) : null;
}

// The team itself: the row the list carries, with what the caller may do with the
// resources it holds. Its members and its projects are read separately, one request
// per section of the page. Returns null when the caller is not a member of it.
export async function getTeam(db: Db, teamId: number, userId: string): Promise<TeamDetail | null> {
  const [row] = await loadTeamRows(db, userId, teamId);
  if (!row) return null;

  const [permissions, leads] = await Promise.all([
    runsTeam(row.role)
      ? fullPermissions()
      : Promise.all([
          getTeamPermissions(db, teamId, userId),
          workspaceGrant(db, teamId, userId),
        ]).then(([own, grant]) => mergePermissions(own, grant === 'owner' ? null : grant)),
    listTeamLeads(db, teamId),
  ]);
  return { ...row, permissions, leads };
}

// The owners and the managers of the team, owners first, then by name. Agents are left
// out: an agent's standing grants nothing, so it runs no team.
async function listTeamLeads(db: Db, teamId: number): Promise<TeamLeadRow[]> {
  const rows = await db
    .select({
      userId: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
      role: teamMember.role,
    })
    .from(teamMember)
    .innerJoin(user, eq(user.id, teamMember.userId))
    .leftJoin(aiAgent, eq(aiAgent.userId, teamMember.userId))
    .where(
      and(
        eq(teamMember.teamId, teamId),
        inArray(teamMember.role, ['owner', 'manager']),
        isNull(aiAgent.id),
      ),
    )
    .orderBy(desc(eq(teamMember.role, 'owner')), user.name);
  return rows.map((r) => ({ ...r, role: r.role as 'owner' | 'manager' }));
}

// One page of the team's members, people and agents alike, by name. The search and the
// window run in the database, so a team with many members is never loaded whole.
export async function listTeamMembers(
  db: Db,
  teamId: number,
  options: MemberFilters & { limit: number; offset: number },
): Promise<TeamMemberPage> {
  const where = and(eq(teamMember.teamId, teamId), matchesFilters(options));
  const [rows, counted] = await Promise.all([
    db
      .select({
        userId: user.id,
        name: user.name,
        email: user.email,
        image: user.image,
        role: teamMember.role,
        source: teamMember.source,
        agentId: aiAgent.id,
        username: aiAgent.username,
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
      .leftJoin(aiAgent, eq(aiAgent.userId, teamMember.userId))
      .where(where),
  ]);

  return {
    items: rows.map((m) => ({
      userId: m.userId,
      name: m.name,
      email: m.email,
      image: m.image,
      role: m.role as TeamStanding,
      source: m.source as MemberSource,
      agentId: m.agentId,
      username: m.username,
      joinedAt: iso(m.joinedAt),
    })),
    total: counted[0]?.count ?? 0,
  };
}

// The projects of the team a caller reads: owners, managers and anyone whose workspace
// role reaches the team see every one of them, everyone else only the ones they joined.
// The search matches the key or the name.
async function visibleTeamProjects(
  db: Db,
  teamId: number,
  userId: string,
  standing: TeamStanding,
  search?: string,
) {
  const seesAll = runsTeam(standing) || (await workspaceGrant(db, teamId, userId)) !== null;
  const term = search?.trim();
  return and(
    eq(project.teamId, teamId),
    seesAll
      ? undefined
      : sql`exists (select 1 from ${projectMember} where ${projectMember.projectId} = ${project.id}
      and ${projectMember.userId} = ${userId})`,
    term ? or(like(project.key, `%${term}%`), like(project.name, `%${term}%`)) : undefined,
  );
}

// One page of the projects the team owns, with the caller's own access to each. The
// window runs in the database, so a team with many projects is never loaded whole;
// the owners are read for the page, not for every project.
export async function listTeamProjects(
  db: Db,
  teamId: number,
  userId: string,
  standing: TeamStanding,
  options: { search?: string; limit: number; offset: number },
): Promise<TeamProjectPage> {
  const where = await visibleTeamProjects(db, teamId, userId, standing, options.search);
  const [projects, counted] = await Promise.all([
    db
      .select({
        id: project.id,
        key: project.key,
        ref: projectRefSql,
        name: project.name,
        description: project.description,
        mcpEnabled: project.mcpEnabled,
        archivedAt: project.archivedAt,
        createdAt: project.createdAt,
        memberCount: sql<number>`count(${projectMember.userId})`,
        isMember: sql<boolean>`coalesce(max(${projectMember.userId} = ${userId}), 0)`.mapWith(
          Boolean,
        ),
      })
      .from(project)
      .innerJoin(team, eq(team.id, project.teamId))
      .leftJoin(projectMember, eq(projectMember.projectId, project.id))
      .where(where)
      .groupBy(project.id, team.id)
      .orderBy(project.key)
      .limit(options.limit)
      .offset(options.offset),
    db
      .select({ count: sql<number>`count(*)` })
      .from(project)
      .where(where),
  ]);

  const projectOwners = projects.length
    ? await db
        .select({
          projectId: projectMember.projectId,
          userId: user.id,
          name: user.name,
          image: user.image,
        })
        .from(projectMember)
        .innerJoin(user, eq(user.id, projectMember.userId))
        .where(
          and(
            inArray(
              projectMember.projectId,
              projects.map((p) => p.id),
            ),
            eq(projectMember.role, 'owner'),
          ),
        )
        .orderBy(user.name)
    : [];

  const ownersByProject = new Map<number, TeamProjectRow['owners']>();
  for (const o of projectOwners) {
    const owners = ownersByProject.get(o.projectId) ?? [];
    owners.push({ userId: o.userId, name: o.name, image: o.image });
    ownersByProject.set(o.projectId, owners);
  }

  return {
    items: projects.map((p) => ({
      id: p.id,
      key: p.key,
      ref: p.ref,
      name: p.name,
      description: p.description,
      mcpEnabled: p.mcpEnabled,
      memberCount: p.memberCount,
      owners: ownersByProject.get(p.id) ?? [],
      isMember: p.isMember ?? false,
      archivedAt: p.archivedAt ? iso(p.archivedAt) : null,
      createdAt: iso(p.createdAt),
    })),
    total: counted[0]?.count ?? 0,
  };
}

// Every project the caller reads, as id, key, name and MCP reach: the picker on an
// agent and the team's MCP switches, which need them all rather than a page.
export async function listTeamProjectOptions(
  db: Db,
  teamId: number,
  userId: string,
  standing: TeamStanding,
): Promise<TeamProjectOption[]> {
  return db
    .select({
      id: project.id,
      key: project.key,
      ref: projectRefSql,
      name: project.name,
      mcpEnabled: project.mcpEnabled,
    })
    .from(project)
    .innerJoin(team, eq(team.id, project.teamId))
    .where(await visibleTeamProjects(db, teamId, userId, standing))
    .orderBy(project.key);
}

// When the project's issue feed last moved. Read as the newest row rather than a
// max(), which the driver returns as a formatted string instead of a Date.
async function lastActivityAt(db: Db, projectId: number): Promise<string | null> {
  const rows = await db
    .select({ createdAt: issueActivity.createdAt })
    .from(issueActivity)
    .innerJoin(issue, eq(issue.id, issueActivity.issueId))
    .where(eq(issue.projectId, projectId))
    .orderBy(desc(issueActivity.createdAt))
    .limit(1);
  return rows[0] ? iso(rows[0].createdAt) : null;
}

// Whether the project is one the team owns. The team-scoped project routes check it
// so a project of another team answers 404 rather than being acted on.
export async function teamOwnsProject(db: Db, teamId: number, projectId: number): Promise<boolean> {
  const rows = await db
    .select({ id: project.id })
    .from(project)
    .where(and(eq(project.id, projectId), eq(project.teamId, teamId)));
  return rows.length > 0;
}

// One project the team owns, with its issue stats and the reader's standing in it.
// Returns null when the project is not owned by the team, and when the caller
// neither runs the team nor belongs to the project, so the route answers 404 in both
// cases.
export async function getTeamProject(
  db: Db,
  teamId: number,
  projectId: number,
  userId: string,
  standing: TeamStanding,
): Promise<TeamProjectDetail | null> {
  if (!(await teamOwnsProject(db, teamId, projectId))) return null;

  const viewer = projectAccess(
    await getMemberContext(db, projectId, userId),
    await projectWorkspaceGrant(db, projectId, userId),
  );
  if (!runsTeam(standing) && !viewer) return null;

  const [activity, stats, source] = await Promise.all([
    lastActivityAt(db, projectId),
    getStats(db, projectId),
    getMembershipSource(db, projectId, userId),
  ]);

  return {
    lastActivityAt: activity,
    stats,
    viewer: viewer
      ? {
          role: viewer.role,
          via: viewer.via,
          source: source ?? 'invite',
          permissions: viewer.permissions,
        }
      : null,
  };
}

// One page of a project's members, owners first and the rest newest membership
// first: who runs the project is the first thing the list has to answer. Returns
// null under the same two conditions getTeamProject does.
export async function listTeamProjectMembers(
  db: Db,
  teamId: number,
  projectId: number,
  userId: string,
  standing: TeamStanding,
  options: MemberFilters & { limit: number; offset: number },
): Promise<TeamProjectMemberPage | null> {
  if (!(await teamOwnsProject(db, teamId, projectId))) return null;
  if (
    !runsTeam(standing) &&
    !(await getMembership(db, projectId, userId)) &&
    !(await projectWorkspaceGrant(db, projectId, userId))
  ) {
    return null;
  }

  const { items, total } = await listMembersPage(db, projectId, { ...options, order: 'owners' });

  return {
    items: items.map((m) => ({
      db,
      userId: m.userId,
      name: m.name,
      email: m.email,
      username: m.username,
      image: m.image,
      isAgent: m.isAgent,
      role: m.role,
      roleId: m.roleId,
      roleName: m.roleName,
      description: m.description,
      source: m.source,
      timezone: m.timezone,
      joinedAt: m.createdAt,
    })),
    total,
  };
}

// Writes a team owned by one account, with the default role its projects assign, in one
// D1 batch (all three rows land or none). The batch cannot name the id of the team it
// inserts, so the owner and role rows take the highest team id, the one just written.
// `guards` run first and abort the batch.
export async function insertOwnedTeam(
  db: Db,
  workspaceId: number,
  name: string,
  ownerId: string,
  slug: string | null = null,
  guards: BatchStatement[] = [],
) {
  const newTeamId = sql<number>`(select max(${team.id}) from ${team})`;
  const results = (await batchAll(db, [
    ...guards,
    db.insert(team).values({ workspaceId, name, slug }).returning(),
    db.insert(teamMember).values({ teamId: newTeamId, userId: ownerId, role: 'owner' }).returning(),
    db.insert(teamRole).values({
      teamId: newTeamId,
      name: 'Member',
      isDefault: true,
      permissions: defaultMemberPermissions(),
    }),
  ])) as unknown[][];
  const at = guards.length;
  return {
    team: results[at]![0] as typeof team.$inferSelect,
    membership: results[at + 1]![0] as typeof teamMember.$inferSelect,
  };
}

// The people across the workspace's teams, which is what a seat ceiling counts. An
// agent's bot user sits in a member list but takes no seat.
export async function listSeatHolderIds(db: Db, workspaceId: number): Promise<string[]> {
  const rows = await db
    .selectDistinct({ userId: teamMember.userId })
    .from(teamMember)
    .innerJoin(team, eq(team.id, teamMember.teamId))
    .where(and(eq(team.workspaceId, workspaceId), sql`${teamMember.role} <> 'agent'`));
  return rows.map((row) => row.userId);
}

// Refuses to add this person to the team when that takes a seat the workspace does not
// have. Somebody already in another team of the workspace holds a seat.
export async function assertSeatFree(db: Db, teamId: number, userId: string): Promise<void> {
  const workspaceId = await teamWorkspaceId(teamId, db);
  const { maxSeats } = await getLimits(workspaceId);
  if (maxSeats === 0) return;
  const holders = await listSeatHolderIds(db, workspaceId);
  if (!holders.includes(userId) && holders.length >= maxSeats) {
    throw new HttpError(409, `The workspace has no free seats out of ${maxSeats}`);
  }
}

export async function createTeam(
  db: Db,
  name: string,
  slug: string,
  ownerId: string,
  workspaceId: number,
): Promise<TeamRow> {
  await assertMayCreateTeam(db, workspaceId, ownerId);
  const { maxTeams } = await getLimits(workspaceId);
  if (maxTeams > 0 && (await db.$count(team, eq(team.workspaceId, workspaceId))) >= maxTeams) {
    throw new HttpError(409, `The workspace already has ${maxTeams} teams`);
  }
  assertSlugAllowed(slug);
  // The ceiling is checked again by the batch itself: two requests racing for the last
  // free place cannot both pass.
  const guards =
    maxTeams > 0
      ? [
          abortBatchWhen(
            db,
            sql`(select count(*) from ${team} where ${team.workspaceId} = ${workspaceId}) >= ${maxTeams}`,
          ),
        ]
      : [];
  let created: Awaited<ReturnType<typeof insertOwnedTeam>>;
  try {
    created = await withSlugConflict(() =>
      insertOwnedTeam(db, workspaceId, name, ownerId, slug, guards),
    );
  } catch (err) {
    if (isGuardViolation(err)) {
      throw new HttpError(409, `The workspace already has ${maxTeams} teams`);
    }
    throw err;
  }
  const { team: row, membership } = created;
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    slug: row.slug,
    ref: teamRef(row),
    mcpEnabled: row.mcpEnabled,
    role: 'owner',
    via: 'member',
    source: 'invite',
    joinedAt: iso(membership.createdAt),
    projectCount: 0,
    memberCount: 1,
    ownerCount: 1,
    roleCount: 1,
    integrationCount: 0,
    agentCount: 0,
    skillCount: 0,
    toolCount: 0,
    createdAt: iso(row.createdAt),
  };
}

function assertSlugAllowed(slug: string | undefined): void {
  if (slug && isReservedSlug(slug)) {
    throw new HttpError(400, `'${slug}' is reserved and cannot be a team slug`);
  }
}

// slug is the only unique column of team, so a unique violation names it.
async function withSlugConflict<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, 'Another team already uses this slug');
    throw err;
  }
}

export async function updateTeam(
  db: Db,
  teamId: number,
  changes: { name?: string; slug?: string },
  userId: string,
): Promise<TeamRow> {
  assertSlugAllowed(changes.slug);
  if (changes.slug === undefined) {
    const [current] = await db.select({ slug: team.slug }).from(team).where(eq(team.id, teamId));
    if (current?.slug === null) {
      throw new HttpError(400, "Set the team's slug before changing it");
    }
  }
  // Drizzle skips undefined values, and throws when none are left to set.
  if (changes.name !== undefined || changes.slug !== undefined) {
    await withSlugConflict(() => db.update(team).set(changes).where(eq(team.id, teamId)));
  }
  const [row] = await loadTeamRows(db, userId, teamId);
  return row;
}

// A team holding a project or an AI agent is kept: those are people's work, and the
// delete cascades to everything the team owns.
export async function deleteTeam(db: Db, teamId: number): Promise<void> {
  const skillKeys = await teamSkillObjectKeys(db, teamId);
  const deleted = await db
    .delete(team)
    .where(
      and(
        eq(team.id, teamId),
        sql`not exists (select 1 from ${project} where ${project.teamId} = ${team.id})`,
        sql`not exists (select 1 from ${aiAgent} where ${aiAgent.teamId} = ${team.id})`,
      ),
    )
    .returning({ id: team.id });
  if (deleted.length === 0) {
    throw new HttpError(409, 'Delete the projects and AI agents of the team first');
  }
  await deleteObjects(skillKeys);
}

// Everything below ends or changes a membership without a lock: D1 has no interactive
// transaction, so each rule that was "read, check, write" under a team row lock is now a
// guard statement placed first in the one batch that writes (abortBatchWhen), evaluated
// by D1 at write time, or a predicate inside the single UPDATE. The reads that precede
// them only produce the precise error; after a guard trips, the state is read again to
// answer with the right 409.

async function teamStandingOf(
  db: Db,
  teamId: number,
  userId: string,
): Promise<TeamStanding | null> {
  const [row] = await db
    .select({ role: teamMember.role })
    .from(teamMember)
    .where(and(eq(teamMember.teamId, teamId), eq(teamMember.userId, userId)));
  return row ? (row.role as TeamStanding) : null;
}

// The actor's standing raised to their workspace grant (getTeamAccess).
async function actorStanding(db: Db, teamId: number, userId: string): Promise<TeamStanding | null> {
  const standing = await teamStandingOf(db, teamId, userId);
  return teamAccess(standing, await workspaceGrant(db, teamId, userId))?.role ?? null;
}

// SQL: how many owner rows the team has. The last owner row is kept even against the
// workspace owner, who acts as an owner without one.
const ownerCount = (teamId: number): SQL =>
  sql`(select count(*) from ${teamMember} o where o.team_id = ${teamId} and o.role = 'owner')`;

// SQL tail ("from ... where ...") selecting the projects of the team the person owns
// alone. Ending their membership takes their project memberships with it, and the
// project's own member routes refuse such a removal for the same reason.
const soleOwnedProjectsFrom = (teamId: number, userId: string): SQL =>
  sql`from ${projectMember} join ${project} on ${project.id} = ${projectMember.projectId}
    where ${project.teamId} = ${teamId} and ${projectMember.userId} = ${userId}
    and ${projectMember.role} = 'owner'
    and (select count(*) from ${projectMember} o where o.project_id = ${project.id} and o.role = 'owner') = 1`;

// Changes what a member ranks as in the team. An agent's standing comes from its
// agent settings, and nobody sets their own rank. Only an owner grants the owner rank
// or changes what another owner holds. One UPDATE: it only matches while the member
// still holds the rank read, and an owner only steps down while another owner remains.
export async function setTeamMemberRole(
  db: Db,
  teamId: number,
  actor: { userId: string; role: TeamStanding },
  userId: string,
  role: TeamRole,
): Promise<void> {
  const actorRole = await actorStanding(db, teamId, actor.userId);
  if (!runsTeam(actorRole))
    throw new HttpError(403, 'Only a team owner or manager can change ranks');
  if (userId === actor.userId) throw new HttpError(409, 'You cannot change your own rank');
  const current = await teamStandingOf(db, teamId, userId);
  if (!current) throw new HttpError(404, 'Member not found');
  if (current === 'agent')
    throw new HttpError(409, "An agent's rank comes from its agent settings");
  if (actorRole !== 'owner' && (role === 'owner' || current === 'owner')) {
    throw new HttpError(403, 'Only a team owner can grant or take the owner rank');
  }
  const stepsDown = current === 'owner' && role !== 'owner';
  const updated = await db
    .update(teamMember)
    .set({ role })
    .where(
      and(
        eq(teamMember.teamId, teamId),
        eq(teamMember.userId, userId),
        eq(teamMember.role, current),
        stepsDown ? sql`${ownerCount(teamId)} > 1` : undefined,
      ),
    )
    .returning({ userId: teamMember.userId });
  if (updated.length > 0) return;
  // Somebody else got there first: say what is true now.
  const now = await teamStandingOf(db, teamId, userId);
  if (!now) throw new HttpError(404, 'Member not found');
  if (stepsDown && now === 'owner') {
    throw new HttpError(409, 'A team must keep at least one owner');
  }
  throw new HttpError(409, 'This member was changed meanwhile, try again');
}

type MembershipEnd = { lastOwner: string; subject: 'You' | 'They' };

// Refuses to end a membership that would leave the team without an owner or a project of
// it without one, or that the SCIM group reconciliation owns (the next sync would put it
// back, and dropping it here would take the project memberships that same sync granted
// with it; only the plain member rows it writes — a rank raised by hand is the team's).
async function assertMembershipMayEnd(
  db: Db,
  teamId: number,
  userId: string,
  role: TeamStanding,
  end: MembershipEnd,
): Promise<void> {
  if (role === 'owner') {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(teamMember)
      .where(and(eq(teamMember.teamId, teamId), eq(teamMember.role, 'owner')));
    if (count <= 1) throw new HttpError(409, end.lastOwner);
  }
  const [row] = await db
    .select({ role: teamMember.role, source: teamMember.source })
    .from(teamMember)
    .where(and(eq(teamMember.teamId, teamId), eq(teamMember.userId, userId)));
  if (row?.source === 'scim' && row.role === 'member') {
    throw new HttpError(409, 'This membership is managed by SCIM');
  }
  const soleOwned = await db.all<{ key: string }>(
    sql`select ${project.key} as key ${soleOwnedProjectsFrom(teamId, userId)} order by ${project.key}`,
  );
  if (soleOwned.length > 0) {
    const keys = soleOwned.map((r) => r.key).join(', ');
    throw new HttpError(
      409,
      `${end.subject} are the only owner of ${keys}. Give each one another owner first.`,
    );
  }
}

// The same rules, as the first statement of the batch that ends the membership: it
// fails, and with it the batch, when the membership changed since it was read, when the
// person is now the last owner, owns a project alone, or is provisioned by SCIM.
function membershipEndGuard(
  db: Db,
  teamId: number,
  userId: string,
  role: TeamStanding,
): BatchStatement {
  return abortBatchWhen(
    db,
    sql`not exists (select 1 from ${teamMember} where ${teamMember.teamId} = ${teamId}
        and ${teamMember.userId} = ${userId} and ${teamMember.role} = ${role})
      or (${role} = 'owner' and ${ownerCount(teamId)} <= 1)
      or exists (select 1 from ${teamMember} where ${teamMember.teamId} = ${teamId}
        and ${teamMember.userId} = ${userId} and ${teamMember.source} = 'scim'
        and ${teamMember.role} = 'member')
      or exists (select 1 ${soleOwnedProjectsFrom(teamId, userId)})`,
  );
}

// Ends a membership under its guard. The checks run once up front for the precise
// error, and again if the guard trips because somebody else changed the team meanwhile.
async function endMembership(
  db: Db,
  teamId: number,
  userId: string,
  role: TeamStanding,
  end: MembershipEnd,
): Promise<void> {
  await assertMembershipMayEnd(db, teamId, userId, role, end);
  try {
    await batchAll(db, [
      membershipEndGuard(db, teamId, userId, role),
      ...dropTeamMembershipStatements(db, teamId, userId),
    ]);
  } catch (err) {
    if (!isGuardViolation(err)) throw err;
    const now = await teamStandingOf(db, teamId, userId);
    if (!now) throw new HttpError(404, 'Member not found');
    await assertMembershipMayEnd(db, teamId, userId, now, end);
    throw new HttpError(409, 'This membership was changed meanwhile, try again');
  }
}

// Ends a team membership: the member leaves the team and every project it owns. What
// they already did in those projects stays — issues keep their assignee and their
// author.
function dropTeamMembershipStatements(db: Db, teamId: number, userId: string): BatchStatement[] {
  const teamProjects = db
    .select({ id: project.id })
    .from(project)
    .where(eq(project.teamId, teamId));
  return [
    db
      .delete(projectMember)
      .where(and(eq(projectMember.userId, userId), inArray(projectMember.projectId, teamProjects))),
    // A pending invite this member created outlives them otherwise, keeping the
    // registration gate open on their behalf after they were removed.
    db
      .delete(teamInvite)
      .where(
        and(
          eq(teamInvite.teamId, teamId),
          eq(teamInvite.invitedByUserId, userId),
          eq(teamInvite.status, 'pending'),
        ),
      ),
    // A column cannot keep assigning issues to someone who no longer belongs to the
    // project, the same rule remove_member follows.
    db
      .update(projectColumn)
      .set({ autoAssignUserId: null })
      .where(
        and(
          eq(projectColumn.autoAssignUserId, userId),
          inArray(projectColumn.projectId, teamProjects),
        ),
      ),
    db.delete(teamMember).where(and(eq(teamMember.teamId, teamId), eq(teamMember.userId, userId))),
  ];
}

// Removes a member from the team. Nobody removes themselves — that is leaving the
// team.
export async function removeTeamMember(
  db: Db,
  teamId: number,
  actorId: string,
  userId: string,
): Promise<void> {
  if ((await actorStanding(db, teamId, actorId)) !== 'owner') {
    throw new HttpError(403, 'Only a team owner can remove members');
  }
  if (userId === actorId) throw new HttpError(409, 'Leave the team instead of removing yourself');
  const current = await teamStandingOf(db, teamId, userId);
  if (!current) throw new HttpError(404, 'Member not found');
  if (current === 'agent') throw new HttpError(409, 'An agent is removed with its agent settings');
  await endMembership(db, teamId, userId, current, {
    lastOwner: 'A team must keep at least one owner',
    subject: 'They',
  });
}

// Drops the caller's own membership, with their access to the team's projects. The
// team keeps the projects themselves. The last owner cannot leave: a team without an
// owner has nobody who can rename it. Neither can the only owner of one of its
// projects, for the same reason one project down. An agent cannot either: its standing
// is written with the agent and nothing puts it back, so leaving would strand it.
export async function leaveTeam(db: Db, teamId: number, userId: string): Promise<void> {
  const role = await teamStandingOf(db, teamId, userId);
  if (!role) throw new HttpError(404, 'Member not found');
  if (role === 'agent') throw new HttpError(409, 'An agent is removed with its agent settings');
  await endMembership(db, teamId, userId, role, {
    lastOwner: 'The last owner cannot leave the team',
    subject: 'You',
  });
}

// The workspaces an account owns, as it is deleted. One holding no project and no AI
// agent goes with the account, teams and all. Any other passes to the instance owner,
// with the teams and projects the account owned alone in it, so its people keep a
// workspace somebody manages.
export async function releaseOwnedWorkspaces(db: Db, userId: string): Promise<void> {
  const owned = await db
    .select({ workspaceId: workspaceManager.workspaceId })
    .from(workspaceManager)
    .where(and(eq(workspaceManager.userId, userId), eq(workspaceManager.role, 'owner')));
  if (owned.length === 0) return;
  const [instanceOwner] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.role, 'god'))
    .orderBy(user.createdAt)
    .limit(1);
  const successor = instanceOwner?.id;
  for (const { workspaceId } of owned) {
    if (!(await workspaceHoldsWork(db, workspaceId))) {
      await db.delete(workspace).where(eq(workspace.id, workspaceId));
      continue;
    }
    if (!successor || successor === userId) continue;
    // One owner per workspace (unique index): the old row goes before the new one.
    await db.batch([
      db
        .delete(workspaceManager)
        .where(
          and(eq(workspaceManager.workspaceId, workspaceId), eq(workspaceManager.userId, userId)),
        ),
      db
        .insert(workspaceManager)
        .values({ workspaceId, userId: successor, role: 'owner' })
        .onConflictDoUpdate({
          target: [workspaceManager.workspaceId, workspaceManager.userId],
          set: { role: 'owner' },
        }),
    ]);
    await dropWorkspaceMemberships(db, workspaceId, userId);
  }
}

// Takes a person out of every team of the workspace, and with that out of all of its
// projects: what the workspace's identity provider does when it deprovisions them. A
// team or project they own alone passes to the workspace owner, so none is left with
// nobody who can manage it. One batch for every team, so the person is out of all of
// them or none.
export async function dropWorkspaceMemberships(
  db: Db,
  workspaceId: number,
  userId: string,
): Promise<void> {
  const teams = await db
    .select({ id: team.id })
    .from(team)
    .innerJoin(teamMember, eq(teamMember.teamId, team.id))
    .where(and(eq(team.workspaceId, workspaceId), eq(teamMember.userId, userId)))
    .orderBy(team.id);
  const [owner] = await db
    .select({ userId: workspaceManager.userId })
    .from(workspaceManager)
    .where(and(eq(workspaceManager.workspaceId, workspaceId), eq(workspaceManager.role, 'owner')));
  const statements: BatchStatement[] = [];
  for (const { id: teamId } of teams) {
    if (owner && owner.userId !== userId) {
      statements.push(...handOverSoleOwnershipStatements(db, teamId, userId, owner.userId));
    }
    statements.push(...dropTeamMembershipStatements(db, teamId, userId));
  }
  await batchAll(db, statements);
}

// Makes the successor the owner of what the person owns alone in the team: the team
// itself and any of its projects. A project membership stands on a team one, so the
// successor joins the team first. Each statement decides from the state when it runs
// (the person is still the only owner), and they must run before the person's own rows
// are dropped.
function handOverSoleOwnershipStatements(
  db: Db,
  teamId: number,
  userId: string,
  successorId: string,
): BatchStatement[] {
  const ownsTeamAlone = sql`(${ownerCount(teamId)} = 1 and exists (select 1 from ${teamMember}
    where ${teamMember.teamId} = ${teamId} and ${teamMember.userId} = ${userId}
    and ${teamMember.role} = 'owner'))`;
  return [
    db.run(sql`insert into ${teamMember} (team_id, user_id, role)
      select ${teamId}, ${successorId}, 'member'
      where ${ownsTeamAlone} or exists (select 1 ${soleOwnedProjectsFrom(teamId, userId)})
      on conflict do nothing`) as unknown as BatchStatement,
    db
      .update(teamMember)
      .set({ role: 'owner' })
      .where(and(eq(teamMember.teamId, teamId), eq(teamMember.userId, successorId), ownsTeamAlone)),
    // Not a SCIM row any more: the next sync must not take the ownership back.
    db.run(sql`insert into ${projectMember} (project_id, user_id, role, role_id, source)
      select ${project.id}, ${successorId}, 'owner', null, 'invite'
      ${soleOwnedProjectsFrom(teamId, userId)}
      on conflict (project_id, user_id) do update
      set role = 'owner', role_id = null, source = 'invite'`) as unknown as BatchStatement,
  ];
}
