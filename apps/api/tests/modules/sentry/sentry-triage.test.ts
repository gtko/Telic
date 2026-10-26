import { afterEach, describe, it, expect, vi } from 'vitest';
import { createProject, type Api } from '../../helpers/app';
import {
  columnIds,
  deliverSentry,
  mockSentryFetch,
  restoreFetch,
  sentryIssue,
  setupRoutedProject,
  triageIssues,
} from '../../helpers/sentry';

// Triage of the issues in the Triage column: accept, reject and merge move them out of it,
// and a Sentry issue linked to a merged one follows the target.

// An issue of the MKT project created outside triage.
async function plainIssue(asOwner: Api, columnId: number, title: string, projectKey = 'MKT') {
  const res = await asOwner.projects({ projectKey }).issues.post({ columnId, title });
  return res.data!;
}

// Delivers a new Sentry issue and returns the Telic issue it created.
async function triagedIssue(asOwner: Api, sentryId: string) {
  await deliverSentry(sentryIssue(sentryId));
  const issues = await triageIssues(asOwner);
  return issues.find((issue) => issue.title.endsWith(sentryId))!;
}

describe('sentry triage', () => {
  it('accepts a triaged issue into the backlog', async () => {
    const { asOwner } = await setupRoutedProject();
    const issue = await triagedIssue(asOwner, '1001');
    const columns = await columnIds(asOwner);

    const res = await asOwner
      .projects({ projectKey: 'MKT' })
      .triage({ issueId: issue.id })
      .accept.post();
    expect(res).toMatchObject({ status: 200, data: { id: issue.id, columnId: columns.backlog } });
    expect(await triageIssues(asOwner)).toEqual([]);
  });

  it('rejects a triaged issue into the canceled column', async () => {
    const { asOwner } = await setupRoutedProject();
    const issue = await triagedIssue(asOwner, '1002');
    const columns = await columnIds(asOwner);

    const res = await asOwner
      .projects({ projectKey: 'MKT' })
      .triage({ issueId: issue.id })
      .reject.post();
    expect(res).toMatchObject({ status: 200, data: { id: issue.id, columnId: columns.canceled } });
    expect(await triageIssues(asOwner)).toEqual([]);
  });

  it('refuses to accept or reject an issue that is not in triage', async () => {
    const { asOwner } = await setupRoutedProject();
    const columns = await columnIds(asOwner);
    const plain = await plainIssue(asOwner, columns.backlog, 'Plain task');
    const triage = asOwner.projects({ projectKey: 'MKT' }).triage({ issueId: plain.id });

    expect((await triage.accept.post()).status).toBe(400);
    expect((await triage.reject.post()).status).toBe(400);
  });

  it('merges a triaged issue into a target as its duplicate and cancels it', async () => {
    const { asOwner } = await setupRoutedProject();
    const columns = await columnIds(asOwner);
    const target = await plainIssue(asOwner, columns.backlog, 'Checkout target');
    const duplicate = await triagedIssue(asOwner, '1003');

    const res = await asOwner
      .projects({ projectKey: 'MKT' })
      .triage({ issueId: duplicate.id })
      .merge.post({ targetIssueId: target.id });
    expect(res).toMatchObject({
      status: 200,
      data: { id: duplicate.id, columnId: columns.canceled },
    });

    const detail = await asOwner.issues({ issueId: duplicate.id }).get();
    expect(detail.data!.links).toMatchObject([
      { kind: 'duplicates', direction: 'outward', issue: { id: target.id } },
    ]);
    expect(await triageIssues(asOwner)).toEqual([]);
  });

  it('moves the Sentry link of a merged issue to its target', async () => {
    const { asOwner } = await setupRoutedProject();
    const columns = await columnIds(asOwner);
    const target = await plainIssue(asOwner, columns.backlog, 'Checkout target');
    const duplicate = await triagedIssue(asOwner, '1004');
    await asOwner
      .projects({ projectKey: 'MKT' })
      .triage({ issueId: duplicate.id })
      .merge.post({ targetIssueId: target.id });
    await asOwner.issues({ issueId: target.id }).patch({ columnId: columns.completed });

    const res = await deliverSentry(sentryIssue('1004', { action: 'unresolved' }));
    expect(res).toMatchObject({ status: 200, data: { handled: 'reopened' } });
    expect(await triageIssues(asOwner)).toMatchObject([{ id: target.id }]);
  });

  it('refuses to merge an issue into itself', async () => {
    const { asOwner } = await setupRoutedProject();
    const issue = await triagedIssue(asOwner, '1005');

    const res = await asOwner
      .projects({ projectKey: 'MKT' })
      .triage({ issueId: issue.id })
      .merge.post({ targetIssueId: issue.id });
    expect(res.status).toBe(400);
    expect(await triageIssues(asOwner)).toMatchObject([{ id: issue.id }]);
  });

  it('refuses a merge target of another project', async () => {
    const { asOwner } = await setupRoutedProject();
    await createProject(asOwner, { key: 'OPS', name: 'Operations' });
    const opsColumns = await columnIds(asOwner, 'OPS');
    const elsewhere = await plainIssue(asOwner, opsColumns.backlog, 'Elsewhere', 'OPS');
    const issue = await triagedIssue(asOwner, '1006');

    const res = await asOwner
      .projects({ projectKey: 'MKT' })
      .triage({ issueId: issue.id })
      .merge.post({ targetIssueId: elsewhere.id });
    expect(res.status).toBe(404);
    expect(await triageIssues(asOwner)).toMatchObject([{ id: issue.id }]);
  });

  it('keeps a triaged issue out of the project list and search, and finds it by number', async () => {
    const { asOwner } = await setupRoutedProject();
    const columns = await columnIds(asOwner);
    const plain = await plainIssue(asOwner, columns.backlog, 'Checkout copy');
    const issue = await triagedIssue(asOwner, '1007');
    const project = asOwner.projects({ projectKey: 'MKT' });

    const list = await project.issues.get();
    const listed = list.data!.map((item) => item.id);
    expect(listed).toContain(plain.id);
    expect(listed).not.toContain(issue.id);

    const search = await project.issues.search.get({ query: { q: 'checkout' } });
    const found = search.data!.map((item) => item.id);
    expect(found).toContain(plain.id);
    expect(found).not.toContain(issue.id);

    const byNumber = await project.issues({ sequenceNumber: issue.sequenceNumber }).get();
    expect(byNumber.data).toMatchObject({ id: issue.id, columnId: issue.columnId });
  });
});

describe('sentry status sync', () => {
  afterEach(restoreFetch);

  it('resolves the linked Sentry issue when the issue moves to a completed column', async () => {
    const { asOwner } = await setupRoutedProject({ authToken: 'sentry-token' });
    const calls = mockSentryFetch(() => Response.json({}));
    const issue = await triagedIssue(asOwner, '2001');
    const columns = await columnIds(asOwner);

    const res = await asOwner.issues({ issueId: issue.id }).patch({ columnId: columns.completed });
    expect(res).toMatchObject({ status: 200, data: { columnId: columns.completed } });

    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].url).toBe('https://sentry.io/api/0/organizations/acme/issues/2001/');
    expect(calls[0].init?.method).toBe('PUT');
    expect(new Headers(calls[0].init?.headers).get('authorization')).toBe('Bearer sentry-token');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ status: 'resolved' });
  });

  it('ignores the linked Sentry issue when the issue is rejected', async () => {
    const { asOwner } = await setupRoutedProject({ authToken: 'sentry-token' });
    const calls = mockSentryFetch(() => Response.json({}));
    const issue = await triagedIssue(asOwner, '2002');

    const res = await asOwner
      .projects({ projectKey: 'MKT' })
      .triage({ issueId: issue.id })
      .reject.post();
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].url).toBe('https://sentry.io/api/0/organizations/acme/issues/2002/');
    expect(calls[0].init?.method).toBe('PUT');
    expect(new Headers(calls[0].init?.headers).get('authorization')).toBe('Bearer sentry-token');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ status: 'ignored' });
  });

  it('completes the move when Sentry answers with an error', async () => {
    const { asOwner } = await setupRoutedProject({ authToken: 'sentry-token' });
    const calls = mockSentryFetch(() => new Response('unavailable', { status: 500 }));
    const issue = await triagedIssue(asOwner, '2003');
    const columns = await columnIds(asOwner);

    const res = await asOwner.issues({ issueId: issue.id }).patch({ columnId: columns.completed });
    expect(res).toMatchObject({ status: 200, data: { columnId: columns.completed } });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
  });

  it('completes the reject when the Sentry request fails', async () => {
    const { asOwner } = await setupRoutedProject({ authToken: 'sentry-token' });
    const calls = mockSentryFetch(() => {
      throw new TypeError('fetch failed');
    });
    const issue = await triagedIssue(asOwner, '2004');
    const columns = await columnIds(asOwner);

    const res = await asOwner
      .projects({ projectKey: 'MKT' })
      .triage({ issueId: issue.id })
      .reject.post();
    expect(res).toMatchObject({ status: 200, data: { id: issue.id, columnId: columns.canceled } });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
  });
});
