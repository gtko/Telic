import { describe, it, expect } from 'vitest';
import {
  columnIds,
  deliverSentry,
  SENTRY_SLUG,
  sentryIssue,
  setupRoutedProject,
  triageIssues,
} from '../../helpers/sentry';

// The inbound Sentry webhook: a signed delivery creates one issue in the Triage column of
// the Telic project its Sentry project is routed to, and reopens a closed one on unresolved.

describe('sentry webhook', () => {
  it('refuses a delivery signed with another secret and creates no issue', async () => {
    const { asOwner } = await setupRoutedProject();
    const res = await deliverSentry(sentryIssue('101'), { secret: 'another-secret' });
    expect(res.status).toBe(401);
    expect(await triageIssues(asOwner)).toEqual([]);
  });

  it('refuses a delivery without a signature and creates no issue', async () => {
    const { asOwner } = await setupRoutedProject();
    const res = await deliverSentry(sentryIssue('102'), { signature: '' });
    expect(res.status).toBe(401);
    expect(await triageIssues(asOwner)).toEqual([]);
  });

  it('refuses a signature made with an empty key while no client secret is configured', async () => {
    const { god, asOwner, projectId } = await setupRoutedProject({ configure: false });
    await god.god.sentry.routes.put({ sentryProjectSlug: SENTRY_SLUG, projectId });
    const res = await deliverSentry(sentryIssue('103'), { secret: '' });
    expect(res.status).toBe(401);
    expect(await triageIssues(asOwner)).toEqual([]);
  });

  it('answers 200 and creates nothing for a Sentry project no Telic project is routed to', async () => {
    const { asOwner } = await setupRoutedProject();
    const res = await deliverSentry(sentryIssue('201', { slug: 'billing' }));
    expect(res).toMatchObject({ status: 200, data: { ok: true, handled: 'unrouted' } });
    expect(await triageIssues(asOwner)).toEqual([]);
  });

  it('creates a Bug in the Triage column for a new Sentry issue', async () => {
    const { asOwner } = await setupRoutedProject();
    const res = await deliverSentry(sentryIssue('301'));
    expect(res).toMatchObject({ status: 200, data: { handled: 'created' } });

    const view = await asOwner.projects({ projectKey: 'MKT' }).get();
    const bug = view.data!.issueTypes.find((type) => type.name === 'Bug')!;
    const triage = (await columnIds(asOwner)).triage;
    const [issue] = await triageIssues(asOwner);
    expect(issue).toMatchObject({
      title: 'TypeError in checkout 301',
      columnId: triage,
      typeId: bug.id,
    });
    expect(issue.description).toContain('Sentry: https://sentry.io/organizations/acme/issues/301/');
  });

  it('creates one issue for a Sentry issue delivered twice', async () => {
    const { asOwner } = await setupRoutedProject();
    await deliverSentry(sentryIssue('401'));
    const second = await deliverSentry(sentryIssue('401'));
    expect(second).toMatchObject({ status: 200, data: { handled: 'duplicate' } });

    const issues = await triageIssues(asOwner);
    expect(issues).toHaveLength(1);
    expect(issues[0].columnId).toBe((await columnIds(asOwner)).triage);
  });

  it('moves a closed linked issue back to Triage on an unresolved delivery', async () => {
    const { asOwner } = await setupRoutedProject();
    await deliverSentry(sentryIssue('501'));
    const [issue] = await triageIssues(asOwner);
    const columns = await columnIds(asOwner);
    await asOwner.issues({ issueId: issue.id }).patch({ columnId: columns.completed });
    expect(await triageIssues(asOwner)).toEqual([]);

    const res = await deliverSentry(sentryIssue('501', { action: 'unresolved' }));
    expect(res).toMatchObject({ status: 200, data: { handled: 'reopened' } });
    expect(await triageIssues(asOwner)).toMatchObject([{ id: issue.id, columnId: columns.triage }]);
  });

  it('leaves an open linked issue where it is on an unresolved delivery', async () => {
    const { asOwner } = await setupRoutedProject();
    await deliverSentry(sentryIssue('601'));
    const [issue] = await triageIssues(asOwner);

    const res = await deliverSentry(sentryIssue('601', { action: 'unresolved' }));
    expect(res).toMatchObject({ status: 200, data: { handled: 'kept' } });
    expect(await triageIssues(asOwner)).toMatchObject([{ id: issue.id }]);
  });

  it('answers unlinked for an unresolved delivery of a Sentry issue Telic never saw', async () => {
    const { asOwner } = await setupRoutedProject();
    const res = await deliverSentry(sentryIssue('701', { action: 'unresolved' }));
    expect(res).toMatchObject({ status: 200, data: { handled: 'unlinked' } });
    expect(await triageIssues(asOwner)).toEqual([]);
  });
});
