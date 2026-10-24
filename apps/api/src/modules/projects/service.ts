import { likeText } from '#modules/issues/sql-helpers';
import {
  type Db,
  aiAgent,
  documentAsset,
  initiative,
  initiativeAttachment,
  issue,
  issueActivity,
  issueAttachment,
  issueType,
  project,
  projectColumn,
  projectMember,
  projectDocument,
  teamRole,
  projectSetting,
  team,
  teamMember,
  batchAll,
  chunk,
} from '@repo/db';
import {
  and,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { HttpError, iso } from '#shared/lib';
import { PROJECT_KEY_PATTERN } from './key';
import type { Permissions } from '#shared/permissions';
import { getProjectSetting, setProjectSetting } from '#shared/project-settings';
import { PROJECT_FEATURES, featureLabel, type ProjectFeature } from '#shared/features';
import { getTeamLimits } from '#shared/limits';
import { projectAccess, type AccessVia } from '#shared/workspace-roles';
import { toMemberContext, type MemberRole } from '#modules/members/service';
import { workspaceGrants } from '#modules/workspaces/service';
import { assertSeatFree } from '#modules/teams/service';
import { getProjectDefaults } from '#modules/settings/service';
import { getDefaultRoleId } from '#modules/roles/service';
import { dropUnusedTeamMembership } from '#modules/scim/reconcile';
import { projectRef, teamRef } from '#modules/teams/ref';
import { deleteObjects } from '@repo/storage';

// Data access for projects: the top-level container that groups its own columns,
// issue types, labels, assignees, custom fields, issues, saved views, and
// actions. Access is by membership (project_member): the creator becomes an
// "owner" and only members can reach a project's entities.

export interface ProjectRow {
  id: number;
  teamId: number;
  teamName: string;
  // The team's segment in web URLs: its slug, or its id while it has none.
  teamRef: string;
  key: string;
  // How a URL names the project: "<teamRef>.<key>". See getProjectByRef.
  ref: string;
  name: string;
  description: string;
  mcpEnabled: boolean;
  // The team's own MCP switch, carried here because every MCP gate is a project
  // gate: a project is reachable only while both flags are on.
  teamMcpEnabled: boolean;
  initiativesEnabled: boolean;
  dashboardsEnabled: boolean;
  documentsEnabled: boolean;
  notesEnabled: boolean;
  cyclesEnabled: boolean;
  subtasksEnabled: boolean;
  checklistsEnabled: boolean;
  issueStatsEnabled: boolean;
  pointsEstimateEnabled: boolean;
  timeEstimateEnabled: boolean;
  timeLoggingEnabled: boolean;
  // The sections this project may use at all. A section missing here is blocked for
  // the team that owns the project: its flag above reads as off and the settings page
  // does not offer it.
  availableFeatures: ProjectFeature[];
  archivedAt: string | null;
  createdAt: string;
}

// The optional sections an owner can turn off per project (Settings -> General).
// A disabled section is hidden in the web app; its rows are kept.
export interface ProjectFeatures {
  initiatives: boolean;
  dashboards: boolean;
  documents: boolean;
  notes: boolean;
  cycles: boolean;
  subtasks: boolean;
  checklists: boolean;
  issueStats: boolean;
}

// A project in the caller's list, carrying the caller's own role in it. The list
// UI (project switcher, manage-projects page) uses `role` to gate owner-only
// actions like deletion; the API still enforces the permission on every request.
export interface ProjectListItem extends ProjectRow {
  role: 'owner' | 'member';
  via: AccessVia;
  lastActivityAt: string | null;
  isFavorite: boolean;
  isHidden: boolean;
  // The caller's resolved permission matrix in this project. Present only when the
  // list is requested with permissions (opts.withPermissions); omitted otherwise.
  permissions?: Permissions;
}

type ProjectWithTeam = typeof project.$inferSelect & {
  teamName: string;
  teamSlug: string | null;
  teamMcpEnabled: boolean;
};

const projectWithTeam = {
  ...getTableColumns(project),
  teamName: team.name,
  teamSlug: team.slug,
  teamMcpEnabled: team.mcpEnabled,
};

// A blocked section reads as off whatever the project has stored, so masking here is
// what turns a feature off everywhere: the web app reads the flags off this DTO, and
// the route guards read them off the project the guard resolved.
export async function mapProject(db: Db, row: ProjectWithTeam): Promise<ProjectRow> {
  const { blockedFeatures } = await getTeamLimits(db, row.teamId);
  const on = (feature: ProjectFeature, stored: boolean) =>
    stored && !blockedFeatures.includes(feature);
  return {
    id: row.id,
    teamId: row.teamId,
    teamName: row.teamName,
    teamRef: teamRef({ id: row.teamId, slug: row.teamSlug }),
    key: row.key,
    ref: projectRef({ id: row.teamId, slug: row.teamSlug }, row.key),
    name: row.name,
    description: row.description,
    mcpEnabled: row.mcpEnabled,
    teamMcpEnabled: row.teamMcpEnabled,
    initiativesEnabled: on('initiatives', row.initiativesEnabled),
    dashboardsEnabled: on('dashboards', row.dashboardsEnabled),
    documentsEnabled: on('documents', row.documentsEnabled),
    notesEnabled: on('notes', row.notesEnabled),
    cyclesEnabled: on('cycles', row.cyclesEnabled),
    subtasksEnabled: on('subtasks', row.subtasksEnabled),
    checklistsEnabled: on('checklists', row.checklistsEnabled),
    issueStatsEnabled: on('issueStats', row.issueStatsEnabled),
    pointsEstimateEnabled: row.pointsEstimateEnabled,
    timeEstimateEnabled: row.timeEstimateEnabled,
    timeLoggingEnabled: row.timeLoggingEnabled,
    availableFeatures: PROJECT_FEATURES.filter((feature) => !blockedFeatures.includes(feature)),
    archivedAt: row.archivedAt ? iso(row.archivedAt) : null,
    createdAt: iso(row.createdAt),
  };
}

interface ProjectListOptions {
  mcpOnly?: boolean;
  withPermissions?: boolean;
  q?: string;
  sort?: 'key' | 'name' | 'created' | 'activity';
  teamId?: number;
  workspaceId?: number;
  ids?: number[];
  favorite?: boolean;
  hidden?: boolean;
  favoritesFirst?: boolean;
}

export async function listProjects(
  db: Db,
  userId: string,
  opts: ProjectListOptions = {},
): Promise<ProjectListItem[]> {
  return (await readProjects(db, userId, opts)).items;
}

export function searchProjects(
  db: Db,
  userId: string,
  opts: Omit<ProjectListOptions, 'mcpOnly' | 'withPermissions' | 'favoritesFirst'>,
  window: { limit: number; offset: number },
): Promise<{ items: ProjectListItem[]; total: number }> {
  return readProjects(db, userId, { ...opts, favoritesFirst: true }, window);
}

// A project reached through the workspace has no membership row, so its preference
// columns are null and count as off.
function preference(
  column: typeof projectMember.isFavorite | typeof projectMember.isHidden,
  on?: boolean,
) {
  if (on === undefined) return undefined;
  return on ? eq(column, true) : sql`${column} is not true`;
}

async function readProjects(
  db: Db,
  userId: string,
  opts: ProjectListOptions,
  window?: { limit: number; offset: number },
): Promise<{ items: ProjectListItem[]; total: number }> {
  const grants = await workspaceGrants(db, userId);
  const grantedTeams = [...grants.keys()];
  const term = opts.q?.trim().replace(/[\\%_]/g, '\\$&');
  const callerMember = and(
    eq(projectMember.projectId, project.id),
    eq(projectMember.userId, userId),
  );
  const where = and(
    or(
      isNotNull(projectMember.userId),
      grantedTeams.length > 0 ? inArray(project.teamId, grantedTeams) : undefined,
    ),
    isNull(project.archivedAt),
    opts.mcpOnly ? and(eq(project.mcpEnabled, true), eq(team.mcpEnabled, true)) : undefined,
    opts.teamId !== undefined ? eq(project.teamId, opts.teamId) : undefined,
    opts.workspaceId !== undefined ? eq(team.workspaceId, opts.workspaceId) : undefined,
    opts.ids ? inArray(project.id, opts.ids) : undefined,
    preference(projectMember.isFavorite, opts.favorite),
    preference(projectMember.isHidden, opts.hidden),
    term
      ? or(
          likeText(project.key, `%${term}%`),
          likeText(project.name, `%${term}%`),
          likeText(project.description, `%${term}%`),
        )
      : undefined,
  );
  const readingTeams = [...grants]
    .filter(([, grant]) => grant === 'owner' || grant.work_items.read)
    .map(([teamId]) => teamId);
  const latestActivity = db
    .select({
      projectId: issue.projectId,
      createdAt: sql<Date>`max(${issueActivity.createdAt})`
        .mapWith(issueActivity.createdAt)
        .as('last_activity_at'),
    })
    .from(issueActivity)
    .innerJoin(issue, eq(issue.id, issueActivity.issueId))
    .innerJoin(project, eq(project.id, issue.projectId))
    .innerJoin(team, eq(team.id, project.teamId))
    .leftJoin(projectMember, callerMember)
    .leftJoin(teamRole, eq(teamRole.id, projectMember.roleId))
    .where(
      and(
        where,
        or(
          and(
            isNotNull(projectMember.userId),
            or(
              eq(projectMember.role, 'owner'),
              isNull(teamRole.permissions),
              sql`json_extract(${teamRole.permissions}, '$.work_items.read') = 1`,
            ),
          ),
          readingTeams.length > 0 ? inArray(project.teamId, readingTeams) : undefined,
        ),
      ),
    )
    .groupBy(issue.projectId)
    .as('latest_activity');
  const order: SQL[] = [];
  if (opts.favoritesFirst) order.push(sql`${projectMember.isFavorite} is true desc`);
  if (opts.sort === 'activity') order.push(sql`${latestActivity.createdAt} desc nulls last`);
  else if (opts.sort === 'created') order.push(desc(project.createdAt));
  else if (opts.sort === 'name') order.push(sql`lower(${project.name})`);
  const query = db
    .select({
      ...projectWithTeam,
      memberRole: projectMember.role,
      rolePermissions: teamRole.permissions,
      lastActivityAt: latestActivity.createdAt,
      isFavorite: projectMember.isFavorite,
      isHidden: projectMember.isHidden,
    })
    .from(project)
    .innerJoin(team, eq(team.id, project.teamId))
    .leftJoin(projectMember, callerMember)
    .leftJoin(teamRole, eq(teamRole.id, projectMember.roleId))
    .leftJoin(latestActivity, eq(latestActivity.projectId, project.id))
    .where(where)
    .orderBy(...order, project.key, project.id)
    .$dynamic();
  const [rows, counted] = await Promise.all([
    window ? query.limit(window.limit).offset(window.offset) : query,
    window
      ? db
          .select({ count: sql<number>`count(*)` })
          .from(project)
          .innerJoin(team, eq(team.id, project.teamId))
          .leftJoin(projectMember, callerMember)
          .where(where)
      : undefined,
  ]);
  const items = await Promise.all(
    rows.map(
      async ({ memberRole, rolePermissions, lastActivityAt, isFavorite, isHidden, ...row }) => {
        const member = memberRole
          ? toMemberContext(memberRole as MemberRole, rolePermissions)
          : null;
        const access = projectAccess(member, grants.get(row.teamId) ?? null)!;
        const item: ProjectListItem = {
          ...(await mapProject(db, row)),
          role: access.role,
          via: access.via,
          lastActivityAt: lastActivityAt ? iso(lastActivityAt) : null,
          isFavorite: isFavorite ?? false,
          isHidden: isHidden ?? false,
        };
        if (opts.withPermissions) item.permissions = access.permissions;
        return item;
      },
    ),
  );
  return { items, total: counted?.[0]?.count ?? items.length };
}

// Resolves the project a URL names. The full form is "<teamRef>.<key>", where the
// team is its slug or its id; a slug starts with a letter, so the two never collide.
// A bare key is what every URL carried while keys were unique on the instance: it
// still names a project as long as only one project with that key is in the
// caller's teams, and is refused with 409 once there are several.
export async function getProjectByRef(
  db: Db,
  ref: string,
  userId: string,
): Promise<ProjectRow | null> {
  const dot = ref.indexOf('.');
  if (dot >= 0) {
    const teamPart = ref.slice(0, dot);
    const byTeam = /^\d{1,9}$/.test(teamPart)
      ? eq(team.id, Number(teamPart))
      : eq(team.slug, teamPart);
    const [row] = await db
      .select(projectWithTeam)
      .from(project)
      .innerJoin(team, eq(team.id, project.teamId))
      .where(and(byTeam, eq(project.key, ref.slice(dot + 1))));
    return row ? mapProject(db, row) : null;
  }

  const rows = await db
    .select(projectWithTeam)
    .from(project)
    .innerJoin(team, eq(team.id, project.teamId))
    .where(eq(project.key, ref));
  if (rows.length <= 1) return rows[0] ? mapProject(db, rows[0]) : null;

  const [teamIds, grants] = await Promise.all([
    db
      .select({ teamId: teamMember.teamId })
      .from(teamMember)
      .where(
        and(
          eq(teamMember.userId, userId),
          inArray(
            teamMember.teamId,
            rows.map((r) => r.teamId),
          ),
        ),
      ),
    workspaceGrants(db, userId),
  ]);
  const mine = rows.filter(
    (r) => teamIds.some((m) => m.teamId === r.teamId) || grants.has(r.teamId),
  );
  if (mine.length === 0) return null;
  if (mine.length > 1) {
    throw new HttpError(
      409,
      `Several of your teams have a project '${ref}'. Name it with its team, as '<team>.${ref}'.`,
    );
  }
  return mapProject(db, mine[0]);
}

export async function getProjectById(db: Db, id: number): Promise<ProjectRow | null> {
  const rows = await db
    .select(projectWithTeam)
    .from(project)
    .innerJoin(team, eq(team.id, project.teamId))
    .where(eq(project.id, id));
  return rows[0] ? mapProject(db, rows[0]) : null;
}

// The team that owns a project, for the resources the team holds on behalf of all of
// them (integration credentials, notification providers). Throws 404 for an unknown
// project.
export async function getProjectTeamId(db: Db, projectId: number): Promise<number> {
  const rows = await db
    .select({ teamId: project.teamId })
    .from(project)
    .where(eq(project.id, projectId));
  if (!rows[0]) throw new HttpError(404, 'Project not found');
  return rows[0].teamId;
}

// The team a new project belongs to. The caller's rank in it is checked by the route.
export async function targetTeam(db: Db, userId: string, teamId: number): Promise<TargetTeam> {
  const [row] = await db
    .select({
      id: team.id,
      name: team.name,
      slug: team.slug,
      mcpEnabled: team.mcpEnabled,
      defaultAgentIds: team.defaultAgentIds,
    })
    .from(team)
    .where(eq(team.id, teamId));
  if (!row) throw new HttpError(404, 'Team not found');
  // The creator joins the team with the project (joinTeamAsCreator).
  await assertSeatFree(db, row.id, userId);
  return row;
}

// A project membership stands on a team one. The workspace owner runs every team of the
// workspace without being in it, so a project they create there makes them a member.
export async function joinTeamAsCreator(db: Db, teamId: number, userId: string): Promise<void> {
  await joinTeamAsCreatorStatement(db, teamId, userId);
}

// The same insert as a statement not yet run, for a caller's own `db.batch`.
export function joinTeamAsCreatorStatement(db: Db, teamId: number, userId: string) {
  return db.insert(teamMember).values({ teamId, userId, role: 'member' }).onConflictDoNothing();
}

// The team a project is created in, with what mapProject needs from it.
export interface TargetTeam {
  id: number;
  name: string;
  slug: string | null;
  mcpEnabled: boolean;
  defaultAgentIds: number[];
}

// Every new project starts with one column per state type, so it's usable (has
// somewhere to put an issue) without a trip to Settings first.
export const DEFAULT_COLUMNS: { name: string; stateType: string; color: string }[] = [
  { name: 'Backlog', stateType: 'backlog', color: '#71717a' },
  { name: 'Todo', stateType: 'unstarted', color: '#6b7280' },
  { name: 'In Progress', stateType: 'started', color: '#eab308' },
  { name: 'Done', stateType: 'completed', color: '#22c55e' },
  { name: 'Canceled', stateType: 'canceled', color: '#ef4444' },
];

// Issue types a new project starts with, picked by sphere of work in the create
// dialog. The first entry of a set becomes the project's default type. "general"
// is the fallback when no preset is chosen: a single Task, so the project is
// usable without committing to a classification.
export const ISSUE_TYPE_PRESETS: Record<string, { name: string; color: string }[]> = {
  general: [{ name: 'Task', color: '#0ea5e9' }],
  software: [
    { name: 'Feature', color: '#8b5cf6' },
    { name: 'Bug', color: '#e11d48' },
    { name: 'Task', color: '#0ea5e9' },
    { name: 'Tech debt', color: '#f97316' },
    { name: 'Research', color: '#14b8a6' },
  ],
  product: [
    { name: 'Epic', color: '#8b5cf6' },
    { name: 'Feature', color: '#0ea5e9' },
    { name: 'Feedback', color: '#eab308' },
    { name: 'Research', color: '#14b8a6' },
  ],
  content: [
    { name: 'Article', color: '#0ea5e9' },
    { name: 'Video', color: '#e11d48' },
    { name: 'Social post', color: '#8b5cf6' },
    { name: 'Idea', color: '#eab308' },
    { name: 'Review', color: '#22c55e' },
  ],
  marketing: [
    { name: 'Campaign', color: '#8b5cf6' },
    { name: 'Landing', color: '#0ea5e9' },
    { name: 'Asset', color: '#14b8a6' },
    { name: 'Email', color: '#f97316' },
    { name: 'Research', color: '#22c55e' },
  ],
  design: [
    { name: 'Screen', color: '#0ea5e9' },
    { name: 'Component', color: '#8b5cf6' },
    { name: 'Asset', color: '#14b8a6' },
    { name: 'Research', color: '#22c55e' },
  ],
  sales: [
    { name: 'Lead', color: '#0ea5e9' },
    { name: 'Deal', color: '#22c55e' },
    { name: 'Follow-up', color: '#eab308' },
    { name: 'Account', color: '#8b5cf6' },
  ],
  operations: [
    { name: 'Request', color: '#0ea5e9' },
    { name: 'Process', color: '#8b5cf6' },
    { name: 'Purchase', color: '#22c55e' },
    { name: 'Maintenance', color: '#f97316' },
  ],
  support: [
    { name: 'Incident', color: '#e11d48' },
    { name: 'Request', color: '#0ea5e9' },
    { name: 'Question', color: '#eab308' },
    { name: 'Change', color: '#8b5cf6' },
  ],
  recruiting: [
    { name: 'Candidate', color: '#0ea5e9' },
    { name: 'Onboarding', color: '#22c55e' },
    { name: 'Request', color: '#8b5cf6' },
    { name: 'Policy', color: '#6b7280' },
  ],
};

export const ISSUE_TYPE_PRESET_KEYS = Object.keys(ISSUE_TYPE_PRESETS);

export type IssueTypePreset = keyof typeof ISSUE_TYPE_PRESETS;

export async function createProject(
  db: Db,
  input: {
    key: string;
    name: string;
    description?: string;
    preset?: string;
  },
  ownerId: string,
  teamId: number,
): Promise<ProjectRow> {
  const ownerTeam = await targetTeam(db, ownerId, teamId);
  // What a new project starts with, set instance-wide in god mode. Read before
  // any write starts.
  const defaults = await getProjectDefaults(db);
  const defaultAgents = ownerTeam.defaultAgentIds.length
    ? await db
        .select({ userId: aiAgent.userId })
        .from(aiAgent)
        .where(
          and(eq(aiAgent.teamId, ownerTeam.id), inArray(aiAgent.id, ownerTeam.defaultAgentIds)),
        )
    : [];
  const defaultRoleId = defaultAgents.length ? await getDefaultRoleId(db, ownerTeam.id) : null;
  // One atomic D1 batch. The project id the later statements need is read back by
  // sub-select on the unique (team, key) the first insert just wrote.
  const projectId = sql<number>`(select ${project.id} from ${project} where ${project.teamId} = ${ownerTeam.id} and ${project.key} = ${input.key} order by ${project.id} desc limit 1)`;
  const types = ISSUE_TYPE_PRESETS[input.preset ?? 'general'] ?? ISSUE_TYPE_PRESETS.general;
  const results = await batchAll(db, [
    joinTeamAsCreatorStatement(db, ownerTeam.id, ownerId),
    db
      .insert(project)
      .values({
        teamId: ownerTeam.id,
        key: input.key,
        name: input.name,
        description: input.description ?? '',
        mcpEnabled: defaults.mcpEnabled,
      })
      .returning(),
    db.insert(projectMember).values({ projectId, userId: ownerId, role: 'owner' }),
    ...chunk(defaultAgents, 15).map((agents) =>
      db.insert(projectMember).values(
        agents.map((agent) => ({
          projectId,
          userId: agent.userId,
          role: 'member',
          roleId: defaultRoleId,
        })),
      ),
    ),
    ...DEFAULT_COLUMNS.map((column, position) =>
      db.insert(projectColumn).values({
        projectId,
        name: column.name,
        stateType: column.stateType,
        color: column.color,
        position,
      }),
    ),
    ...types.map((type, position) =>
      db.insert(issueType).values({
        projectId,
        name: type.name,
        color: type.color,
        isDefault: position === 0,
        position,
      }),
    ),
    db
      .insert(projectSetting)
      .values({ projectId, key: AUTO_ARCHIVE_KEY, value: DEFAULT_AUTO_ARCHIVE }),
  ]);
  const [row] = results[1] as (typeof project.$inferSelect)[];
  return mapProject(db, {
    ...row,
    teamName: ownerTeam.name,
    teamSlug: ownerTeam.slug,
    teamMcpEnabled: ownerTeam.mcpEnabled,
  });
}

// A key stored before PROJECT_KEY_PATTERN existed (e.g. "7XTR") cannot form an issue
// identifier, so it may be replaced once. A valid key does not change.
export async function updateProject(
  db: Db,
  projectId: number,
  patch: { key?: string; name?: string; description?: string },
): Promise<ProjectRow | null> {
  const values: Partial<typeof project.$inferInsert> = {};
  if (patch.key !== undefined) {
    const current = await getProjectById(db, projectId);
    if (!current) return null;
    if (patch.key !== current.key) {
      if (new RegExp(PROJECT_KEY_PATTERN).test(current.key)) {
        throw new HttpError(400, 'The project key cannot change');
      }
      values.key = patch.key;
    }
  }
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.description !== undefined) values.description = patch.description;
  if (Object.keys(values).length === 0) return getProjectById(db, projectId);
  await db.update(project).set(values).where(eq(project.id, projectId));
  return getProjectById(db, projectId);
}

export async function setProjectArchived(
  db: Db,
  projectId: number,
  archived: boolean,
): Promise<ProjectRow | null> {
  await db
    .update(project)
    .set({ archivedAt: archived ? new Date() : null })
    .where(eq(project.id, projectId));
  return getProjectById(db, projectId);
}

// The project's feature toggles, read from the project row.
export function projectFeatures(row: ProjectRow): ProjectFeatures {
  return {
    initiatives: row.initiativesEnabled,
    dashboards: row.dashboardsEnabled,
    documents: row.documentsEnabled,
    notes: row.notesEnabled,
    cycles: row.cyclesEnabled,
    subtasks: row.subtasksEnabled,
    checklists: row.checklistsEnabled,
    issueStats: row.issueStatsEnabled,
  };
}

// Turns the optional sections on or off. Only the supplied ones change; a section
// that is turned off keeps its rows and shows again when it is turned back on.
export async function setProjectFeatures(
  db: Db,
  projectId: number,
  patch: Partial<ProjectFeatures>,
): Promise<ProjectRow | null> {
  const { blockedFeatures } = await getTeamLimits(db, await getProjectTeamId(db, projectId));
  const blocked = blockedFeatures.find((feature) => patch[feature]);
  if (blocked) {
    throw new HttpError(400, `${featureLabel(blocked)} are not available for this team`);
  }
  const values: Partial<typeof project.$inferInsert> = {};
  if (patch.initiatives !== undefined) values.initiativesEnabled = patch.initiatives;
  if (patch.dashboards !== undefined) values.dashboardsEnabled = patch.dashboards;
  if (patch.documents !== undefined) values.documentsEnabled = patch.documents;
  if (patch.notes !== undefined) values.notesEnabled = patch.notes;
  if (patch.cycles !== undefined) values.cyclesEnabled = patch.cycles;
  if (patch.subtasks !== undefined) values.subtasksEnabled = patch.subtasks;
  if (patch.checklists !== undefined) values.checklistsEnabled = patch.checklists;
  if (patch.issueStats !== undefined) values.issueStatsEnabled = patch.issueStats;
  if (Object.keys(values).length === 0) return getProjectById(db, projectId);
  await db.update(project).set(values).where(eq(project.id, projectId));
  return getProjectById(db, projectId);
}

// Which estimate kinds the project's issues carry, and whether its members log the
// time they spend. Held on the project row rather than in project_setting: every
// member's project payload already carries it, so a board knows whether estimates
// are on without a request of its own. Logging is independent of the time estimate:
// a team can log time without estimating first.
export interface EstimateSettings {
  points: boolean;
  time: boolean;
  logging: boolean;
}

// Turns them on or off. One turned off keeps what the issues already carry — the
// estimates, the logged entries — which show again when it is turned back on.
export async function setEstimateSettings(
  db: Db,
  projectId: number,
  input: EstimateSettings,
): Promise<EstimateSettings | null> {
  const [row] = await db
    .update(project)
    .set({
      pointsEstimateEnabled: input.points,
      timeEstimateEnabled: input.time,
      timeLoggingEnabled: input.logging,
    })
    .where(eq(project.id, projectId))
    .returning();
  return row
    ? {
        points: row.pointsEstimateEnabled,
        time: row.timeEstimateEnabled,
        logging: row.timeLoggingEnabled,
      }
    : null;
}

// Auto-archive thresholds for a project. Stored in project_setting under
// AUTO_ARCHIVE_KEY as { completedDays, canceledDays }. Each value is the number of
// days an issue may sit inactive in a completed/canceled column before the sweep
// archives it; null disables archiving for that state group. A new project is
// created with DEFAULT_AUTO_ARCHIVE; a project with no stored row (created before
// this) keeps both null, so nothing is archived until an owner turns it on. The
// sweep reads the same key and jsonb fields directly (modules/issues/auto-archive.ts)
// — keep them in sync.
const AUTO_ARCHIVE_KEY = 'auto_archive';

const DEFAULT_AUTO_ARCHIVE = { completedDays: 28, canceledDays: 7 };

export interface AutoArchiveSettings {
  completedDays: number | null;
  canceledDays: number | null;
}

// Coerces a stored/input value to a positive integer day count, or null (disabled)
// for anything else. Guards against non-integer or non-positive thresholds.
function normalizeDays(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function getAutoArchiveSettings(
  db: Db,
  projectId: number,
): Promise<AutoArchiveSettings> {
  const stored = await getProjectSetting<Partial<AutoArchiveSettings>>(
    db,
    projectId,
    AUTO_ARCHIVE_KEY,
  );
  return {
    completedDays: normalizeDays(stored?.completedDays),
    canceledDays: normalizeDays(stored?.canceledDays),
  };
}

export async function setAutoArchiveSettings(
  db: Db,
  projectId: number,
  input: { completedDays?: number | null; canceledDays?: number | null },
): Promise<AutoArchiveSettings> {
  const next: AutoArchiveSettings = {
    completedDays: normalizeDays(input.completedDays),
    canceledDays: normalizeDays(input.canceledDays),
  };
  await setProjectSetting(db, projectId, AUTO_ARCHIVE_KEY, next);
  return next;
}

// The subtask automations, stored in project_setting under SUBTASK_AUTOMATION_KEY.
// completeParent moves a parent into the column of its last closed subtask once
// every subtask is closed; closeSubtasks moves the still-open subtasks of an issue
// into the column the issue was closed in. Both off unless a project turns them on:
// they rewrite states nobody asked to change. Applied in modules/issues/automation.ts.
const SUBTASK_AUTOMATION_KEY = 'subtask_automation';

export interface SubtaskAutomationSettings {
  completeParent: boolean;
  closeSubtasks: boolean;
}

export async function getSubtaskAutomationSettings(
  db: Db,
  projectId: number,
): Promise<SubtaskAutomationSettings> {
  const stored = await getProjectSetting<Partial<SubtaskAutomationSettings>>(
    db,
    projectId,
    SUBTASK_AUTOMATION_KEY,
  );
  return {
    completeParent: stored?.completeParent === true,
    closeSubtasks: stored?.closeSubtasks === true,
  };
}

export async function setSubtaskAutomationSettings(
  db: Db,
  projectId: number,
  input: SubtaskAutomationSettings,
): Promise<SubtaskAutomationSettings> {
  const next: SubtaskAutomationSettings = {
    completeParent: input.completeParent,
    closeSubtasks: input.closeSubtasks,
  };
  await setProjectSetting(db, projectId, SUBTASK_AUTOMATION_KEY, next);
  return next;
}

// Deletes a project and everything scoped to it. Every project-scoped foreign key
// has ON DELETE CASCADE on project_id, so deleting the project row removes its
// columns, issue types, labels, initiatives, issues, views, dashboards, and
// actions, which in turn cascade to their own dependents (an issue's labels, field
// values/options, attachments, and activity; a custom field's values). The
// issue.column_id foreign key is NO ACTION, checked at end of statement — both the
// issues and their columns are deleted by the same cascade, so it is satisfied.
export async function deleteProject(db: Db, projectId: number): Promise<void> {
  // A team membership the SCIM reconciliation granted stands on the project
  // memberships it granted with it, and no group change follows the delete to re-check
  // it, so the members are read while they still exist and re-checked afterwards.
  const provisioned = await db
    .select({ teamId: project.teamId, userId: projectMember.userId })
    .from(projectMember)
    .innerJoin(project, eq(project.id, projectMember.projectId))
    .where(and(eq(projectMember.projectId, projectId), eq(projectMember.source, 'scim')));
  // The asset keys are read and the project deleted in one atomic batch, so a file added
  // meanwhile either is listed here or loses its foreign key and cleans itself up.
  const [issueAssets, documentAssets, initiativeAssets] = await db.batch([
    db
      .select({ s3Key: issueAttachment.s3Key })
      .from(issueAttachment)
      .innerJoin(issue, eq(issue.id, issueAttachment.issueId))
      .where(eq(issue.projectId, projectId)),
    db
      .select({ s3Key: documentAsset.s3Key })
      .from(documentAsset)
      .innerJoin(projectDocument, eq(projectDocument.id, documentAsset.documentId))
      .where(eq(projectDocument.projectId, projectId)),
    db
      .select({ s3Key: initiativeAttachment.s3Key })
      .from(initiativeAttachment)
      .innerJoin(initiative, eq(initiative.id, initiativeAttachment.initiativeId))
      .where(eq(initiative.projectId, projectId)),
    db.delete(project).where(eq(project.id, projectId)),
  ]);
  const assetKeys = [...issueAssets, ...documentAssets, ...initiativeAssets].map(
    (asset) => asset.s3Key,
  );
  await deleteObjects(assetKeys);
  for (const { teamId, userId } of provisioned) {
    await dropUnusedTeamMembership(db, teamId, userId);
  }
}
