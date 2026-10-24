import { teamWorkspaceId, type Db } from '@repo/db';
import type { ProjectFeature } from './features';

// Ceilings on what one workspace may use across its teams, and the sections they may
// not use at all. A self-hosted instance has none: every number is 0, which reads as
// unlimited, and the checks that enforce them return before they count anything. The
// values come from a provider so a hosted build can install its own — reading the
// workspace's subscription instead of answering with the defaults — without touching
// the places that enforce them.

export interface Limits {
  maxTeams: number;
  // Distinct people across the workspace's teams.
  maxSeats: number;
  // Stored attachment bytes across the workspace's projects.
  maxStorageBytes: number;
  // Project sections the workspace cannot use. A blocked one reads as off however its
  // project has it stored, and cannot be turned back on.
  blockedFeatures: ProjectFeature[];
}

// What a self-hosted instance answers with, and the base a test or a hosted provider
// overrides fields on.
export const NO_LIMITS: Limits = {
  maxTeams: 0,
  maxSeats: 0,
  maxStorageBytes: 0,
  blockedFeatures: [],
};

type LimitsProvider = (db: Db, workspaceId: number) => Promise<Limits>;

let provider: LimitsProvider = async () => NO_LIMITS;

export function setLimitsProvider(next: LimitsProvider): void {
  provider = next;
}

export function getLimits(db: Db, workspaceId: number): Promise<Limits> {
  return provider(db, workspaceId);
}

export async function getTeamLimits(db: Db, teamId: number): Promise<Limits> {
  return provider(db, await teamWorkspaceId(teamId, db));
}

// How many workspaces one person may own. A self-hosted instance gives each person one;
// a hosted build raises it. 0 reads as unlimited, as in Limits.
let ownedWorkspaceLimit = 1;

export function setOwnedWorkspaceLimit(next = 1): void {
  ownedWorkspaceLimit = next;
}

export function getOwnedWorkspaceLimit(): number {
  return ownedWorkspaceLimit;
}
