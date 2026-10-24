import { getInstanceEmailConfig, team, type Db } from '@repo/db';
import { trustedOrigins } from '@repo/auth';
import { emailBody, hasEmailProvider, sendEmail } from '@repo/mailer';
import { eq, sql } from 'drizzle-orm';
import type { InviteRow } from './service';

interface InviteProject {
  id: number;
  name: string;
}

export async function enqueueInviteEmail(
  db: Db,
  project: InviteProject,
  invite: InviteRow,
): Promise<boolean> {
  const config = await getInstanceEmailConfig(db);
  if (!config || !hasEmailProvider(config)) return false;

  const dedupeKey = `project-invite:${invite.id}`;
  const inviter = invite.invitedByName ?? invite.invitedByEmail ?? "An It's a Plan user";
  const role = invite.role === 'owner' ? 'owner' : (invite.roleName ?? 'member');
  const projectName = project.name.replace(/[\r\n]+/g, ' ');
  const url = new URL(`/invite/${invite.token}`, trustedOrigins[0]).toString();

  // One INSERT ... WHERE NOT EXISTS: D1 runs it as a single statement, so two clicks
  // arriving together cannot both observe an empty outbox and queue the same email.
  const payload = JSON.stringify({
    subject: `You were invited to ${projectName} on It's a Plan`,
    text:
      `${inviter} invited you to join ${projectName} as ${role}.

` +
      'Open the invitation to sign in or create an account. ' +
      'If you did not expect this invitation, you can ignore this email.',
    url,
    emailSource: 'instance',
    idempotencyKey: `project-invite/${invite.id}/${crypto.randomUUID()}`,
    dedupeKey,
    projectInviteId: invite.id,
  });
  await db.run(sql`
    insert into notification_delivery (project_id, channel, recipient, payload)
    select ${project.id}, 'email', ${invite.email}, ${payload}
    where not exists (
      select 1 from notification_delivery
      where project_id = ${project.id}
        and channel = 'email'
        and recipient = ${invite.email}
        and status = 'pending'
        and json_extract(payload, '$.dedupeKey') = ${dedupeKey}
    )
  `);
  return true;
}

// A team invite names no project, and the notification outbox belongs to one, so it
// cannot be queued there. It is sent at once instead, as the sign-in emails are:
// best effort, without the outbox's retries. A failure leaves the link to be copied.
export async function sendTeamInviteEmail(
  db: Db,
  teamId: number,
  invite: InviteRow,
): Promise<boolean> {
  const config = await getInstanceEmailConfig(db);
  if (!config || !hasEmailProvider(config)) return false;

  const [row] = await db.select({ name: team.name }).from(team).where(eq(team.id, teamId));
  const teamName = (row?.name ?? 'a team').replace(/[\r\n]+/g, ' ');
  const inviter = invite.invitedByName ?? invite.invitedByEmail ?? "An It's a Plan user";
  const { text, html } = emailBody(
    `${inviter} invited you to join the team ${teamName} as ${invite.teamRole}.\n\n` +
      'Open the invitation to sign in or create an account. ' +
      'If you did not expect this invitation, you can ignore this email.',
    `${trustedOrigins[0]}/invite/${invite.token}`,
  );
  const result = await sendEmail(config, {
    to: invite.email,
    subject: `You were invited to ${teamName} on It's a Plan`,
    text,
    html,
  });
  if (!result.ok) console.error('[invites] team invite email failed:', result.error);
  return result.ok;
}
