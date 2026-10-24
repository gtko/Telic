// Concurrency invariants of the document tree, collaboration and attachment quota on D1
// (ODY-296 L3b): N parallel requests against a Miniflare D1, the way Workers isolates
// would race. Replaces what pg_advisory_xact_lock / FOR UPDATE guaranteed on Postgres.
import { createDb, setSetting, type Db } from '@repo/db';
import { migrateD1 } from '../../../../../../../packages/db/src/migrate';
import { Miniflare } from 'miniflare';
import { Transform } from '@tiptap/pm/transform';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAttachment, replaceAttachmentContent } from '#modules/attachments/service';
import { collaborationSchema } from '../../collaboration-schema';
import { openDocumentSession, saveDocumentSteps } from '../../collaboration';
import {
  archiveDocument,
  createDocument,
  deleteDocument,
  getDocument,
  listDocumentRevisions,
  restoreDocument,
  updateDocument,
} from '../../service';
import { d1Of } from '../../tree';

vi.mock('#shared/limits', () => ({ getLimits: async () => ({ maxStorageBytes: 0 }) }));

let mf: Miniflare;
let db: Db;
let projectId = 0;
const USER = 'u1';

async function all<T>(sql: string, ...params: Array<string | number>): Promise<T[]> {
  const result = await d1Of(db)
    .prepare(sql)
    .bind(...params)
    .all<T>();
  return result.results;
}

async function seedProject(key: string): Promise<number> {
  const d1 = d1Of(db);
  await d1.prepare("INSERT OR IGNORE INTO workspace (id, name) VALUES (1, 'W')").run();
  const team = await d1.prepare("INSERT INTO team (workspace_id, name) VALUES (1, 'T')").run();
  const project = await d1
    .prepare('INSERT INTO project (team_id, key, name) VALUES (?, ?, ?)')
    .bind(team.meta.last_row_id, key, key)
    .run();
  return project.meta.last_row_id;
}

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: 'tree-db' },
  });
  db = createDb((await mf.getD1Database('DB')) as unknown as D1Database);
  await migrateD1(db);
  await d1Of(db)
    .prepare("INSERT INTO user (id, name, email) VALUES ('u1', 'Ada', 'ada@example.com')")
    .run();
  projectId = await seedProject('DOC');
});

afterAll(async () => {
  await mf.dispose();
});

const create = (title: string, parentId: number | null = null) =>
  createDocument(db, { projectId, userId: USER, title, parentId });

async function activeSiblings(parentId: number | null) {
  return all<{ id: number; position: number }>(
    `SELECT id, position FROM project_document WHERE project_id = ? AND parent_id ${parentId === null ? 'IS NULL' : `= ${parentId}`} AND archived_at IS NULL`,
    projectId,
  );
}

async function assertNoCycleNorDuplicate() {
  const rows = await all<{ id: number; parent_id: number | null; position: number }>(
    'SELECT id, parent_id, position FROM project_document WHERE project_id = ?',
    projectId,
  );
  const parentOf = new Map(rows.map((r) => [r.id, r.parent_id]));
  for (const row of rows) {
    const seen = new Set<number>();
    for (let cur: number | null = row.id; cur !== null; cur = parentOf.get(cur) ?? null) {
      expect(seen.has(cur)).toBe(false);
      seen.add(cur);
    }
  }
  const keys = rows.map((r) => `${r.parent_id}:${r.position}`);
  expect(new Set(keys).size).toBe(keys.length);
}

describe('document tree on D1', () => {
  it('creates N documents in parallel with distinct positions, one history row each and a coherent marker', async () => {
    const N = 12;
    const before = await all<{ rev: number }>(
      'SELECT rev FROM revision WHERE scope = ?',
      `documents:${projectId}`,
    );
    const created = await Promise.all(Array.from({ length: N }, (_, i) => create(`doc ${i}`)));
    expect(new Set(created.map((d) => d.id)).size).toBe(N);
    const positions = created.map((d) => d.position);
    expect(new Set(positions).size).toBe(N);
    for (const d of created) {
      const revisions = await all(
        'SELECT id FROM project_document_revision WHERE document_id = ?',
        d.id,
      );
      expect(revisions).toHaveLength(1);
    }
    const [marker] = await all<{ rev: number }>(
      'SELECT rev FROM revision WHERE scope = ?',
      `documents:${projectId}`,
    );
    expect(marker!.rev - (before[0]?.rev ?? 0)).toBe(N);
    await assertNoCycleNorDuplicate();
  });

  it('keeps the tree acyclic when documents are moved under each other concurrently', async () => {
    const a = await create('A');
    const b = await create('B');
    const c = await create('C');
    const results = await Promise.allSettled([
      updateDocument(db, projectId, a.id, USER, { version: a.version, parentId: b.id }),
      updateDocument(db, projectId, b.id, USER, { version: b.version, parentId: c.id }),
      updateDocument(db, projectId, c.id, USER, { version: c.version, parentId: a.id }),
    ]);
    // Any subset may be refused, never all three accepted (that would be a cycle).
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeLessThan(3);
    await assertNoCycleNorDuplicate();
  });

  it('survives concurrent archive / restore / delete / move without cycle or duplicate position', async () => {
    const root = await create('root');
    const kids = await Promise.all([1, 2, 3, 4].map((i) => create(`kid ${i}`, root.id)));
    const fresh = await Promise.all(kids.map((k) => getDocument(db, projectId, k.id, USER)));
    await Promise.allSettled([
      archiveDocument(db, projectId, root.id, USER, root.version, true),
      updateDocument(db, projectId, fresh[0]!.id, USER, {
        version: fresh[0]!.version,
        parentId: null,
      }),
      updateDocument(db, projectId, fresh[1]!.id, USER, {
        version: fresh[1]!.version,
        title: 'renamed',
      }),
      deleteDocument(db, projectId, fresh[2]!.id, USER, fresh[2]!.version, true),
      create('late sibling', root.id),
    ]);
    await Promise.allSettled([
      restoreDocument(
        db,
        projectId,
        root.id,
        USER,
        (await getDocument(db, projectId, root.id, USER))!.version,
        true,
      ),
    ]);
    await assertNoCycleNorDuplicate();
    const siblings = await activeSiblings(null);
    expect(new Set(siblings.map((s) => s.position)).size).toBe(siblings.length);
  });

  it('rejects a stale version with a 409 instead of overwriting', async () => {
    const doc = await create('versioned');
    await updateDocument(db, projectId, doc.id, USER, { version: doc.version, title: 'v2' });
    await expect(
      updateDocument(db, projectId, doc.id, USER, { version: doc.version, title: 'stale' }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await getDocument(db, projectId, doc.id, USER))!.title).toBe('v2');
  });
});

describe('revision history (ports of the Postgres triggers)', () => {
  it('records a snapshot per structural change, coalesces quick content edits and prunes to 20', async () => {
    const doc = await create('history');
    let version = doc.version;
    // Structural changes (icon) always add a snapshot.
    for (let i = 0; i < 3; i += 1) {
      const next = await updateDocument(db, projectId, doc.id, USER, { version, icon: `i${i}` });
      version = next!.version;
    }
    expect(await listDocumentRevisions(db, projectId, doc.id, USER)).toHaveLength(4);
    // Content edits by the same actor in a row share a snapshot once two of them are in.
    for (let i = 0; i < 6; i += 1) {
      const next = await updateDocument(db, projectId, doc.id, USER, {
        version,
        content: `text ${i}`,
      });
      version = next!.version;
    }
    const afterEdits = (await listDocumentRevisions(db, projectId, doc.id, USER))!.length;
    expect(afterEdits).toBeGreaterThanOrEqual(5);
    expect(afterEdits).toBeLessThan(10);
    // Pruning keeps the newest 20.
    for (let i = 0; i < 14; i += 1) {
      const next = await updateDocument(db, projectId, doc.id, USER, { version, icon: `p${i}` });
      version = next!.version;
    }
    const revisions = await listDocumentRevisions(db, projectId, doc.id, USER);
    expect(revisions).toHaveLength(20);
    const [newest] = await all<{ version: number }>(
      'SELECT MAX(version) AS version FROM project_document_revision WHERE document_id = ?',
      doc.id,
    );
    expect(newest!.version).toBe(version);
  });
});

describe('collaboration steps', () => {
  it('serializes two simultaneous saves: one accepted, the other rebased or refused, never lost', async () => {
    const doc = await create('collab');
    const paragraph = (text: string) => ({
      type: 'doc',
      content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }],
    });
    const open = await openDocumentSession(db, projectId, doc.id, USER, {
      version: doc.version,
      contentJson: paragraph('base'),
    });
    const node = collaborationSchema.nodeFromJSON(open.contentJson);
    const stepFor = (text: string) => {
      const tr = new Transform(node);
      tr.insert(1, collaborationSchema.text(text));
      return tr.steps.map((s) => s.toJSON() as Record<string, unknown>);
    };
    const save = (clientId: string, text: string) =>
      saveDocumentSteps(db, projectId, doc.id, USER, {
        epoch: open.epoch,
        version: open.version,
        clientId,
        steps: stepFor(text),
        content: text,
      });
    const results = await Promise.allSettled([save('c1', 'X'), save('c2', 'Y')]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok.length).toBeGreaterThanOrEqual(1);
    const stored = (await getDocument(db, projectId, doc.id, USER))!;
    const text = JSON.stringify(stored.contentJson);
    // Every accepted save is in the document; a refused one is a clean 409.
    for (const [i, r] of results.entries()) {
      const marker = i === 0 ? 'X' : 'Y';
      if (r.status === 'fulfilled') expect(text).toContain(marker);
      else expect(r.reason).toMatchObject({ status: 409 });
    }
    const steps = await all<{ version: number }>(
      'SELECT version FROM document_collaboration_step WHERE document_id = ? ORDER BY version',
      doc.id,
    ).catch(() => [] as Array<{ version: number }>);
    const versions = steps.map((s) => s.version);
    expect(new Set(versions).size).toBe(versions.length);
  });
});

describe('attachment quota', () => {
  it('lets only the uploads that fit through when they race for the last bytes', async () => {
    const pid = await seedProject('QTA');
    const d1 = d1Of(db);
    const column = await d1
      .prepare("INSERT INTO project_column (project_id, name, position) VALUES (?, 'Todo', 1)")
      .bind(pid)
      .run();
    const issue = await d1
      .prepare(
        "INSERT INTO issue (project_id, sequence_number, column_id, title) VALUES (?, 1, ?, 'i')",
      )
      .bind(pid, column.meta.last_row_id)
      .run();
    const issueId = issue.meta.last_row_id;
    await setSetting(db, 'storage', {
      maxAttachmentMb: 50,
      maxAvatarMb: 2,
      attachmentMimeTypes: [],
      projectQuotaMb: 1,
    });
    const half = 400 * 1024; // 1 MB quota fits two of these, not three
    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        createAttachment(db, {
          projectId: pid,
          issueId,
          s3Key: `k/${i}`,
          filename: `f${i}`,
          contentType: 'text/plain',
          sizeBytes: half,
        }),
      ),
    );
    const accepted = attempts.filter((r) => r.status === 'fulfilled');
    expect(accepted).toHaveLength(2);
    for (const r of attempts) {
      if (r.status === 'rejected') expect(r.reason).toMatchObject({ status: 413 });
    }
    const [{ total }] = await all<{ total: number }>(
      'SELECT SUM(size_bytes) AS total FROM issue_attachment WHERE issue_id = ?',
      issueId,
    );
    expect(total).toBeLessThanOrEqual(1024 * 1024);

    // Replacing a file counts only the difference: a same-size swap fits at full quota.
    const first = accepted[0]!.status === 'fulfilled' ? accepted[0].value : null;
    const replaced = await replaceAttachmentContent(db, first!.publicId, pid, {
      s3Key: 'k/new',
      filename: 'new',
      contentType: 'text/plain',
      sizeBytes: half,
    });
    expect(replaced?.replacedS3Key).toBe(first!.s3Key);
    await expect(
      replaceAttachmentContent(db, first!.publicId, pid, {
        s3Key: 'k/huge',
        filename: 'huge',
        contentType: 'text/plain',
        sizeBytes: 900 * 1024,
      }),
    ).rejects.toMatchObject({ status: 413 });
  });
});
