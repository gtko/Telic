import { documentComment, type Db } from '@repo/db';
import { user } from '@repo/db/schema';
import { and, asc, eq } from 'drizzle-orm';
import { HttpError } from '#shared/lib';
import { collaborationSchema } from './collaboration-schema';
import { readVisibleDocument } from './collaboration';
import { bumpDocumentsMarker, fencedBatch, stmt } from './tree';

export async function listDocumentComments(
  db: Db,
  projectId: number,
  documentId: number,
  userId: string,
) {
  const document = await readVisibleDocument(db, projectId, documentId, userId);
  const rows = await db
    .select({ comment: documentComment, authorName: user.name })
    .from(documentComment)
    .leftJoin(user, eq(documentComment.authorId, user.id))
    .where(eq(documentComment.documentId, documentId))
    .orderBy(asc(documentComment.createdAt));
  return rows.map(({ comment, authorName }) => ({
    ...comment,
    documentVersion: document.version,
    authorName,
    createdAt: comment.createdAt.toISOString(),
    updatedAt: comment.updatedAt.toISOString(),
    resolvedAt: comment.resolvedAt?.toISOString() ?? null,
  }));
}

export async function addDocumentComment(
  db: Db,
  projectId: number,
  documentId: number,
  userId: string,
  input: {
    body: string;
    parentId?: string;
    quote?: string;
    from?: number;
    to?: number;
    version: number;
  },
) {
  const document = await readVisibleDocument(db, projectId, documentId, userId);
  if (document.archivedAt) throw new HttpError(409, 'Archived documents cannot be commented on');
  if (!input.body.trim()) throw new HttpError(400, 'A comment cannot be empty');
  if (input.parentId) {
    const [parent] = await db
      .select()
      .from(documentComment)
      .where(
        and(eq(documentComment.id, input.parentId), eq(documentComment.documentId, documentId)),
      );
    if (!parent || parent.parentId) throw new HttpError(404, 'Comment thread not found');
  } else {
    if (document.version !== input.version)
      throw new HttpError(409, 'The selection changed. Select the text again.');
    if (
      input.from === undefined ||
      input.to === undefined ||
      input.from >= input.to ||
      !input.quote?.trim()
    )
      throw new HttpError(400, 'Select text to comment on');
    if (!document.contentJson) throw new HttpError(409, 'Save the document first');
    const node = collaborationSchema.nodeFromJSON(document.contentJson);
    if (
      input.to > node.content.size ||
      node.textBetween(input.from, input.to, '\n').slice(0, 2000) !== input.quote
    )
      throw new HttpError(409, 'The selected text changed');
  }
  const id = crypto.randomUUID();
  const now = Date.now();
  // A thread anchor is only valid for the page version it was checked against: the guard
  // refuses the insert if the text moved since. A reply only needs its thread and the page.
  const { applied } = await fencedBatch(db, {
    projectId,
    rev: null,
    guard: input.parentId
      ? stmt`EXISTS (SELECT 1 FROM project_document WHERE id = ${documentId} AND archived_at IS NULL)
          AND EXISTS (SELECT 1 FROM document_comment WHERE id = ${input.parentId} AND document_id = ${documentId} AND parent_id IS NULL)`
      : stmt`EXISTS (SELECT 1 FROM project_document WHERE id = ${documentId} AND version = ${document.version} AND archived_at IS NULL)`,
    build: (ok) => [
      stmt`INSERT INTO document_comment (id, document_id, parent_id, author_id, body, quote, selection_from, selection_to, created_at, updated_at)
        SELECT ${id}, ${documentId}, ${input.parentId ?? null}, ${userId}, ${input.body.trim()},
          ${input.parentId ? '' : (input.quote ?? '')}, ${input.parentId ? null : (input.from ?? null)},
          ${input.parentId ? null : (input.to ?? null)}, ${now}, ${now}
        WHERE ${ok}`,
      bumpDocumentsMarker(ok, projectId),
    ],
  });
  if (!applied) {
    throw new HttpError(409, 'The selection changed. Select the text again.');
  }
  return { id };
}

export async function updateDocumentComment(
  db: Db,
  projectId: number,
  documentId: number,
  userId: string,
  commentId: string,
  input: { body?: string; resolved?: boolean },
) {
  await readVisibleDocument(db, projectId, documentId, userId);
  const [comment] = await db
    .select()
    .from(documentComment)
    .where(and(eq(documentComment.id, commentId), eq(documentComment.documentId, documentId)));
  if (!comment) throw new HttpError(404, 'Comment not found');
  if (input.body !== undefined && comment.authorId !== userId)
    throw new HttpError(403, 'Only the author can edit a comment');
  if (input.body !== undefined && !input.body.trim())
    throw new HttpError(400, 'A comment cannot be empty');
  if (input.resolved !== undefined && comment.parentId)
    throw new HttpError(400, 'Resolve the thread, not a reply');
  const now = Date.now();
  await fencedBatch(db, {
    projectId,
    rev: null,
    build: (ok) => [
      input.body !== undefined
        ? stmt`UPDATE document_comment SET body = ${input.body.trim()}, updated_at = ${now}
            WHERE id = ${commentId} AND document_id = ${documentId} AND ${ok}`
        : stmt`UPDATE document_comment SET updated_at = ${now}
            WHERE id = ${commentId} AND document_id = ${documentId} AND ${ok}`,
      ...(input.resolved !== undefined
        ? [
            stmt`UPDATE document_comment SET resolved_at = ${input.resolved ? now : null}
              WHERE id = ${commentId} AND document_id = ${documentId} AND ${ok}`,
          ]
        : []),
      bumpDocumentsMarker(ok, projectId),
    ],
  });
  return { ok: true };
}
