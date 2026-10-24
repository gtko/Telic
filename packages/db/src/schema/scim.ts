// SCIM 2.0 provisioning tables. An identity provider pushes users and groups to
// /scim/v2 in the API; an account is one `user` row across the instance, and what a
// provider knows about it lands here, as do its groups. `workspace_id` names the
// workspace whose provider wrote the row, and is null for the instance's provider, the
// one god mode sets up. A NULL takes no part in a unique constraint, so the instance's
// rows are kept unique by a partial index of their own.
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { user } from './auth';
import { project, teamRole, workspace } from './app';

// An account as one identity provider sees it. For the instance's provider `active`
// false means the account cannot sign in. For a workspace's, it decides who has the
// workspace, not who has an account: `active` false means the person was taken out of
// the workspace's teams and its groups grant them nothing. Every provider keeps its own
// row for the same person.
export const scimUser = sqliteTable(
  'scim_user',
  {
    workspaceId: integer('workspace_id').references(() => workspace.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    // The provider's own id for the person, sent as `externalId`.
    externalId: text('external_id'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(CAST(unixepoch('subsecond') * 1000 AS INTEGER))`),
  },
  (t) => [
    unique().on(t.workspaceId, t.userId),
    uniqueIndex('scim_user_instance_user_uq')
      .on(t.userId)
      .where(sql`${t.workspaceId} IS NULL`),
    index('scim_user_user_idx').on(t.userId),
  ],
);

// A group as one identity provider sees it. Written only over SCIM: the group list and
// its members are the provider's, and the settings show them read-only.
export const scimGroup = sqliteTable(
  'scim_group',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    workspaceId: integer('workspace_id').references(() => workspace.id, { onDelete: 'cascade' }),
    displayName: text('display_name').notNull(),
    // The provider's own id for the group, sent as `externalId` and used to find a
    // group again after it is renamed.
    externalId: text('external_id'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(CAST(unixepoch('subsecond') * 1000 AS INTEGER))`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(CAST(unixepoch('subsecond') * 1000 AS INTEGER))`),
  },
  (t) => [
    unique().on(t.workspaceId, t.displayName),
    uniqueIndex('scim_group_instance_display_name_uq')
      .on(t.displayName)
      .where(sql`${t.workspaceId} IS NULL`),
  ],
);

export const scimGroupMember = sqliteTable(
  'scim_group_member',
  {
    groupId: text('group_id')
      .notNull()
      .references(() => scimGroup.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.userId] }),
    index('scim_group_member_user_idx').on(t.userId),
  ],
);

// What a group grants. A SCIM group carries only a name and a member list, so whoever
// set up its provider declares that group X makes its members part of project Y at
// role Z: god for the instance's groups, the workspace owner for a workspace's, which
// map to projects of that workspace only. One group may map to several projects; at
// most one mapping per pair.
// `role_id` names the team_role a "member" joins on, and is NULL for an owner (an
// owner bypasses the permission matrix) or when the team's default role applies.
export const scimGroupMapping = sqliteTable(
  'scim_group_mapping',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    groupId: text('group_id')
      .notNull()
      .references(() => scimGroup.id, { onDelete: 'cascade' }),
    projectId: integer('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('member'),
    roleId: integer('role_id').references(() => teamRole.id, { onDelete: 'set null' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(CAST(unixepoch('subsecond') * 1000 AS INTEGER))`),
  },
  (t) => [
    unique().on(t.groupId, t.projectId),
    check('scim_group_mapping_role_check', sql`${t.role} IN ('owner', 'member')`),
    index('scim_group_mapping_project_idx').on(t.projectId),
  ],
);
