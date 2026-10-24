import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiKeyApi, authedApi, createProject } from '../../../helpers/app';
import { signUpTestUser } from '../../../helpers/auth';
import { createAgent } from '../../../helpers/agents';
import { db } from '../../../helpers/db';
import { getRunnerAgent, takeNextRun } from '#modules/agents/runner/service';
import { dispatchInvocations } from '#modules/agents/invocation/service';

// The set of agents being dispatched lives in one isolate, so it cannot stop a second
// isolate. What does is the claim itself, a single conditional UPDATE in the database.

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
  beforeEach(() => {
    process.env.SSRF_DEV_RELAXED = '1';
  });
  afterEach(() => {
    delete process.env.SSRF_DEV_RELAXED;
    vi.unstubAllGlobals();
  });

  it('hands one pending run to exactly one of two concurrent claims', async () => {
    const { agent } = await agentWithOneRun();
    const runner = (await getRunnerAgent(db, agent.userId))!;
    const claims = await Promise.all([takeNextRun(db, runner), takeNextRun(db, runner)]);
    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
  });

  it('sends a run to the endpoint once when two passes race', async () => {
    const received: string[] = [];
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      received.push(String(init?.body));
      return new Response('ok');
    });
    await agentWithOneRun('http://127.0.0.1:9/agent');
    await Promise.all([dispatchInvocations(db), dispatchInvocations(db)]);
    expect(received).toHaveLength(1);
  });
});
