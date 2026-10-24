// The SQLite port of the Postgres triggers (drizzle-d1/0001_triggers.sql): the revision engine
// behind GET /sync/rev, the project validation of document links and the document snapshots.
// Runs the committed migrations on a local D1 (miniflare), like d1.test.ts.
import { eq, sql } from 'drizzle-orm';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../client';
import { migrateD1 } from '../migrate';
import {
  cycle,
  initiative,
  issue,
  issueAttachment,
  issueLabel,
  label,
  notification,
  project,
  projectColumn,
  projectDocument,
  projectDocumentInitiative,
  projectDocumentIssue,
  projectDocumentRevision,
  revision,
  team,
  triggerFlag,
  user,
} from '../schema';
import { createWorkspace } from '../workspace';

let mf: Miniflare;
let db: Db;
let counter = 0;
let workspaceId: number;
let teamId: number;

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: 'triggers-db' },
  });
  db = createDb((await mf.getD1Database('DB')) as unknown as D1Database);
  await migrateD1(db);
  await db.insert(user).values({ id: 'u1', name: 'Ada', email: 'ada@example.com' });
  await db.insert(user).values({ id: 'u2', name: 'Bob', email: 'bob@example.com' });
  workspaceId = await createWorkspace(db, 'Acme', 'u1');
  [{ id: teamId }] = await db
    .insert(team)
    .values({ workspaceId, name: 'Core' })
    .returning({ id: team.id });
});

afterAll(async () => {
  await mf.dispose();
});

// ---- helpers -------------------------------------------------------------------------------

async function mkProject() {
  const n = ++counter;
  const [p] = await db
    .insert(project)
    .values({ teamId, key: `P${n}`, name: `Project ${n}` })
    .returning({ id: project.id });
  const [c] = await db
    .insert(projectColumn)
    .values({ projectId: p!.id, name: 'Todo', position: 0 })
    .returning({ id: projectColumn.id });
  return { projectId: p!.id, columnId: c!.id };
}

let seq = 0;
async function mkIssue(
  p: { projectId: number; columnId: number },
  extra: Partial<typeof issue.$inferInsert> = {},
) {
  const [row] = await db
    .insert(issue)
    .values({
      projectId: p.projectId,
      columnId: p.columnId,
      sequenceNumber: ++seq,
      title: `Issue ${seq}`,
      ...extra,
    })
    .returning({ id: issue.id });
  return row!.id;
}

async function mkInitiative(projectId: number) {
  const [row] = await db
    .insert(initiative)
    .values({ projectId, title: `Initiative ${++seq}` })
    .returning({ id: initiative.id });
  return row!.id;
}

async function rev(scope: string): Promise<number | null> {
  const [row] = await db
    .select({ rev: revision.rev })
    .from(revision)
    .where(eq(revision.scope, scope));
  return row?.rev ?? null;
}

// The revisions of one project, as `scope -> rev`.
async function revisionsOf(projectId: number): Promise<Record<string, number>> {
  const rows = await db.select().from(revision).where(eq(revision.projectId, projectId));
  return Object.fromEntries(rows.map((r) => [r.scope, r.rev]));
}

// drizzle wraps the driver error ("Failed query: ..."), so the RAISE message sits in the cause.
async function rejectsWith(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, 'the statement should have been rejected').not.toBeNull();
  const messages: string[] = [];
  for (let e = error as { message?: string; cause?: unknown } | undefined; e;) {
    messages.push(String(e.message));
    e = e.cause as typeof e;
  }
  expect(messages.join(' | ')).toMatch(pattern);
}

// ---- trigger inventory (the CI guard) ----------------------------------------------------------

// The 29 Postgres triggers of legacy-pg, by their pg name, with the operations each fires on.
const EXPECTED: Record<string, string[]> = {
  issue_rev: ['i', 'u', 'd'],
  issue_label_rev: ['i', 'u', 'd'],
  issue_link_rev: ['i', 'u', 'd'],
  issue_field_value_rev: ['i', 'u', 'd'],
  issue_field_option_rev: ['i', 'u', 'd'],
  issue_attachment_rev: ['i', 'u', 'd'],
  issue_checklist_rev: ['i', 'u', 'd'],
  issue_watcher_rev: ['i', 'u', 'd'],
  issue_cycle_rev: ['i', 'u', 'd'],
  issue_development_link_rev: ['i', 'u', 'd'],
  issue_checklist_item_rev: ['i', 'u', 'd'],
  issue_development_check_rev: ['i', 'u', 'd'],
  issue_activity_rev: ['i', 'u', 'd'],
  initiative_rev: ['i', 'u', 'd'],
  initiative_label_rev: ['i', 'u', 'd'],
  initiative_attachment_rev: ['i', 'u', 'd'],
  cycle_rev: ['i', 'u', 'd'],
  notification_rev: ['i', 'u', 'd'],
  project_rev_cleanup: ['d'],
  project_document_rev: ['i', 'u', 'd'],
  document_asset_rev: ['i', 'u', 'd'],
  project_document_preference_rev: ['i', 'u', 'd'],
  document_comment_rev: ['i', 'u', 'd'],
  project_document_issue_rev: ['i', 'd'],
  project_document_initiative_rev: ['i', 'd'],
  project_document_issue_validate_project: ['i', 'u'],
  project_document_initiative_validate_project: ['i', 'u'],
  project_document_owner_default: ['i'],
  project_document_revision_capture: ['i', 'u'],
};
const EXPECTED_PHYSICAL = 78;

describe('trigger inventory', () => {
  // drizzle-kit drops the triggers of a table it rebuilds (DROP TABLE + CREATE + copy). A
  // migration that does so must re-create them, and this test fails until it does.
  it('has every ported trigger after a full migration, and nothing else', async () => {
    const rows = await db.all<{ name: string; tbl_name: string }>(
      sql`SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger' ORDER BY name`,
    );
    expect(rows).toHaveLength(EXPECTED_PHYSICAL);
    const found: Record<string, string[]> = {};
    for (const { name } of rows) {
      const m = /^(.*)_([iud])$/.exec(name);
      expect(m, `trigger ${name} has an operation suffix`).not.toBeNull();
      (found[m![1]!] ??= []).push(m![2]!);
    }
    for (const ops of Object.values(found)) ops.sort().reverse(); // i, u, d order
    const expected = Object.fromEntries(
      Object.entries(EXPECTED).map(([k, v]) => [k, [...v].sort().reverse()]),
    );
    expect(found).toEqual(expected);
    expect(Object.keys(EXPECTED)).toHaveLength(29);
  });

  it('seeds the default storage setting once', async () => {
    const rows = await db.all<{ value: string }>(
      sql`SELECT value FROM app_setting WHERE key = 'storage'`,
    );
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.value)).toMatchObject({
      maxAttachmentMb: 25,
      projectQuotaMb: 51200,
    });
  });
});

// ---- revision engine -------------------------------------------------------------------------

describe('revision engine', () => {
  it('moves the board and issue markers on every write to an issue', async () => {
    const p = await mkProject();
    const id = await mkIssue(p);
    expect(await rev(`board:${p.projectId}`)).toBe(1);
    expect(await rev(`issue:${id}`)).toBe(1);

    await db.update(issue).set({ title: 'Renamed' }).where(eq(issue.id, id));
    expect(await rev(`board:${p.projectId}`)).toBe(2);
    expect(await rev(`issue:${id}`)).toBe(2);
    // the revision rows carry the project (the membership join of /sync/rev reads it)
    expect((await revisionsOf(p.projectId))[`issue:${id}`]).toBe(2);
  });

  it('moves board, issue and initiative markers; an issue changing initiative moves both', async () => {
    const p = await mkProject();
    const a = await mkInitiative(p.projectId);
    const b = await mkInitiative(p.projectId);
    const id = await mkIssue(p, { initiativeId: a });
    const aBefore = (await rev(`initiative:${a}`))!;
    const bBefore = (await rev(`initiative:${b}`))!;

    await db.update(issue).set({ initiativeId: b }).where(eq(issue.id, id));
    expect(await rev(`initiative:${a}`)).toBe(aBefore + 1);
    expect(await rev(`initiative:${b}`)).toBe(bBefore + 1);

    // a plain edit of the issue moves only the initiative it is in
    await db.update(issue).set({ title: 'x' }).where(eq(issue.id, id));
    expect(await rev(`initiative:${a}`)).toBe(aBefore + 1);
    expect(await rev(`initiative:${b}`)).toBe(bBefore + 2);
  });

  it('moves both boards and re-homes the issue scope when an issue changes project', async () => {
    const from = await mkProject();
    const to = await mkProject();
    const id = await mkIssue(from);
    const fromBoard = (await rev(`board:${from.projectId}`))!;
    const toBoard = await rev(`board:${to.projectId}`);
    expect(toBoard).toBeNull();

    await db
      .update(issue)
      .set({ projectId: to.projectId, columnId: to.columnId })
      .where(eq(issue.id, id));
    expect(await rev(`board:${from.projectId}`)).toBe(fromBoard + 1);
    expect(await rev(`board:${to.projectId}`)).toBe(1);
    const moved = await revisionsOf(to.projectId);
    expect(moved[`issue:${id}`]).toBeGreaterThan(1);
    expect((await revisionsOf(from.projectId))[`issue:${id}`]).toBeUndefined();
  });

  it('distinguishes board children from detail-only children', async () => {
    const p = await mkProject();
    const id = await mkIssue(p);
    const [l] = await db
      .insert(label)
      .values({ projectId: p.projectId, name: 'bug' })
      .returning({ id: label.id });
    const board = (await rev(`board:${p.projectId}`))!;
    const detail = (await rev(`issue:${id}`))!;

    await db.insert(issueLabel).values({ issueId: id, labelId: l!.id }); // 'board' child
    expect(await rev(`board:${p.projectId}`)).toBe(board + 1);
    expect(await rev(`issue:${id}`)).toBe(detail + 1);

    await db.insert(issueAttachment).values({
      issueId: id,
      s3Key: 'k',
      filename: 'f.txt',
      contentType: 'text/plain',
      sizeBytes: 3,
    }); // 'detail' child: the board does not show attachments
    expect(await rev(`board:${p.projectId}`)).toBe(board + 1);
    expect(await rev(`issue:${id}`)).toBe(detail + 2);

    await db.delete(issueLabel).where(eq(issueLabel.issueId, id));
    expect(await rev(`board:${p.projectId}`)).toBe(board + 2);
  });

  it('keeps a user inbox, a cycle and the initiative board separate', async () => {
    const p = await mkProject();
    const id = await mkIssue(p);
    await db.insert(notification).values({
      userId: 'u1',
      projectId: p.projectId,
      issueId: id,
      type: 'assigned',
    });
    expect(await rev(`inbox:${p.projectId}:u1`)).toBe(1);
    expect(await rev(`inbox:${p.projectId}:u2`)).toBeNull();

    const board = (await rev(`board:${p.projectId}`))!;
    await db.insert(cycle).values({
      projectId: p.projectId,
      name: 'C1',
      startDate: '2026-01-01',
      endDate: '2026-01-14',
    });
    expect(await rev(`board:${p.projectId}`)).toBe(board + 1);
    await mkInitiative(p.projectId);
    expect(await rev(`board:${p.projectId}`)).toBe(board + 2);
  });

  it('drops the issue marker with the issue, and every marker with the project', async () => {
    const p = await mkProject();
    const a = await mkIssue(p);
    const b = await mkIssue(p);
    await mkInitiative(p.projectId);
    await db.insert(notification).values({
      userId: 'u1',
      projectId: p.projectId,
      issueId: a,
      type: 'assigned',
    });

    await db.delete(issue).where(eq(issue.id, a));
    const left = await revisionsOf(p.projectId);
    expect(left[`issue:${a}`]).toBeUndefined();
    expect(left[`issue:${b}`]).toBeDefined();

    // The cascade deletes the issues, which would re-insert board rows for a project that is
    // gone; the guards and the AFTER DELETE cleanup leave nothing behind.
    await db.delete(project).where(eq(project.id, p.projectId));
    expect(await revisionsOf(p.projectId)).toEqual({});
  });

  it('a revision write inside one batch is atomic with the data write (rolls back together)', async () => {
    const p = await mkProject();
    const id = await mkIssue(p);
    const before = await rev(`issue:${id}`);
    await expect(
      db.batch([
        db.update(issue).set({ title: 'will roll back' }).where(eq(issue.id, id)),
        db.insert(user).values({ id: 'u1', name: 'dup', email: 'ada@example.com' }), // violates a unique key
      ]),
    ).rejects.toThrow();
    expect(await rev(`issue:${id}`)).toBe(before);
    const [row] = await db.select({ title: issue.title }).from(issue).where(eq(issue.id, id));
    expect(row!.title).not.toBe('will roll back');
  });

  it('counts concurrent writers without losing a bump', async () => {
    const p = await mkProject();
    const id = await mkIssue(p);
    const before = (await rev(`issue:${id}`))!;
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        db
          .update(issue)
          .set({ title: `t${i}` })
          .where(eq(issue.id, id)),
      ),
    );
    expect(await rev(`issue:${id}`)).toBe(before + 20);
  });
});

// ---- project validation of document links ----------------------------------------------------------

describe('document links stay inside one project', () => {
  async function mkDocument(projectId: number) {
    const [row] = await db
      .insert(projectDocument)
      .values({ projectId, title: 'Doc', createdByUserId: 'u1' })
      .returning({ id: projectDocument.id });
    return row!.id;
  }

  it('accepts a document and a work item of the same project', async () => {
    const p = await mkProject();
    const doc = await mkDocument(p.projectId);
    const id = await mkIssue(p);
    await db.insert(projectDocumentIssue).values({ documentId: doc, issueId: id });
    expect(await rev(`documents:${p.projectId}`)).toBeGreaterThan(0);
    expect(await rev(`issue:${id}`)).toBeGreaterThan(1);
  });

  it('rejects a work item of another project, on insert and on update', async () => {
    const p = await mkProject();
    const other = await mkProject();
    const doc = await mkDocument(p.projectId);
    const mine = await mkIssue(p);
    const foreign = await mkIssue(other);
    await rejectsWith(
      db.insert(projectDocumentIssue).values({ documentId: doc, issueId: foreign }),
      /must stay inside one project/,
    );

    await db.insert(projectDocumentIssue).values({ documentId: doc, issueId: mine });
    await rejectsWith(
      db
        .update(projectDocumentIssue)
        .set({ issueId: foreign })
        .where(eq(projectDocumentIssue.documentId, doc)),
      /must stay inside one project/,
    );
    const links = await db
      .select()
      .from(projectDocumentIssue)
      .where(eq(projectDocumentIssue.documentId, doc));
    expect(links.map((l) => l.issueId)).toEqual([mine]);
  });

  it('rejects an initiative of another project, accepts one of the same project', async () => {
    const p = await mkProject();
    const other = await mkProject();
    const doc = await mkDocument(p.projectId);
    const mine = await mkInitiative(p.projectId);
    const foreign = await mkInitiative(other.projectId);
    await rejectsWith(
      db.insert(projectDocumentInitiative).values({ documentId: doc, initiativeId: foreign }),
      /must stay inside one project/,
    );
    const before = (await rev(`initiative:${mine}`))!;
    await db.insert(projectDocumentInitiative).values({ documentId: doc, initiativeId: mine });
    expect(await rev(`initiative:${mine}`)).toBe(before + 1);
  });
});

// ---- document snapshots ------------------------------------------------------------------------------

describe('document snapshots', () => {
  const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
  const MIN = 60_000;

  async function versions(documentId: number) {
    const rows = await db
      .select({
        version: projectDocumentRevision.version,
        content: projectDocumentRevision.content,
      })
      .from(projectDocumentRevision)
      .where(eq(projectDocumentRevision.documentId, documentId))
      .orderBy(projectDocumentRevision.version);
    return rows;
  }

  async function edit(
    id: number,
    version: number,
    at: number,
    by: string,
    content: string,
  ): Promise<void> {
    await db
      .update(projectDocument)
      .set({ content, version, updatedByUserId: by, updatedAt: new Date(at) })
      .where(eq(projectDocument.id, id));
  }

  async function mkDoc(projectId: number, createdBy = 'u1') {
    const [row] = await db
      .insert(projectDocument)
      .values({
        projectId,
        title: 'Page',
        content: 'v1',
        createdByUserId: createdBy,
        createdAt: new Date(T0),
        updatedAt: new Date(T0),
      })
      .returning({ id: projectDocument.id });
    return row!.id;
  }

  it('gives the creator ownership and a first snapshot carrying it', async () => {
    const p = await mkProject();
    const id = await mkDoc(p.projectId);
    const [doc] = await db.select().from(projectDocument).where(eq(projectDocument.id, id));
    expect(doc!.ownerUserId).toBe('u1');
    const [snap] = await db
      .select()
      .from(projectDocumentRevision)
      .where(eq(projectDocumentRevision.documentId, id));
    expect(snap).toMatchObject({
      version: 1,
      content: 'v1',
      ownerUserId: 'u1',
      createdByUserId: 'u1',
    });
    expect(await versions(id)).toHaveLength(1);
  });

  it('keeps an explicit owner', async () => {
    const p = await mkProject();
    const [row] = await db
      .insert(projectDocument)
      .values({ projectId: p.projectId, createdByUserId: 'u1', ownerUserId: 'u2' })
      .returning({ id: projectDocument.id });
    const [doc] = await db.select().from(projectDocument).where(eq(projectDocument.id, row!.id));
    expect(doc!.ownerUserId).toBe('u2');
  });

  it('merges consecutive edits by one author within ten minutes into one snapshot', async () => {
    const p = await mkProject();
    const id = await mkDoc(p.projectId);
    await edit(id, 2, T0 + 1 * MIN, 'u1', 'v2');
    expect((await versions(id)).map((v) => v.version)).toEqual([1, 2]); // not mergeable yet
    await edit(id, 3, T0 + 2 * MIN, 'u1', 'v3'); // merges into the v2 snapshot
    await edit(id, 4, T0 + 3 * MIN, 'u1', 'v4');
    expect(await versions(id)).toEqual([
      { version: 1, content: 'v1' },
      { version: 4, content: 'v4' },
    ]);
  });

  it('does not merge across authors, after ten minutes, or at a checkpoint', async () => {
    const p = await mkProject();
    const id = await mkDoc(p.projectId);
    await edit(id, 2, T0 + 1 * MIN, 'u1', 'v2');
    await edit(id, 3, T0 + 2 * MIN, 'u2', 'v3'); // another author
    expect((await versions(id)).map((v) => v.version)).toEqual([1, 2, 3]);
    await edit(id, 4, T0 + 3 * MIN, 'u2', 'v4'); // same author, merges into v3
    expect((await versions(id)).map((v) => v.version)).toEqual([1, 2, 4]);
    await edit(id, 5, T0 + 20 * MIN, 'u2', 'v5'); // more than ten minutes later
    expect((await versions(id)).map((v) => v.version)).toEqual([1, 2, 4, 5]);

    await db.insert(triggerFlag).values({ name: 'document_checkpoint' });
    await edit(id, 6, T0 + 21 * MIN, 'u2', 'v6');
    await db.delete(triggerFlag).where(eq(triggerFlag.name, 'document_checkpoint'));
    expect((await versions(id)).map((v) => v.version)).toEqual([1, 2, 4, 5, 6]);
  });

  it('keeps only the newest twenty snapshots', async () => {
    const p = await mkProject();
    const id = await mkDoc(p.projectId);
    await db.insert(triggerFlag).values({ name: 'document_checkpoint' });
    for (let v = 2; v <= 25; v++) await edit(id, v, T0 + v * 30 * MIN, 'u1', `v${v}`);
    await db.delete(triggerFlag).where(eq(triggerFlag.name, 'document_checkpoint'));
    const kept = (await versions(id)).map((v) => v.version);
    expect(kept).toHaveLength(20);
    expect(kept[0]).toBe(6);
    expect(kept.at(-1)).toBe(25);
  });

  it('ignores a same-version write that changes nothing, and a bulk rebalance', async () => {
    const p = await mkProject();
    const id = await mkDoc(p.projectId);
    const docsRev = (await rev(`documents:${p.projectId}`))!;
    await db
      .update(projectDocument)
      .set({ updatedByUserId: 'u2' })
      .where(eq(projectDocument.id, id));
    expect(await versions(id)).toHaveLength(1); // payload unchanged: no new snapshot

    await db.insert(triggerFlag).values({ name: 'document_rebalance' });
    await db
      .update(projectDocument)
      .set({ position: 5, version: 2 })
      .where(eq(projectDocument.id, id));
    await db.delete(triggerFlag).where(eq(triggerFlag.name, 'document_rebalance'));
    expect(await versions(id)).toHaveLength(1); // rebalance: no snapshot
    // ... and no documents marker bump (the unrelated updatedBy write above did bump it once)
    expect(await rev(`documents:${p.projectId}`)).toBe(docsRev + 1);
  });

  it('moves the documents marker for a document and its children', async () => {
    const p = await mkProject();
    const before = await rev(`documents:${p.projectId}`);
    expect(before).toBeNull();
    const id = await mkDoc(p.projectId);
    // the insert fires project_document_rev, then the owner default UPDATE fires it again
    expect(await rev(`documents:${p.projectId}`)).toBeGreaterThanOrEqual(1);
    const after = (await rev(`documents:${p.projectId}`))!;
    await db.delete(projectDocument).where(eq(projectDocument.id, id));
    expect(await rev(`documents:${p.projectId}`)).toBe(after + 1);
  });
});
