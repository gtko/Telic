// projectStoredBytes / workspaceStoredBytes (one UNION ALL statement) and reserveStorage (the
// quota check and the insert in one statement) on a local D1.
import { eq } from 'drizzle-orm';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../client';
import { migrateD1 } from '../migrate';
import {
  chatAttachment,
  documentAsset,
  initiative,
  initiativeAttachment,
  issue,
  issueAttachment,
  project,
  projectColumn,
  projectDocument,
  team,
  user,
} from '../schema';
import { projectStoredBytes, reserveStorage, workspaceStoredBytes } from '../domains/storage';
import { createWorkspace } from '../workspace';

let mf: Miniflare;
let db: Db;
let workspaceId: number;
let teamId: number;
let n = 0;

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: 'storage-db' },
  });
  db = createDb((await mf.getD1Database('DB')) as unknown as D1Database);
  await migrateD1(db);
  await db.insert(user).values({ id: 'u1', name: 'Ada', email: 'ada@example.com' });
  workspaceId = await createWorkspace(db, 'Acme', 'u1');
  [{ id: teamId }] = await db
    .insert(team)
    .values({ workspaceId, name: 'Core' })
    .returning({ id: team.id });
});

afterAll(async () => {
  await mf.dispose();
});

async function mkProject(inTeam = teamId) {
  const k = ++n;
  const [p] = await db
    .insert(project)
    .values({ teamId: inTeam, key: `S${k}`, name: `Project ${k}` })
    .returning({ id: project.id });
  const [c] = await db
    .insert(projectColumn)
    .values({ projectId: p!.id, name: 'Todo', position: 0 })
    .returning({ id: projectColumn.id });
  const [i] = await db
    .insert(issue)
    .values({ projectId: p!.id, columnId: c!.id, sequenceNumber: 1, title: 'T' })
    .returning({ id: issue.id });
  return { projectId: p!.id, issueId: i!.id };
}

const file = (sizeBytes: number) => ({
  s3Key: `k${++n}`,
  filename: 'f.bin',
  contentType: 'application/octet-stream',
  sizeBytes,
});
const pid = () => ({ publicId: crypto.randomUUID() });

describe('stored bytes', () => {
  it('sums the four attachment kinds of a project in one statement, and nothing of another', async () => {
    const p = await mkProject();
    const other = await mkProject();
    const [doc] = await db
      .insert(projectDocument)
      .values({ projectId: p.projectId })
      .returning({ id: projectDocument.id });
    const [ini] = await db
      .insert(initiative)
      .values({ projectId: p.projectId, title: 'I' })
      .returning({ id: initiative.id });
    await db.insert(issueAttachment).values({ ...pid(), issueId: p.issueId, ...file(1) });
    await db.insert(chatAttachment).values({ ...pid(), projectId: p.projectId, ...file(20) });
    await db.insert(documentAsset).values({ ...pid(), documentId: doc!.id, ...file(300) });
    await db
      .insert(initiativeAttachment)
      .values({ ...pid(), initiativeId: ini!.id, ...file(4000) });
    await db.insert(issueAttachment).values({ ...pid(), issueId: other.issueId, ...file(99999) });

    expect(await projectStoredBytes(db, p.projectId)).toBe(4321);
    expect(await projectStoredBytes(db, other.projectId)).toBe(99999);
    expect(await projectStoredBytes(db, 987654)).toBe(0);
  });

  it('sums a workspace over its teams, and only its own', async () => {
    const ws = await createWorkspace(db, 'Other', 'u1');
    const [t] = await db
      .insert(team)
      .values({ workspaceId: ws, name: 'T2' })
      .returning({ id: team.id });
    const a = await mkProject(t!.id);
    const b = await mkProject(t!.id);
    await db.insert(issueAttachment).values({ ...pid(), issueId: a.issueId, ...file(10) });
    await db.insert(chatAttachment).values({ ...pid(), projectId: b.projectId, ...file(5) });
    expect(await workspaceStoredBytes(db, ws)).toBe(15);
    expect(await workspaceStoredBytes(db, workspaceId)).toBeGreaterThanOrEqual(0);
  });
});

describe('reserveStorage', () => {
  it('inserts while the quota holds and refuses the row that would exceed it', async () => {
    const p = await mkProject();
    const base = {
      kind: 'issue' as const,
      projectId: p.projectId,
      ownerId: p.issueId,
      quotaBytes: 100,
    };
    const first = await reserveStorage(db, { ...base, ...file(60) });
    expect(first).toMatchObject({ id: expect.any(Number), publicId: expect.any(String) });
    expect(await reserveStorage(db, { ...base, ...file(41) })).toBeNull(); // 60 + 41 > 100
    expect(await reserveStorage(db, { ...base, ...file(40) })).not.toBeNull(); // exactly 100
    expect(await projectStoredBytes(db, p.projectId)).toBe(100);
    const rows = await db
      .select()
      .from(issueAttachment)
      .where(eq(issueAttachment.issueId, p.issueId));
    expect(rows).toHaveLength(2);
  });

  it('treats a quota of 0 as unlimited and stores the uploader of chat and document files', async () => {
    const p = await mkProject();
    const [doc] = await db
      .insert(projectDocument)
      .values({ projectId: p.projectId })
      .returning({ id: projectDocument.id });
    const chat = await reserveStorage(db, {
      kind: 'chat',
      projectId: p.projectId,
      ownerId: 0,
      quotaBytes: 0,
      uploadedByUserId: 'u1',
      ...file(1e9),
    });
    const asset = await reserveStorage(db, {
      kind: 'document',
      projectId: p.projectId,
      ownerId: doc!.id,
      quotaBytes: 0,
      uploadedByUserId: 'u1',
      ...file(5),
    });
    expect(chat).not.toBeNull();
    expect(asset).not.toBeNull();
    const [row] = await db.select().from(chatAttachment).where(eq(chatAttachment.id, chat!.id));
    expect(row).toMatchObject({
      projectId: p.projectId,
      uploadedByUserId: 'u1',
      publicId: chat!.publicId,
    });
  });

  it('refuses an owner that belongs to another project (no charging a foreign quota)', async () => {
    const a = await mkProject();
    const b = await mkProject();
    const result = await reserveStorage(db, {
      kind: 'issue',
      projectId: a.projectId,
      ownerId: b.issueId,
      quotaBytes: 0,
      ...file(1),
    });
    expect(result).toBeNull();
    expect(await projectStoredBytes(db, b.projectId)).toBe(0);
  });

  it('lets exactly the uploads that fit through when many arrive at once', async () => {
    const p = await mkProject();
    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        reserveStorage(db, {
          kind: 'issue',
          projectId: p.projectId,
          ownerId: p.issueId,
          quotaBytes: 1000,
          ...file(100),
        }),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(10);
    expect(await projectStoredBytes(db, p.projectId)).toBe(1000);
  });

  it('rejects a negative size', async () => {
    const p = await mkProject();
    await expect(
      reserveStorage(db, {
        kind: 'issue',
        projectId: p.projectId,
        ownerId: p.issueId,
        quotaBytes: 0,
        ...file(-1),
      }),
    ).rejects.toThrow('sizeBytes');
  });
});
