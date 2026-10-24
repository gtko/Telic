import { dbContext } from '#shared/db-context';
import { Elysia, t } from 'elysia';
import { mcpTool } from '#mcp/generate';
import { noContent } from '#shared/http';
import { guards } from '#shared/guards';
import { paginate } from '#shared/pagination';
import { HttpError, rethrowDuplicate } from '#shared/lib';
import { PERMISSION_RESOURCES, PERMISSION_ACTIONS, resourceActions } from '#shared/permissions';
import { accessErrors, commonErrors, errors } from '#shared/responses';
import {
  listRoles,
  listRolesPage,
  getRole,
  getRoleUsage,
  isRoleInUse,
  createRole,
  updateRole,
  deleteRole,
} from './service';
import {
  PermissionCatalogResponse,
  RolePageResponse,
  RoleResponse,
  RoleUsageResponse,
  createRoleBody,
  deleteRoleQuery,
  roleListQuery,
  roleParams,
  teamParams,
  updateRoleBody,
} from './model';

// Roles CRUD. A role belongs to a team and every project the team owns assigns from
// that one list. Who may write one is the team's own ranks, not the permission
// matrix: a member with members_manage could otherwise grant itself a more powerful
// role. An owner or a manager creates and edits; deleting stays with the owner,
// since a deletion moves every member, agent and invite on the role to another one.
export const roleRoutes = new Elysia({ name: 'roles', detail: { tags: ['Roles'] } })
  .use(dbContext)
  .use(guards)

  // Static; any authenticated user may read it to render a role editor.
  .get(
    '/permission-catalog',
    () => ({
      resources: PERMISSION_RESOURCES.map((key) => ({ key, actions: [...resourceActions(key)] })),
      actions: [...PERMISSION_ACTIONS],
    }),
    {
      response: { 200: PermissionCatalogResponse, ...errors(401) },
      detail: {
        summary: 'List the permission catalog',
        description:
          "List the resources and actions a role's permission matrix is built from. " +
          'A resource lists the actions it supports; one it omits is always denied. ' +
          'ai_agents is administrative: it also attaches an agent to any project of the team ' +
          'and exposes the API key of an agent.',
        ...mcpTool('list_permission_catalog'),
      },
    },
  )

  // One page of the roles of a team, read by any of its members.
  .get(
    '/teams/:teamId/roles',
    ({ db, membership, query }) =>
      paginate(query, (window) =>
        listRolesPage(db, membership.teamId, { search: query.search, ...window }),
      ),
    {
      params: teamParams,
      query: roleListQuery,
      teamMember: true,
      response: { 200: RolePageResponse, ...accessErrors },
      detail: {
        summary: "List a team's roles",
        description:
          'One page of the roles a team offers, oldest first. `search` matches the name. ' +
          'Use list_role_options to read every one of them.',
        ...mcpTool('list_roles'),
      },
    },
  )

  // The projects assign from this one list, so a member list, an add-member dialog
  // and an agent's role picker all name their options from it. The matrices come
  // along: the roles are exported to the clipboard from here as well.
  .get('/teams/:teamId/roles/options', ({ db, membership }) => listRoles(db, membership.teamId), {
    params: teamParams,
    teamMember: true,
    response: { 200: t.Array(RoleResponse), ...accessErrors },
    detail: {
      summary: "List a team's role options",
      description:
        'Every role of the team, with its permission matrix, for the pickers that assign one. ' +
        'Use list_roles to read them a page at a time.',
      ...mcpTool('list_role_options'),
    },
  })

  .post(
    '/teams/:teamId/roles',
    async ({ db, membership, body, set }) => {
      try {
        set.status = 201;
        return await createRole(db, membership.teamId, body);
      } catch (err) {
        rethrowDuplicate(err, 'role');
      }
    },
    {
      params: teamParams,
      body: createRoleBody,
      teamManager: true,
      response: { 201: RoleResponse, ...commonErrors, ...errors(409) },
      detail: { summary: 'Create a role', ...mcpTool('create_role') },
    },
  )

  .patch(
    '/teams/:teamId/roles/:roleId',
    async ({ db, membership, params, body }) => {
      let role;
      try {
        role = await updateRole(db, membership.teamId, params.roleId, body);
      } catch (err) {
        rethrowDuplicate(err, 'role');
      }
      if (!role) throw new HttpError(404, 'Role not found');
      return role;
    },
    {
      params: roleParams,
      body: updateRoleBody,
      teamManager: true,
      response: { 200: RoleResponse, ...commonErrors, ...errors(409) },
      detail: {
        summary: 'Update a role',
        description: 'Update a role.',
        ...mcpTool('update_role'),
      },
    },
  )

  // What a role would take with it if deleted, so the caller can name where to move
  // it before asking for the deletion.
  .get(
    '/teams/:teamId/roles/:roleId/usage',
    async ({ db, membership, params }) => {
      const role = await getRole(db, membership.teamId, params.roleId);
      if (!role) throw new HttpError(404, 'Role not found');
      return getRoleUsage(db, params.roleId);
    },
    {
      params: roleParams,
      teamOwner: true,
      response: { 200: RoleUsageResponse, ...commonErrors },
      detail: {
        summary: 'Count what a role is assigned to',
        description:
          'Count the project members, AI agents, pending invites and provisioned group mappings on a role. They have to be moved to another role before it can be deleted.',
        ...mcpTool('get_role_usage'),
      },
    },
  )

  // Deletes a custom role. The default role cannot be deleted. A role that members,
  // agents, pending invites or provisioned group mappings are on is deleted only
  // together with targetRoleId, the role they are all moved to.
  .delete(
    '/teams/:teamId/roles/:roleId',
    async ({ db, membership, params, query }) => {
      const role = await getRole(db, membership.teamId, params.roleId);
      if (!role) throw new HttpError(404, 'Role not found');
      if (role.isDefault) throw new HttpError(400, 'The default role cannot be deleted');

      let targetRoleId: number | null = null;
      if (isRoleInUse(await getRoleUsage(db, params.roleId))) {
        if (query.targetRoleId === undefined) {
          throw new HttpError(
            400,
            'This role is in use. Pass targetRoleId to move its members, agents, pending invites and group mappings to another role.',
          );
        }
        if (query.targetRoleId === params.roleId) {
          throw new HttpError(400, 'Move to a role other than the one being deleted');
        }
        const target = await getRole(db, membership.teamId, query.targetRoleId);
        if (!target) throw new HttpError(404, 'Target role not found');
        targetRoleId = target.id;
      }

      await deleteRole(db, membership.teamId, params.roleId, targetRoleId);
      return noContent();
    },
    {
      params: roleParams,
      query: deleteRoleQuery,
      teamOwner: true,
      response: { 204: t.Void(), ...commonErrors },
      detail: {
        summary: 'Delete a role',
        description:
          'Delete a custom role. The default role cannot be deleted. A role in use requires targetRoleId, the role its members, agents, pending invites and group mappings are moved to.',
        ...mcpTool('delete_role'),
      },
    },
  );
