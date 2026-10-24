// Concurrency primitives of the document tree on D1 (ODY-296).
//
// Postgres serialized every write to a project's tree with pg_advisory_xact_lock and row
// locks. D1 has neither, and no interactive transaction: only `batch()` is atomic. So the
// tree is guarded optimistically (pattern validated by spike S4):
//
//   1. read a snapshot of the project's tree together with `project_tree.rev`;
//   2. decide everything (validation, ordering, ids) in JS from that snapshot;
//   3. write in ONE batch whose first statement is the fence: it sets a unique token in
//      `project_tree.last_tx` (and bumps `rev` for a tree write) only if `rev` and the
//      guard still hold. Every following statement applies only when the token is the
//      batch's own, so a refused batch is a complete no-op;
//   4. a refused fence means someone changed the tree in between: read again and retry.
//
// The revision triggers of Postgres (document history, `documents:<project>` sync marker)
// are statements of the same batch, so history and marker move with the write or not at
// all, whichever process wrote it.
import type { Db } from '@repo/db';
import { projectDocument, projectDocumentRevision, projectTree } from '@repo/db';
import { desc, eq } from 'drizzle-orm';
import { HttpError } from '#shared/lib';

export type Bindable = string | number | null;

export interface Stmt {
  sql: string;
  params: Bindable[];
}

type Part = Bindable | boolean | Date | undefined | Stmt;

function isStmt(value: unknown): value is Stmt {
  return typeof value === 'object' && value !== null && 'sql' in value && 'params' in value;
}

/** Tagged template: every `${}` becomes a bound parameter, a nested Stmt is inlined. */
export function stmt(strings: TemplateStringsArray, ...values: Part[]): Stmt {
  let text = strings[0] ?? '';
  const params: Bindable[] = [];
  values.forEach((value, index) => {
    if (isStmt(value)) {
      text += value.sql;
      params.push(...value.params);
    } else {
      text += '?';
      if (value instanceof Date) params.push(value.getTime());
      else if (typeof value === 'boolean') params.push(value ? 1 : 0);
      else params.push(value ?? null);
    }
    text += strings[index + 1] ?? '';
  });
  if (params.length > 100) throw new Error(`Statement binds ${params.length} parameters (D1: 100)`);
  return { sql: text, params };
}

export function json(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

/** `createDb` returns drizzle's `$client` (the D1 binding), which the `Db` type omits. */
export function d1Of(db: Db): D1Database {
  return (db as unknown as { $client: D1Database }).$client;
}

export async function runBatch(db: Db, statements: Stmt[]): Promise<D1Result[]> {
  const client = d1Of(db);
  return client.batch(statements.map((s) => client.prepare(s.sql).bind(...s.params)));
}

export interface Fenced {
  applied: boolean;
  /** Results of the statements returned by `build` (the fence itself is not included). */
  results: D1Result[];
}

/**
 * The fenced batch. `rev` is the tree revision read with the snapshot (a tree write, which
 * bumps it) or null for a document-level write (token only, `rev` untouched). `guard` is
 * the precondition on the rows the write relies on (document version, ...).
 */
export async function fencedBatch(
  db: Db,
  options: {
    projectId: number;
    rev: number | null;
    guard?: Stmt;
    build: (ok: Stmt) => Stmt[];
  },
): Promise<Fenced> {
  const { projectId, rev, guard } = options;
  const token = crypto.randomUUID();
  const ok = stmt`EXISTS (SELECT 1 FROM project_tree WHERE project_id = ${projectId} AND last_tx = ${token})`;
  const revCheck = rev === null ? stmt`` : stmt` AND rev = ${rev}`;
  const guardCheck = guard ? stmt` AND (${guard})` : stmt``;
  const results = await runBatch(db, [
    stmt`INSERT OR IGNORE INTO project_tree (project_id) VALUES (${projectId})`,
    stmt`UPDATE project_tree SET last_tx = ${token}, rev = rev + ${rev === null ? 0 : 1} WHERE project_id = ${projectId}${revCheck}${guardCheck}`,
    ...options.build(ok),
  ]);
  return { applied: results[1]?.meta.changes === 1, results: results.slice(2) };
}

export const MAX_TREE_ATTEMPTS = 60;

/** Thrown by a plan to end a write without touching the database (not found, no change). */
export class EarlyResult<T> {
  constructor(readonly value: T) {}
}

export interface TreeWrite<T> {
  /** Precondition rechecked by the fence (document version, membership, asset set...). */
  guard?: Stmt;
  build: (ok: Stmt) => Stmt[];
  result: (results: D1Result[]) => Promise<T> | T;
}

/**
 * Optimistic tree write. `plan` runs on a fresh snapshot and either throws an HttpError
 * (the request is invalid or stale: no retry) or describes the batch. If the fence is
 * refused the tree moved: plan runs again on a new snapshot, which also turns a stale
 * `version` into the 409 the client expects.
 */
export async function treeWrite<T>(
  db: Db,
  projectId: number,
  plan: (snapshot: TreeSnapshot) => Promise<TreeWrite<T>> | TreeWrite<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= MAX_TREE_ATTEMPTS; attempt += 1) {
    const snapshot = await readTreeSnapshot(db, projectId);
    let write: TreeWrite<T>;
    try {
      write = await plan(snapshot);
    } catch (error) {
      if (error instanceof EarlyResult) return error.value as T;
      throw error;
    }
    const fenced = await fencedBatch(db, {
      projectId,
      rev: snapshot.rev,
      guard: write.guard,
      build: write.build,
    });
    if (fenced.applied) return write.result(fenced.results);
    // Spread contending writers apart so they do not all collide again.
    await new Promise((resolve) => setTimeout(resolve, Math.random() * Math.min(attempt, 10) * 2));
  }
  throw new HttpError(409, 'Too many concurrent changes to this project tree. Try again.');
}

export interface TreeDoc {
  id: number;
  parentId: number | null;
  position: number;
  version: number;
  archivedAt: Date | null;
  archivedByAncestorId: number | null;
  isPrivate: boolean;
  isLocked: boolean;
  ownerUserId: string | null;
}

export interface TreeSnapshot {
  rev: number;
  docs: Map<number, TreeDoc>;
}

/**
 * `rev` is read before the documents: a change landing in between has already bumped it,
 * so the fence refuses a snapshot older than its revision, never the opposite.
 */
export async function readTreeSnapshot(db: Db, projectId: number): Promise<TreeSnapshot> {
  const [tree] = await db
    .select({ rev: projectTree.rev })
    .from(projectTree)
    .where(eq(projectTree.projectId, projectId));
  const rows = await db
    .select({
      id: projectDocument.id,
      parentId: projectDocument.parentId,
      position: projectDocument.position,
      version: projectDocument.version,
      archivedAt: projectDocument.archivedAt,
      archivedByAncestorId: projectDocument.archivedByAncestorId,
      isPrivate: projectDocument.isPrivate,
      isLocked: projectDocument.isLocked,
      ownerUserId: projectDocument.ownerUserId,
    })
    .from(projectDocument)
    .where(eq(projectDocument.projectId, projectId));
  return { rev: tree?.rev ?? 0, docs: new Map(rows.map((row) => [row.id, row])) };
}

export function canSee(doc: TreeDoc, userId: string): boolean {
  return !doc.isPrivate || doc.ownerUserId === userId;
}

export function assertValidParent(
  snapshot: TreeSnapshot,
  documentId: number | null,
  parentId: number | null,
  userId: string,
): void {
  let cursor = parentId;
  const seen = new Set<number>();
  while (cursor !== null) {
    if (cursor === documentId || seen.has(cursor)) {
      throw new HttpError(400, 'A document cannot be nested inside itself');
    }
    seen.add(cursor);
    const parent = snapshot.docs.get(cursor);
    if (!parent || !canSee(parent, userId)) {
      throw new HttpError(400, 'Parent document must belong to the same project');
    }
    if (parent.archivedAt !== null) {
      throw new HttpError(400, 'An archived document cannot be used as a parent');
    }
    cursor = parent.parentId;
  }
}

export const POSITION_STEP = 1024;

/** Position after the last active sibling. */
export function nextPosition(snapshot: TreeSnapshot, parentId: number | null): number {
  let max = 0;
  for (const doc of snapshot.docs.values()) {
    if (doc.parentId === parentId && doc.archivedAt === null && doc.position > max) {
      max = doc.position;
    }
  }
  return max + POSITION_STEP;
}

function safeDocumentPosition(
  previous: { position: number } | undefined,
  next: { position: number } | undefined,
  occupied: Array<{ position: number }>,
): number | null {
  let candidate: number;
  if (!previous && !next) candidate = POSITION_STEP;
  else if (!previous) candidate = next!.position - POSITION_STEP;
  else if (!next) candidate = previous.position + POSITION_STEP;
  else {
    const gap = next.position - previous.position;
    const scale = Math.max(1, Math.abs(previous.position), Math.abs(next.position));
    if (!Number.isFinite(gap) || gap <= Number.EPSILON * scale * 4) return null;
    candidate = previous.position + gap / 2;
    if (!(candidate > previous.position && candidate < next.position)) return null;
  }
  if (!Number.isFinite(candidate)) return null;
  return occupied.some((sibling) => sibling.position === candidate) ? null : candidate;
}

export interface DocumentMovePlan {
  position: number;
  /** Full sibling positions when the gap is exhausted (the moved page included). */
  siblingPositions: Array<{ id: number; position: number }>;
}

export function planDocumentMove(
  snapshot: TreeSnapshot,
  documentId: number,
  parentId: number | null,
  previousSiblingId: number | null,
  nextSiblingId: number | null,
): DocumentMovePlan {
  if (previousSiblingId === documentId || nextSiblingId === documentId) {
    throw new HttpError(400, 'A document cannot be its own move anchor.');
  }
  const siblings = [...snapshot.docs.values()]
    .filter((doc) => doc.id !== documentId && doc.archivedAt === null && doc.parentId === parentId)
    .sort((a, b) => a.position - b.position || a.id - b.id);

  const previousIndex =
    previousSiblingId === null
      ? -1
      : siblings.findIndex((sibling) => sibling.id === previousSiblingId);
  const nextIndex =
    nextSiblingId === null
      ? siblings.length
      : siblings.findIndex((sibling) => sibling.id === nextSiblingId);
  if (
    (previousSiblingId !== null && previousIndex < 0) ||
    (nextSiblingId !== null && nextIndex < 0) ||
    (previousSiblingId !== null && nextSiblingId !== null && previousIndex >= nextIndex)
  ) {
    throw new HttpError(409, 'Document order changed elsewhere. Reload it before moving.');
  }

  // Private siblings invisible to this caller may sit between two visible anchors.
  // Preserve their relative order and place the moved page immediately after the
  // previous anchor (or immediately before the next one at the start).
  const insertionIndex =
    previousSiblingId !== null ? previousIndex + 1 : nextSiblingId !== null ? nextIndex : 0;
  const candidate = safeDocumentPosition(
    siblings[insertionIndex - 1],
    siblings[insertionIndex],
    siblings,
  );
  if (candidate !== null) return { position: candidate, siblingPositions: [] };

  const orderedIds = siblings.map((sibling) => sibling.id);
  orderedIds.splice(insertionIndex, 0, documentId);
  return {
    position: (insertionIndex + 1) * POSITION_STEP,
    siblingPositions: orderedIds.map((id, index) => ({
      id,
      position: (index + 1) * POSITION_STEP,
    })),
  };
}

/** The page and the descendants visible to `userId` (a hidden page stops the walk). */
export function documentSubtreeIds(
  snapshot: TreeSnapshot,
  documentId: number,
  userId: string,
): number[] {
  const ids = new Set<number>([documentId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const doc of snapshot.docs.values()) {
      if (
        doc.parentId !== null &&
        ids.has(doc.parentId) &&
        !ids.has(doc.id) &&
        canSee(doc, userId)
      ) {
        ids.add(doc.id);
        changed = true;
      }
    }
  }
  return [...ids];
}

// ---------------------------------------------------------------------------------------
// Ports of the Postgres triggers, as statements of the write's batch.
// ---------------------------------------------------------------------------------------

const REVISION_COLUMNS = `parent_id, title, content, content_json, icon, metadata, full_width, is_private, is_locked, archived_at, position, owner_user_id`;
const DOCUMENT_REVISION_SELECT = `d.parent_id, d.title, d.content, d.content_json, d.icon, d.metadata, d.full_width, d.is_private, d.is_locked, d.archived_at, d.position, d.owner_user_id`;

/** Newest snapshots kept per page. */
export const REVISION_LIMIT = 20;
/** Consecutive content edits by the same actor within this window share one snapshot. */
export const COALESCE_WINDOW_MS = 10 * 60 * 1000;

type RevisionLike = {
  parentId: number | null;
  title: string;
  content: string;
  contentJson: unknown;
  icon: string | null;
  metadata: unknown;
  fullWidth: boolean;
  isPrivate: boolean;
  isLocked: boolean;
  archivedAt: Date | null;
  position: number;
  ownerUserId: string | null;
};

function sameStructure(a: RevisionLike, b: RevisionLike): boolean {
  return (
    a.parentId === b.parentId &&
    a.icon === b.icon &&
    JSON.stringify(a.metadata) === JSON.stringify(b.metadata) &&
    a.fullWidth === b.fullWidth &&
    a.isPrivate === b.isPrivate &&
    a.isLocked === b.isLocked &&
    (a.archivedAt?.getTime() ?? null) === (b.archivedAt?.getTime() ?? null) &&
    a.position === b.position &&
    a.ownerUserId === b.ownerUserId
  );
}

function sameBody(a: RevisionLike, b: RevisionLike): boolean {
  return (
    a.title === b.title &&
    a.content === b.content &&
    JSON.stringify(a.contentJson ?? null) === JSON.stringify(b.contentJson ?? null)
  );
}

/** Only the body changed, nothing structural: an edit, as opposed to a checkpoint. */
function isContentEdit(before: RevisionLike, after: RevisionLike): boolean {
  return sameStructure(before, after) && !sameBody(before, after);
}

export interface RevisionTail {
  /** Newest snapshot. */
  last: (RevisionLike & { id: number; createdByUserId: string | null; createdAt: Date }) | null;
  /** The one before it. */
  before: RevisionLike | null;
}

export async function readRevisionTail(db: Db, documentId: number): Promise<RevisionTail> {
  const rows = await db
    .select()
    .from(projectDocumentRevision)
    .where(eq(projectDocumentRevision.documentId, documentId))
    .orderBy(desc(projectDocumentRevision.version))
    .limit(2);
  return { last: rows[0] ?? null, before: rows[1] ?? null };
}

/**
 * capture_project_document_revision: decides, from the page before the write, whether the
 * new state replaces the newest snapshot (a quick content edit by the same actor) or adds
 * one. `checkpoint` forces a new snapshot (restoring a revision).
 */
export function coalesceTarget(
  tail: RevisionTail,
  before: RevisionLike,
  after: RevisionLike,
  actorId: string | null,
  now: number,
  checkpoint = false,
): number | null {
  if (checkpoint || !tail.last || !tail.before) return null;
  if (!isContentEdit(before, after)) return null;
  if (!isContentEdit(tail.before, tail.last)) return null;
  if (tail.last.createdByUserId !== actorId) return null;
  const at = tail.last.createdAt.getTime();
  if (at < now - COALESCE_WINDOW_MS || at > now) return null;
  return tail.last.id;
}

/**
 * Snapshot of the listed pages as they are in the batch. `coalesceInto` replaces that
 * snapshot instead of adding one (single page only). Always followed by the prune.
 */
export function captureRevisions(
  ok: Stmt,
  ids: number[] | 'last-insert',
  coalesceInto: number | null = null,
): Stmt[] {
  if (ids === 'last-insert') {
    // The page inserted by the statement right before: first snapshot, nothing to prune.
    return [
      {
        sql: `INSERT INTO project_document_revision (document_id, version, ${REVISION_COLUMNS}, created_by_user_id, created_at)
      SELECT d.id, d.version, ${DOCUMENT_REVISION_SELECT}, COALESCE(d.updated_by_user_id, d.created_by_user_id), d.updated_at
      FROM project_document d WHERE d.id = last_insert_rowid() AND ${ok.sql}`,
        params: [...ok.params],
      },
    ];
  }
  if (ids.length === 0) return [];
  const list = JSON.stringify(ids);
  const statements: Stmt[] = [];
  if (coalesceInto !== null) {
    statements.push(
      stmt`UPDATE project_document_revision SET
        version = d.version, parent_id = d.parent_id, title = d.title, content = d.content,
        content_json = d.content_json, icon = d.icon, metadata = d.metadata,
        full_width = d.full_width, is_private = d.is_private, is_locked = d.is_locked,
        archived_at = d.archived_at, position = d.position, owner_user_id = d.owner_user_id,
        created_by_user_id = COALESCE(d.updated_by_user_id, d.created_by_user_id),
        created_at = d.updated_at
      FROM project_document d
      WHERE project_document_revision.id = ${coalesceInto} AND d.id = ${ids[0]!} AND ${ok}`,
    );
  } else {
    statements.push({
      sql: `INSERT INTO project_document_revision (document_id, version, ${REVISION_COLUMNS}, created_by_user_id, created_at)
      SELECT d.id, d.version, ${DOCUMENT_REVISION_SELECT}, COALESCE(d.updated_by_user_id, d.created_by_user_id), d.updated_at
      FROM project_document d
      WHERE d.id IN (SELECT value FROM json_each(?)) AND ${ok.sql}
      ON CONFLICT (document_id, version) DO UPDATE SET
        parent_id = excluded.parent_id, title = excluded.title, content = excluded.content,
        content_json = excluded.content_json, icon = excluded.icon, metadata = excluded.metadata,
        full_width = excluded.full_width, is_private = excluded.is_private,
        is_locked = excluded.is_locked, archived_at = excluded.archived_at,
        position = excluded.position, owner_user_id = excluded.owner_user_id,
        created_by_user_id = excluded.created_by_user_id, created_at = excluded.created_at`,
      params: [list, ...ok.params],
    });
  }
  statements.push(stmt`DELETE FROM project_document_revision WHERE ${ok} AND id IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY document_id ORDER BY version DESC) AS rn
        FROM project_document_revision WHERE document_id IN (SELECT value FROM json_each(${list}))
      ) WHERE rn > ${REVISION_LIMIT}
    )`);
  return statements;
}

/** rev_document / rev_document_child: moves the `documents:<project>` sync marker. */
export function bumpDocumentsMarker(ok: Stmt, projectId: number): Stmt {
  return stmt`INSERT INTO revision (scope, project_id, rev)
    SELECT ${`documents:${projectId}`}, ${projectId}, 1 WHERE ${ok}
    ON CONFLICT (scope) DO UPDATE SET rev = revision.rev + 1`;
}

/** Renumbering of a sibling set in one statement (a single bound JSON parameter). */
export function renumberSiblings(
  ok: Stmt,
  projectId: number,
  positions: Array<{ id: number; position: number }>,
): Stmt[] {
  if (positions.length === 0) return [];
  const list = JSON.stringify(positions);
  return [
    stmt`UPDATE project_document SET position = (
        SELECT json_extract(j.value, '$.position') FROM json_each(${list}) AS j
        WHERE json_extract(j.value, '$.id') = project_document.id
      )
      WHERE project_id = ${projectId}
        AND id IN (SELECT json_extract(j.value, '$.id') FROM json_each(${list}) AS j)
        AND ${ok}`,
  ];
}

export function asRows<T>(result: D1Result | undefined): T[] {
  return (result?.results ?? []) as T[];
}
