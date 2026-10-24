import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { notificationDelivery, project, teamInvite, teamMember, user } from '@repo/db';
import { createTestDb, seedProject, type TestDb } from '#tests/helpers/d1';

// Only what these suites do not exercise is replaced: the invite TTL, the address policy
// and the instance mail configuration live outside the module.
vi.mock('@repo/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@repo/auth')>()),
  inviteValidSince: async () => null,
  getAuthSettings: async () => ({ inviteTtlDays: 0 }),
}));
vi.mock('#modules/invites/email-policy', () => ({ isInviteEmailAllowed: async () => true }));
vi.mock('@repo/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@repo/db')>()),
  getInstanceEmailConfig: async () => ({ provider: 'smtp' }),
}));
vi.mock('@repo/mailer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@repo/mailer')>()),
  hasEmailProvider: () => true,
}));

const { createInvite, acceptInvite, getInviteById } = await import('../service');
const { enqueueInviteEmail } = await import('../email');

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.dispose());

function input(s: { teamId: number; projectId: number; userId: string }, email: string) {
  return {
    teamId: s.teamId,
    projectId: s.projectId,
    email,
    teamRole: 'member' as const,
    projectRole: 'member' as const,
    roleId: null,
    invitedByUserId: s.userId,
  };
}

describe('createInvite', () => {
  it('lets exactly one of N simultaneous invites for one address through', async () => {
    const s = await seedProject(t.db, { key: 'INV1', userId: 'inv-owner-1' });
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => createInvite(t.db, input(s, 'Racer@Example.com'))),
    );
    const refused = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(refused).toHaveLength(7);
    for (const r of refused) {
      expect(r.reason).toMatchObject({ status: 409, code: 'INVITE_ALREADY_PENDING' });
    }
    const rows = await t.db.select().from(teamInvite).where(eq(teamInvite.projectId, s.projectId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.email).toBe('racer@example.com');
  });
});

describe('acceptInvite', () => {
  it('joins the team and the project and marks the invite accepted', async () => {
    const s = await seedProject(t.db, { key: 'INV2', userId: 'inv-owner-2' });
    await t.db.insert(user).values({ id: 'invitee-2', name: 'i', email: 'invitee2@example.com' });
    const invite = await createInvite(t.db, input(s, 'invitee2@example.com'));
    const accepted = await acceptInvite(
      t.db,
      {
        id: invite.id,
        teamId: s.teamId,
        projectId: s.projectId,
        teamRole: 'member',
        projectRole: 'member',
        roleId: null,
      },
      'invitee-2',
    );
    expect(accepted.projectKey).toBe('INV2');
    const members = await t.db
      .select()
      .from(teamMember)
      .where(and(eq(teamMember.teamId, s.teamId), eq(teamMember.userId, 'invitee-2')));
    expect(members).toHaveLength(1);
    expect((await getInviteById(t.db, invite.id))!.status).toBe('accepted');
  });
});

describe('enqueueInviteEmail', () => {
  it('queues one email for N simultaneous clicks', async () => {
    const s = await seedProject(t.db, { key: 'INV3', userId: 'inv-owner-3' });
    const invite = await createInvite(t.db, input(s, 'mail3@example.com'));
    const [p] = await t.db
      .select({ id: project.id, name: project.name })
      .from(project)
      .where(eq(project.id, s.projectId));
    await Promise.all(Array.from({ length: 6 }, () => enqueueInviteEmail(t.db, p!, invite)));
    const rows = await t.db
      .select()
      .from(notificationDelivery)
      .where(eq(notificationDelivery.projectId, s.projectId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.recipient).toBe('mail3@example.com');
    expect((rows[0]!.payload as { dedupeKey: string }).dedupeKey).toBe(
      `project-invite:${invite.id}`,
    );
  });
});
