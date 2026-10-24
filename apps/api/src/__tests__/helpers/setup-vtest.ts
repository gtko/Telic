// Stand-ins, for the vitest suites, of the cross-module functions that other lots of the
// D1 port have not yet made db-first (they still read a global db). Each one is the
// same code the real module has, with the db passed in. Delete an entry once its module
// is ported and merged: the real function then runs.
import { projectMember, teamRole, type Db } from '@repo/db';
import { eq } from 'drizzle-orm';
import { vi } from 'vitest';

vi.mock('#modules/members/service', async (importOriginal) => {
  const original = await importOriginal<typeof import('#modules/members/service')>();
  return {
    ...original,
    listMemberContexts: async (db: Db, projectId: number) => {
      const rows = await db
        .select({
          userId: projectMember.userId,
          role: projectMember.role,
          permissions: teamRole.permissions,
        })
        .from(projectMember)
        .leftJoin(teamRole, eq(teamRole.id, projectMember.roleId))
        .where(eq(projectMember.projectId, projectId));
      return new Map(
        rows.map((r) => [
          r.userId,
          original.toMemberContext(r.role as 'owner' | 'member', r.permissions),
        ]),
      );
    },
  };
});

// Webhook delivery and schedule runs read the global db and are not what these suites
// exercise: nobody is subscribed, and no status run is queued or unfinished.
vi.mock('#modules/webhooks/emit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#modules/webhooks/emit')>()),
  projectEventWanted: async () => false,
  emitWebhookEvents: async () => undefined,
}));
vi.mock('#modules/agents/schedules/issue-runs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#modules/agents/schedules/issue-runs')>()),
  queueStatusRuns: async () => undefined,
  hasUnfinishedStatusRuns: async () => false,
}));

// Notifications and agent mention/run triggers read the global db: not exercised here.
vi.mock('#modules/notifications/service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#modules/notifications/service')>()),
  notifyIssueChange: async () => undefined,
  notifyTextMentions: async () => undefined,
  notifyComment: async () => undefined,
  notifyEditedCommentMentions: async () => undefined,
}));
vi.mock('#modules/agents/core/run-queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#modules/agents/core/run-queue')>()),
  enqueueAgentRun: async () => undefined,
}));
vi.mock('#modules/agents/core/service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#modules/agents/core/service')>()),
  isAgentUser: async () => false,
  listMentionTriggerAgents: async () => [],
  getAssignTriggerAgent: async () => null,
  getFieldTriggerAgent: async () => null,
  isProjectAgent: async () => false,
}));

// shared/access still reads the project feature flags through the global db; every
// feature is on for a seeded project anyway.
vi.mock('#shared/access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#shared/access')>()),
  assertProjectFeature: async () => undefined,
}));

// The projects services lean on modules that still take no db. Seats, instance defaults, agent threads and SCIM
// reconciliation are out of scope.
vi.mock('#modules/settings/service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#modules/settings/service')>()),
  getProjectDefaults: async () => ({ mcpEnabled: false }),
}));
vi.mock('#modules/teams/service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#modules/teams/service')>()),
  assertSeatFree: async () => undefined,
}));
vi.mock('#modules/agents/core/runtime/memory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#modules/agents/core/runtime/memory')>()),
  deleteThreadsWhere: async () => undefined,
}));
vi.mock('#modules/scim/reconcile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#modules/scim/reconcile')>()),
  dropUnusedTeamMembership: async () => undefined,
}));
