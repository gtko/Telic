import { registrationEmailAllowed } from '@repo/auth';
import type { Db } from '@repo/db';

export type InviteEmailPolicy = (
  db: Db,
  teamId: number,
  email: string,
  hasAccount: boolean,
) => Promise<boolean>;

const couldJoin: InviteEmailPolicy = async (db, _teamId, email, hasAccount) =>
  hasAccount || registrationEmailAllowed(db, email);

// Whether a team takes an invite for an address: one with an account always, one without
// only if it could register. A build that lets a workspace keep domains of its own checks
// the address against the domains of the team's workspace.
let policy = couldJoin;

export function setInviteEmailPolicy(next = couldJoin): void {
  policy = next;
}

export function isInviteEmailAllowed(
  db: Db,
  teamId: number,
  email: string,
  hasAccount: boolean,
): Promise<boolean> {
  return policy(db, teamId, email, hasAccount);
}
