import { describe, expect, it } from 'vitest';
import { apiKeyApi, authedApi, createProject } from '../../../helpers/app';
import { signUpTestUser } from '../../../helpers/auth';
import { createAgent } from '../../../helpers/agents';
import { db } from '../../../helpers/db';
import { getRunnerAgent, takeNextRun } from '#modules/agents/runner/service';

// The set of agents being dispatched lives in one isolate, so it cannot stop a second
// isolate. What does is the claim itself, a single conditional UPDATE in the database.
// The chat claim cannot be exercised yet: see HORS PERIMETRE in the ODY-296 report.

async function agentWithOneRun(invocationUrl?: string) {
  const owner = await signUpTestUser({ name: 'Owner' });
  const asOwner = authedApi(owner.cookie);
  await createProject(asOwner, { key: 'MKT', name: 'Marketing' });
  const view = await asOwner.projects({ projectKey: 'MKT' }).get();
  const created = await createAgent(asOwner, 'MKT', {
    name: 'Cloud Bot',
    username: 'cloud',
    kind: 'external',
    triggerOnMention: true,
    invocationUrl,
  });
  const issue = (
    await asOwner
      .projects({ projectKey: 'MKT' })
      .issues.post({ columnId: view.data!.columns[0].id, title: 'Landing page' })
  ).data!;
  await asOwner.issues({ issueId: issue.id }).comments.post({ body: 'please review @cloud' });
  return { agent: created.data!.agent, asAgent: apiKeyApi(created.data!.apiKey!) };
}

describe('claiming agent work from several isolates', () => {
  it('hands one pending run to exactly one of two concurrent claims', async () => {
    const { agent } = await agentWithOneRun();
    const runner = (await getRunnerAgent(db, agent.userId))!;
    const claims = await Promise.all([takeNextRun(db, runner), takeNextRun(db, runner)]);
    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
  });
});
