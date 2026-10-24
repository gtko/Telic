import {
  documentCollaboration,
  documentComment,
  documentStep,
  projectDocument,
  type Db,
} from '@repo/db';
import { and, asc, eq, gt, or } from 'drizzle-orm';
import { Step, Mapping } from '@tiptap/pm/transform';
import { HttpError } from '#shared/lib';
import { assertValidDocumentContentJson, getDocument } from './service';
import { collaborationSchema } from './collaboration-schema';
import {
  bumpDocumentsMarker,
  captureRevisions,
  coalesceTarget,
  fencedBatch,
  json,
  readRevisionTail,
  stmt,
  type Stmt,
} from './tree';

// Collaborative editing on D1. Postgres took `FOR UPDATE` on the page to serialize the
// writers of one session; here a write reads the page and its session, applies the steps in
// JS, then lands in ONE fenced batch whose guard is "page version, session epoch and session
// version are still what I read". A writer that lost the race gets the same 409 the locked
// version gave ("receive the latest changes"), and a writer that only lost to an unrelated
// edit of the page (title...) simply reads again.

const STEP_HISTORY = 10_000;
const MAX_ATTEMPTS = 10;

export async function readVisibleDocument(
  db: Db,
  projectId: number,
  documentId: number,
  userId: string,
  editing = false,
) {
  const [document] = await db
    .select()
    .from(projectDocument)
    .where(
      and(
        eq(projectDocument.id, documentId),
        eq(projectDocument.projectId, projectId),
        or(eq(projectDocument.isPrivate, false), eq(projectDocument.ownerUserId, userId)),
      ),
    );
  if (!document) throw new HttpError(404, 'Document not found');
  if (editing && (document.isLocked || document.archivedAt))
    throw new HttpError(409, 'This document is read-only');
  return document;
}

async function readSession(db: Db, documentId: number) {
  const [session] = await db
    .select()
    .from(documentCollaboration)
    .where(eq(documentCollaboration.documentId, documentId));
  return session ?? null;
}

type SessionRow = NonNullable<Awaited<ReturnType<typeof readSession>>>;

export async function openDocumentSession(
  db: Db,
  projectId: number,
  documentId: number,
  userId: string,
  input: { version: number; contentJson: Record<string, unknown> },
): Promise<SessionRow> {
  assertValidDocumentContentJson(input.contentJson);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const document = await readVisibleDocument(db, projectId, documentId, userId, true);
    const existing = await readSession(db, documentId);
    if (existing && JSON.stringify(existing.contentJson) === JSON.stringify(document.contentJson))
      return existing;
    if (!document.contentJson && document.version !== input.version)
      throw new HttpError(409, 'Reload the document before joining');
    const json0 = document.contentJson ?? input.contentJson;
    assertValidDocumentContentJson(json0);
    let normalized: Record<string, unknown>;
    try {
      const node = collaborationSchema.nodeFromJSON(json0);
      node.check();
      normalized = node.toJSON();
      const ids = new Set<unknown>();
      const addIds = (value: Record<string, unknown>) => {
        if (
          [
            'paragraph',
            'heading',
            'blockquote',
            'codeBlock',
            'bulletList',
            'orderedList',
            'taskList',
            'table',
            'horizontalRule',
            'image',
          ].includes(String(value.type))
        ) {
          const attrs = (value.attrs ?? {}) as Record<string, unknown>;
          const id = attrs.blockId && !ids.has(attrs.blockId) ? attrs.blockId : crypto.randomUUID();
          ids.add(id);
          value.attrs = { ...attrs, blockId: id };
        }
        if (Array.isArray(value.content)) value.content.forEach(addIds);
      };
      addIds(normalized);
    } catch {
      throw new HttpError(400, 'Invalid document structure');
    }
    const epoch = crypto.randomUUID();
    const rewritesDocument = JSON.stringify(document.contentJson) !== JSON.stringify(normalized);
    const now = Date.now();
    const before = document;
    const after = { ...document, contentJson: normalized };
    const coalesceInto = rewritesDocument
      ? coalesceTarget(await readRevisionTail(db, documentId), before, after, userId, now)
      : null;

    // The session as it was read: same epoch and version, or still absent.
    const sessionGuard = existing
      ? stmt`EXISTS (SELECT 1 FROM document_collaboration WHERE document_id = ${documentId}
          AND epoch = ${existing.epoch} AND version = ${existing.version})`
      : stmt`NOT EXISTS (SELECT 1 FROM document_collaboration WHERE document_id = ${documentId})`;
    const { applied } = await fencedBatch(db, {
      projectId,
      rev: null,
      guard: stmt`EXISTS (SELECT 1 FROM project_document WHERE id = ${documentId} AND version = ${document.version}
        AND archived_at IS NULL AND is_locked = 0) AND ${sessionGuard}`,
      build: (ok) => [
        stmt`DELETE FROM document_step WHERE document_id = ${documentId} AND ${ok}`,
        stmt`INSERT INTO document_collaboration (document_id, epoch, version, content_json)
          SELECT ${documentId}, ${epoch}, 0, ${json(normalized)} WHERE ${ok}
          ON CONFLICT (document_id) DO UPDATE SET epoch = excluded.epoch, version = 0, content_json = excluded.content_json`,
        ...(rewritesDocument
          ? [
              stmt`UPDATE project_document SET content_json = ${json(normalized)}, version = version + 1,
                updated_by_user_id = ${userId}, updated_at = ${now}
                WHERE id = ${documentId} AND version = ${document.version} AND ${ok}`,
              ...captureRevisions(ok, [documentId], coalesceInto),
              bumpDocumentsMarker(ok, projectId),
            ]
          : []),
      ],
    });
    if (applied) {
      const session = await readSession(db, documentId);
      if (session) return session;
    }
  }
  throw new HttpError(409, 'Too many concurrent changes to this document. Try again.');
}

export async function getDocumentSteps(
  db: Db,
  projectId: number,
  documentId: number,
  userId: string,
  epoch: string,
  version: number,
) {
  // One batch of reads = one consistent view of the page, its session and its steps.
  const [documents, sessions, steps] = await db.batch([
    db
      .select()
      .from(projectDocument)
      .where(
        and(
          eq(projectDocument.id, documentId),
          eq(projectDocument.projectId, projectId),
          or(eq(projectDocument.isPrivate, false), eq(projectDocument.ownerUserId, userId)),
        ),
      ),
    db.select().from(documentCollaboration).where(eq(documentCollaboration.documentId, documentId)),
    db
      .select({
        version: documentStep.version,
        step: documentStep.step,
        clientId: documentStep.clientId,
      })
      .from(documentStep)
      .where(and(eq(documentStep.documentId, documentId), gt(documentStep.version, version)))
      .orderBy(asc(documentStep.version))
      .limit(1000),
  ]);
  const document = documents[0];
  if (!document) throw new HttpError(404, 'Document not found');
  const session = sessions[0];
  if (
    !session ||
    session.epoch !== epoch ||
    JSON.stringify(session.contentJson) !== JSON.stringify(document.contentJson)
  )
    throw new HttpError(409, 'The document was restored or replaced. Rejoin to continue.');
  if (version > session.version) throw new HttpError(409, 'Invalid collaboration version');
  if (version < session.version && steps[0]?.version !== version + 1)
    throw new HttpError(409, 'The collaboration history expired. Rejoin to continue.');
  return {
    epoch,
    version: version + steps.length,
    steps: steps.map(({ step, clientId }) => ({ step, clientId })),
    hasMore: version + steps.length < session.version,
    documentVersion: document.version,
  };
}

export async function saveDocumentSteps(
  db: Db,
  projectId: number,
  documentId: number,
  userId: string,
  input: {
    epoch: string;
    version: number;
    clientId: string;
    steps: Record<string, unknown>[];
    content: string;
  },
) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const document = await readVisibleDocument(db, projectId, documentId, userId, true);
    const session = await readSession(db, documentId);
    if (
      !session ||
      session.epoch !== input.epoch ||
      JSON.stringify(session.contentJson) !== JSON.stringify(document.contentJson)
    )
      throw new HttpError(409, 'The document was restored or replaced');
    if (session.version !== input.version)
      throw new HttpError(409, 'Receive the latest changes before saving');
    let node = collaborationSchema.nodeFromJSON(session.contentJson);
    const mapping = new Mapping();
    const accepted: Record<string, unknown>[] = [];
    try {
      for (const stepJson of input.steps) {
        const step = Step.fromJSON(collaborationSchema, stepJson);
        const result = step.apply(node);
        if (result.failed || !result.doc) throw new Error('Invalid step');
        node = result.doc;
        mapping.appendMap(step.getMap());
        accepted.push(step.toJSON());
      }
      node.check();
    } catch {
      throw new HttpError(400, 'Invalid document changes');
    }
    const contentJson: Record<string, unknown> = node.toJSON();
    assertValidDocumentContentJson(contentJson);

    const nextVersion = input.version + accepted.length;
    const retainedFrom = nextVersion - STEP_HISTORY;
    const now = Date.now();
    const comments = await db
      .select()
      .from(documentComment)
      .where(eq(documentComment.documentId, documentId));
    const moved: Array<{ id: string; from: number; to: number; orphaned: boolean }> = [];
    for (const comment of comments) {
      if (comment.from === null || comment.to === null || comment.orphaned) continue;
      const from = mapping.map(comment.from, 1);
      const to = mapping.map(comment.to, -1);
      if (from === comment.from && to === comment.to) continue;
      moved.push({
        id: comment.id,
        from: Math.min(from, to),
        to: Math.max(from, to),
        orphaned: from >= to,
      });
    }
    const after = { ...document, content: input.content, contentJson };
    const coalesceInto = coalesceTarget(
      await readRevisionTail(db, documentId),
      document,
      after,
      userId,
      now,
    );

    const { applied } = await fencedBatch(db, {
      projectId,
      rev: null,
      guard: stmt`EXISTS (SELECT 1 FROM project_document WHERE id = ${documentId} AND version = ${document.version}
          AND archived_at IS NULL AND is_locked = 0)
        AND EXISTS (SELECT 1 FROM document_collaboration WHERE document_id = ${documentId}
          AND epoch = ${input.epoch} AND version = ${input.version})`,
      build: (ok): Stmt[] => [
        // One statement for all the steps (a single bound JSON parameter, whatever their number).
        stmt`INSERT INTO document_step (document_id, version, client_id, step)
          SELECT ${documentId}, ${input.version} + CAST(j.key AS INTEGER) + 1, ${input.clientId}, j.value
          FROM json_each(${JSON.stringify(accepted)}) AS j WHERE ${ok}`,
        stmt`UPDATE project_document SET content_json = ${json(contentJson)}, content = ${input.content},
          version = version + 1, updated_at = ${now}, updated_by_user_id = ${userId}
          WHERE id = ${documentId} AND version = ${document.version} AND ${ok}`,
        ...captureRevisions(ok, [documentId], coalesceInto),
        ...(retainedFrom > 0
          ? [
              stmt`DELETE FROM document_step WHERE document_id = ${documentId} AND version <= ${retainedFrom} AND ${ok}`,
            ]
          : []),
        ...(moved.length > 0
          ? [
              stmt`UPDATE document_comment SET
                  selection_from = (SELECT json_extract(j.value, '$.from') FROM json_each(${JSON.stringify(moved)}) j WHERE json_extract(j.value, '$.id') = document_comment.id),
                  selection_to = (SELECT json_extract(j.value, '$.to') FROM json_each(${JSON.stringify(moved)}) j WHERE json_extract(j.value, '$.id') = document_comment.id),
                  orphaned = (SELECT json_extract(j.value, '$.orphaned') FROM json_each(${JSON.stringify(moved)}) j WHERE json_extract(j.value, '$.id') = document_comment.id)
                WHERE document_id = ${documentId}
                  AND id IN (SELECT json_extract(j.value, '$.id') FROM json_each(${JSON.stringify(moved)}) j) AND ${ok}`,
            ]
          : []),
        bumpDocumentsMarker(ok, projectId),
        // The session moves last: the guard above reads its version before this statement.
        stmt`UPDATE document_collaboration SET version = ${nextVersion}, content_json = ${json(contentJson)}
          WHERE document_id = ${documentId} AND epoch = ${input.epoch} AND version = ${input.version} AND ${ok}`,
      ],
    });
    if (applied) return getDocument(db, projectId, documentId, userId);
    // Lost the race: the next read reports a stale session as the 409 it is, or retries when
    // only the page itself (a title edit) moved.
  }
  throw new HttpError(409, 'Receive the latest changes before saving');
}
