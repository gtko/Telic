import {
  initiative,
  issue,
  projectDocument,
  projectDocumentInitiative,
  projectDocumentIssue,
  type Db,
} from '@repo/db';
import { and, asc, eq, or } from 'drizzle-orm';
import { HttpError } from '#shared/lib';
import { notInTriage } from '#shared/triage';
import { fencedBatch, stmt } from './tree';

export interface DocumentIssueLinkRow {
  issueId: number;
  sequenceNumber: number;
  identifier: string;
  title: string;
  archived: boolean;
  createdAt: string;
}

// The same shape serves both owners: a Docs page linked to an issue and one
// linked to an initiative are rendered by the same list.
export interface IssueDocumentLinkRow {
  documentId: number;
  title: string;
  icon: string | null;
  isPrivate: boolean;
  archived: boolean;
  createdAt: string;
}

function documentLinkRow(row: {
  documentId: number;
  title: string;
  icon: string | null;
  isPrivate: boolean;
  archivedAt: Date | null;
  createdAt: Date;
}): IssueDocumentLinkRow {
  return {
    documentId: row.documentId,
    title: row.title,
    icon: row.icon,
    isPrivate: row.isPrivate,
    archived: row.archivedAt !== null,
    createdAt: row.createdAt.toISOString(),
  };
}

const documentAccess = (userId: string) =>
  or(eq(projectDocument.isPrivate, false), eq(projectDocument.ownerUserId, userId));

async function visibleDocument(db: Db, projectId: number, documentId: number, userId: string) {
  const [document] = await db
    .select({
      id: projectDocument.id,
      title: projectDocument.title,
      icon: projectDocument.icon,
      isPrivate: projectDocument.isPrivate,
      archivedAt: projectDocument.archivedAt,
    })
    .from(projectDocument)
    .where(
      and(
        eq(projectDocument.id, documentId),
        eq(projectDocument.projectId, projectId),
        documentAccess(userId),
      ),
    )
    .limit(1);
  return document ?? null;
}

export async function listDocumentIssueLinks(
  db: Db,
  projectId: number,
  projectKey: string,
  documentId: number,
  userId: string,
): Promise<DocumentIssueLinkRow[] | null> {
  if (!(await visibleDocument(db, projectId, documentId, userId))) return null;
  const rows = await db
    .select({
      issueId: issue.id,
      sequenceNumber: issue.sequenceNumber,
      title: issue.title,
      archivedAt: issue.archivedAt,
      createdAt: projectDocumentIssue.createdAt,
    })
    .from(projectDocumentIssue)
    .innerJoin(issue, eq(issue.id, projectDocumentIssue.issueId))
    .where(
      and(
        eq(projectDocumentIssue.documentId, documentId),
        eq(issue.projectId, projectId),
        notInTriage(issue.columnId),
      ),
    )
    .orderBy(asc(issue.sequenceNumber));
  return rows.map((row) => ({
    issueId: row.issueId,
    sequenceNumber: row.sequenceNumber,
    identifier: `${projectKey}-${row.sequenceNumber}`,
    title: row.title,
    archived: row.archivedAt !== null,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function listIssueDocumentLinks(
  db: Db,
  projectId: number,
  issueId: number,
  userId: string,
): Promise<IssueDocumentLinkRow[] | null> {
  const [workItem] = await db
    .select({ id: issue.id })
    .from(issue)
    .where(and(eq(issue.id, issueId), eq(issue.projectId, projectId)))
    .limit(1);
  if (!workItem) return null;

  const rows = await db
    .select({
      documentId: projectDocument.id,
      title: projectDocument.title,
      icon: projectDocument.icon,
      isPrivate: projectDocument.isPrivate,
      archivedAt: projectDocument.archivedAt,
      createdAt: projectDocumentIssue.createdAt,
    })
    .from(projectDocumentIssue)
    .innerJoin(projectDocument, eq(projectDocument.id, projectDocumentIssue.documentId))
    .where(
      and(
        eq(projectDocumentIssue.issueId, issueId),
        eq(projectDocument.projectId, projectId),
        documentAccess(userId),
      ),
    )
    .orderBy(asc(projectDocument.title), asc(projectDocument.id));
  return rows.map(documentLinkRow);
}

// The link is created by one statement that carries the trigger of Postgres
// (project_document_*_validate_project): both ends must be in the project, and the page must
// be visible and not archived. The sync markers move in the same batch.
export async function addDocumentIssueLink(
  db: Db,
  input: {
    projectId: number;
    projectKey: string;
    documentId: number;
    issueId: number;
    userId: string;
  },
): Promise<DocumentIssueLinkRow> {
  const document = await visibleDocument(db, input.projectId, input.documentId, input.userId);
  if (!document) throw new HttpError(404, 'Document not found');
  if (document.archivedAt !== null) throw new HttpError(409, 'Archived documents cannot be linked');
  const [workItem] = await db
    .select({
      id: issue.id,
      sequenceNumber: issue.sequenceNumber,
      title: issue.title,
      archivedAt: issue.archivedAt,
    })
    .from(issue)
    .where(and(eq(issue.id, input.issueId), eq(issue.projectId, input.projectId)))
    .limit(1);
  if (!workItem) throw new HttpError(404, 'Issue not found');

  const now = Date.now();
  const { applied, results } = await fencedBatch(db, {
    projectId: input.projectId,
    rev: null,
    guard: stmt`EXISTS (SELECT 1 FROM project_document WHERE id = ${input.documentId} AND project_id = ${input.projectId}
        AND archived_at IS NULL AND (is_private = 0 OR owner_user_id = ${input.userId}))
      AND EXISTS (SELECT 1 FROM issue WHERE id = ${input.issueId} AND project_id = ${input.projectId})`,
    build: (ok) => [
      stmt`INSERT OR IGNORE INTO project_document_issue (document_id, issue_id, created_by_user_id, created_at)
        SELECT ${input.documentId}, ${input.issueId}, ${input.userId}, ${now} WHERE ${ok}
        RETURNING document_id`,
    ],
  });
  if (!applied) throw new HttpError(409, 'The document or the issue changed. Try again.');
  if (results[0]?.results.length !== 1) {
    throw new HttpError(409, 'The document is already linked to this issue');
  }
  return {
    issueId: workItem.id,
    sequenceNumber: workItem.sequenceNumber,
    identifier: `${input.projectKey}-${workItem.sequenceNumber}`,
    title: workItem.title,
    archived: workItem.archivedAt !== null,
    createdAt: new Date(now).toISOString(),
  };
}

export async function removeDocumentIssueLink(
  db: Db,
  input: { projectId: number; documentId: number; issueId: number; userId: string },
): Promise<boolean> {
  if (!(await visibleDocument(db, input.projectId, input.documentId, input.userId))) {
    throw new HttpError(404, 'Document not found');
  }
  const [workItem] = await db
    .select({ id: issue.id })
    .from(issue)
    .where(and(eq(issue.id, input.issueId), eq(issue.projectId, input.projectId)))
    .limit(1);
  if (!workItem) throw new HttpError(404, 'Issue not found');
  const { results } = await fencedBatch(db, {
    projectId: input.projectId,
    rev: null,
    build: (ok) => [
      stmt`DELETE FROM project_document_issue WHERE document_id = ${input.documentId} AND issue_id = ${input.issueId} AND ${ok}
        RETURNING document_id`,
    ],
  });
  return results[0]?.results.length === 1;
}

export async function listInitiativeDocumentLinks(
  db: Db,
  projectId: number,
  initiativeId: number,
  userId: string,
): Promise<IssueDocumentLinkRow[] | null> {
  const [target] = await db
    .select({ id: initiative.id })
    .from(initiative)
    .where(and(eq(initiative.id, initiativeId), eq(initiative.projectId, projectId)))
    .limit(1);
  if (!target) return null;

  const rows = await db
    .select({
      documentId: projectDocument.id,
      title: projectDocument.title,
      icon: projectDocument.icon,
      isPrivate: projectDocument.isPrivate,
      archivedAt: projectDocument.archivedAt,
      createdAt: projectDocumentInitiative.createdAt,
    })
    .from(projectDocumentInitiative)
    .innerJoin(projectDocument, eq(projectDocument.id, projectDocumentInitiative.documentId))
    .where(
      and(
        eq(projectDocumentInitiative.initiativeId, initiativeId),
        eq(projectDocument.projectId, projectId),
        documentAccess(userId),
      ),
    )
    .orderBy(asc(projectDocument.title), asc(projectDocument.id));
  return rows.map(documentLinkRow);
}

export async function addDocumentInitiativeLink(
  db: Db,
  input: { projectId: number; documentId: number; initiativeId: number; userId: string },
): Promise<IssueDocumentLinkRow> {
  const document = await visibleDocument(db, input.projectId, input.documentId, input.userId);
  if (!document) throw new HttpError(404, 'Document not found');
  if (document.archivedAt !== null) throw new HttpError(409, 'Archived documents cannot be linked');
  const [target] = await db
    .select({ id: initiative.id })
    .from(initiative)
    .where(and(eq(initiative.id, input.initiativeId), eq(initiative.projectId, input.projectId)))
    .limit(1);
  if (!target) throw new HttpError(404, 'Initiative not found');

  const now = Date.now();
  const { applied, results } = await fencedBatch(db, {
    projectId: input.projectId,
    rev: null,
    guard: stmt`EXISTS (SELECT 1 FROM project_document WHERE id = ${input.documentId} AND project_id = ${input.projectId}
        AND archived_at IS NULL AND (is_private = 0 OR owner_user_id = ${input.userId}))
      AND EXISTS (SELECT 1 FROM initiative WHERE id = ${input.initiativeId} AND project_id = ${input.projectId})`,
    build: (ok) => [
      stmt`INSERT OR IGNORE INTO project_document_initiative (document_id, initiative_id, created_by_user_id, created_at)
        SELECT ${input.documentId}, ${input.initiativeId}, ${input.userId}, ${now} WHERE ${ok}
        RETURNING document_id`,
    ],
  });
  if (!applied) throw new HttpError(409, 'The document or the initiative changed. Try again.');
  if (results[0]?.results.length !== 1) {
    throw new HttpError(409, 'The document is already linked to this initiative');
  }
  return documentLinkRow({ ...document, documentId: document.id, createdAt: new Date(now) });
}

export async function removeDocumentInitiativeLink(
  db: Db,
  input: { projectId: number; documentId: number; initiativeId: number; userId: string },
): Promise<boolean> {
  if (!(await visibleDocument(db, input.projectId, input.documentId, input.userId))) {
    throw new HttpError(404, 'Document not found');
  }
  const { results } = await fencedBatch(db, {
    projectId: input.projectId,
    rev: null,
    build: (ok) => [
      stmt`DELETE FROM project_document_initiative WHERE document_id = ${input.documentId} AND initiative_id = ${input.initiativeId} AND ${ok}
        RETURNING document_id`,
    ],
  });
  return results[0]?.results.length === 1;
}
