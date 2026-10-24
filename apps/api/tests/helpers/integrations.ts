import type { Api } from './app';

// Stores a credential on the team that owns a project — credentials live on the team,
// so a test that needs one for a project resolves its team first. Returns its id.
export async function createCredential(
  api: Api,
  projectKey: string,
  body: {
    integrationKey: string;
    label?: string | null;
    credential: Record<string, unknown>;
  },
): Promise<number> {
  const projects = await api.projects.get();
  const project = projects.data!.find((p) => p.key === projectKey)!;
  const res = await api.teams({ teamId: project.teamId }).integrations.post(body);
  return res.data!.id;
}
