import {
  documentAsset,
  project,
  projectDocument,
  projectDocumentPreference,
  projectDocumentRevision,
  projectMember,
  type Db,
} from '@repo/db';
import {
  getTableColumns,
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  like,
  or,
} from 'drizzle-orm';
import { HttpError, iso } from '#shared/lib';
import {
  assertAttachmentFileAllowed,
  attachmentObjectKey,
  attachmentQuotaCondition,
  cloneAttachmentObject,
  deleteAttachmentObject,
  quotaExceeded,
} from '#modules/attachments/storage';
import {
  assertValidParent,
  canSee,
  captureRevisions,
  coalesceTarget,
  documentSubtreeIds,
  EarlyResult,
  fencedBatch,
  json,
  nextPosition,
  planDocumentMove,
  readRevisionTail,
  renumberSiblings,
  stmt,
  treeWrite,
  type Bindable,
  type Stmt,
  type TreeDoc,
  type TreeSnapshot,
  d1Of,
} from './tree';

export interface DocumentSummaryRow {
  id: number;
  projectId: number;
  parentId: number | null;
  title: string;
  icon: string | null;
  metadata: Record<string, unknown>;
  fullWidth: boolean;
  isPrivate: boolean;
  isLocked: boolean;
  isFavorite: boolean;
  archivedAt: string | null;
  position: number;
  version: number;
  ownerUserId: string | null;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentRow extends DocumentSummaryRow {
  content: string;
  contentJson: Record<string, unknown> | null;
}

export interface DocumentRevisionSummaryRow {
  id: number;
  documentId: number;
  version: number;
  title: string;
  createdByUserId: string | null;
  createdAt: string;
}

export interface DocumentRevisionRow extends DocumentRevisionSummaryRow {
  parentId: number | null;
  content: string;
  contentJson: Record<string, unknown> | null;
  icon: string | null;
  metadata: Record<string, unknown>;
  fullWidth: boolean;
  isPrivate: boolean;
  isLocked: boolean;
  archivedAt: string | null;
  position: number;
}

export interface DocumentAssetRow {
  publicId: string;
  documentId: number;
  uploadedByUserId: string | null;
  s3Key: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
}

type DocumentModel = typeof projectDocument.$inferSelect;

function documentAccess(userId: string) {
  return or(eq(projectDocument.isPrivate, false), eq(projectDocument.ownerUserId, userId));
}

function mapDocument(row: DocumentModel, isFavorite = false): DocumentRow {
  const { archivedByAncestorId: _archivedByAncestorId, ...publicRow } = row;
  return {
    ...publicRow,
    isFavorite,
    archivedAt: row.archivedAt ? iso(row.archivedAt) : null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function summaryOf(row: DocumentModel, isFavorite = false): DocumentSummaryRow {
  const { content: _content, contentJson: _contentJson, ...summary } = mapDocument(row, isFavorite);
  return summary;
}

function mapRevision(row: typeof projectDocumentRevision.$inferSelect): DocumentRevisionRow {
  const { ownerUserId: _ownerUserId, ...publicRow } = row;
  return {
    ...publicRow,
    archivedAt: row.archivedAt ? iso(row.archivedAt) : null,
    createdAt: iso(row.createdAt),
  };
}

function mapAsset(row: typeof documentAsset.$inferSelect): DocumentAssetRow {
  return { ...row, createdAt: iso(row.createdAt) };
}

// The URL of a document asset. It is stored in the document body, so it names the
// team by its id: a slug can change later, the id cannot.
export function documentAssetPath(
  project: { teamId: number; key: string },
  documentId: number,
  publicId: string,
): string {
  const ref = encodeURIComponent(`${project.teamId}.${project.key}`);
  return `/projects/${ref}/documents/${documentId}/assets/${publicId}/raw`;
}

export function replaceAssetReferences<T>(
  value: T,
  sourceDocumentId: number,
  targetProject: { teamId: number; key: string },
  targetDocumentId: number,
  publicIds: Map<string, string>,
): T {
  if (typeof value === 'string') {
    const replaced = value.replace(
      new RegExp(
        `(/(?:protected-)?media)?/projects/[^/\\s"']+/documents/${sourceDocumentId}/assets/([0-9a-f-]{36})/raw`,
        'gi',
      ),
      (match, mediaPrefix: string | undefined, publicId: string) => {
        const targetPublicId = publicIds.get(publicId.toLowerCase());
        return targetPublicId
          ? `${mediaPrefix ?? ''}${documentAssetPath(targetProject, targetDocumentId, targetPublicId)}`
          : match;
      },
    );
    return replaced as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      replaceAssetReferences(item, sourceDocumentId, targetProject, targetDocumentId, publicIds),
    ) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        replaceAssetReferences(item, sourceDocumentId, targetProject, targetDocumentId, publicIds),
      ]),
    ) as T;
  }
  return value;
}

function revisionSummaryOf(
  row: typeof projectDocumentRevision.$inferSelect,
): DocumentRevisionSummaryRow {
  const {
    parentId: _parentId,
    content: _content,
    contentJson: _contentJson,
    icon: _icon,
    metadata: _metadata,
    fullWidth: _fullWidth,
    isPrivate: _isPrivate,
    isLocked: _isLocked,
    archivedAt: _archivedAt,
    position: _position,
    ...summary
  } = mapRevision(row);
  return summary;
}

async function favoriteDocumentIds(
  db: Db,
  userId: string,
  documentIds: number[],
): Promise<Set<number>> {
  if (documentIds.length === 0) return new Set();
  const favorites = new Set<number>();
  // D1 binds at most 100 parameters: ids go in chunks.
  for (let offset = 0; offset < documentIds.length; offset += 90) {
    const rows = await db
      .select({ documentId: projectDocumentPreference.documentId })
      .from(projectDocumentPreference)
      .where(
        and(
          eq(projectDocumentPreference.userId, userId),
          eq(projectDocumentPreference.isFavorite, true),
          inArray(projectDocumentPreference.documentId, documentIds.slice(offset, offset + 90)),
        ),
      );
    for (const row of rows) favorites.add(row.documentId);
  }
  return favorites;
}

export async function listDocuments(
  db: Db,
  projectId: number,
  userId: string,
  options: { q?: string; archived?: boolean } = {},
): Promise<DocumentSummaryRow[]> {
  const term = options.q?.trim();
  const conditions = [
    eq(projectDocument.projectId, projectId),
    documentAccess(userId),
    options.archived ? isNotNull(projectDocument.archivedAt) : isNull(projectDocument.archivedAt),
  ];
  if (term) {
    // LIKE is case-insensitive for ASCII only on SQLite (ilike on Postgres was for all).
    conditions.push(
      or(like(projectDocument.title, `%${term}%`), like(projectDocument.content, `%${term}%`)),
    );
  }
  const {
    content: _content,
    contentJson: _contentJson,
    ...columns
  } = getTableColumns(projectDocument);
  const rows = await db
    .select(columns)
    .from(projectDocument)
    .where(and(...conditions))
    .orderBy(asc(projectDocument.position), asc(projectDocument.id));
  const visibleIds = new Set(rows.map((row) => row.id));
  const favorites = await favoriteDocumentIds(
    db,
    userId,
    rows.map((row) => row.id),
  );
  return rows.map((row) => ({
    ...summaryOf({ ...row, content: '', contentJson: null }, favorites.has(row.id)),
    parentId: row.parentId !== null && visibleIds.has(row.parentId) ? row.parentId : null,
  }));
}

async function selectDocument(db: Db, projectId: number, documentId: number, userId: string) {
  const [row] = await db
    .select()
    .from(projectDocument)
    .where(
      and(
        eq(projectDocument.id, documentId),
        eq(projectDocument.projectId, projectId),
        documentAccess(userId),
      ),
    );
  return row ?? null;
}

export async function getDocument(
  db: Db,
  projectId: number,
  documentId: number,
  userId: string,
): Promise<DocumentRow | null> {
  const row = await selectDocument(db, projectId, documentId, userId);
  if (!row) return null;
  return mapDocumentForUser(db, row, userId);
}

export async function listDocumentAssets(
  db: Db,
  projectId: number,
  documentId: number,
  userId: string,
): Promise<DocumentAssetRow[] | null> {
  if (!(await selectDocument(db, projectId, documentId, userId))) return null;
  const rows = await db
    .select()
    .from(documentAsset)
    .where(eq(documentAsset.documentId, documentId))
    .orderBy(asc(documentAsset.createdAt), asc(documentAsset.id));
  return rows.map(mapAsset);
}

export async function assertDocumentAssetUploadTarget(
  db: Db,
  projectId: number,
  documentId: number,
  userId: string,
): Promise<boolean> {
  const current = await selectDocument(db, projectId, documentId, userId);
  if (!current) return false;
  assertActive(current);
  assertUnlocked(current);
  return true;
}

// The page is still there, visible, active and unlocked: what an asset write relies on.
function openDocumentGuard(projectId: number, documentId: number, userId: string): Stmt {
  return stmt`EXISTS (SELECT 1 FROM project_document WHERE id = ${documentId} AND project_id = ${projectId}
    AND archived_at IS NULL AND is_locked = 0 AND (is_private = 0 OR owner_user_id = ${userId}))`;
}

export async function createDocumentAsset(
  db: Db,
  input: {
    projectId: number;
    documentId: number;
    userId: string;
    s3Key: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
  },
): Promise<DocumentAssetRow | null> {
  const current = await selectDocument(db, input.projectId, input.documentId, input.userId);
  if (!current) return null;
  assertActive(current);
  assertUnlocked(current);
  // The quota is part of the fence: the insert happens only if the bytes still fit.
  const quota = await attachmentQuotaCondition(db, input.projectId, input.sizeBytes);
  const publicId = crypto.randomUUID();
  const { applied } = await fencedBatch(db, {
    projectId: input.projectId,
    rev: null,
    guard: stmt`${openDocumentGuard(input.projectId, input.documentId, input.userId)} AND ${quota}`,
    build: (ok) => [
      stmt`INSERT INTO document_asset (public_id, document_id, uploaded_by_user_id, s3_key, filename, content_type, size_bytes)
        SELECT ${publicId}, ${input.documentId}, ${input.userId}, ${input.s3Key}, ${input.filename}, ${input.contentType}, ${input.sizeBytes}
        WHERE ${ok}`,
    ],
  });
  if (!applied) {
    const again = await selectDocument(db, input.projectId, input.documentId, input.userId);
    if (!again) return null;
    assertActive(again);
    assertUnlocked(again);
    throw await quotaExceeded(db, input.projectId, input.sizeBytes);
  }
  const [row] = await db.select().from(documentAsset).where(eq(documentAsset.publicId, publicId));
  return row ? mapAsset(row) : null;
}

export async function getDocumentAsset(
  db: Db,
  projectId: number,
  documentId: number,
  publicId: string,
  userId: string,
): Promise<DocumentAssetRow | null> {
  if (!(await selectDocument(db, projectId, documentId, userId))) return null;
  const [row] = await db
    .select()
    .from(documentAsset)
    .where(and(eq(documentAsset.documentId, documentId), eq(documentAsset.publicId, publicId)));
  return row ? mapAsset(row) : null;
}

export async function deleteDocumentAsset(
  db: Db,
  projectId: number,
  documentId: number,
  publicId: string,
  userId: string,
  isProjectOwner: boolean,
): Promise<DocumentAssetRow | null> {
  const current = await ownedDocument(db, projectId, documentId, userId, isProjectOwner);
  if (!current) return null;
  assertActive(current);
  assertUnlocked(current);
  const existing = await getDocumentAsset(db, projectId, documentId, publicId, userId);
  if (!existing) return null;
  const { applied } = await fencedBatch(db, {
    projectId,
    rev: null,
    guard: openDocumentGuard(projectId, documentId, userId),
    build: (ok) => [
      stmt`DELETE FROM document_asset WHERE document_id = ${documentId} AND public_id = ${publicId} AND ${ok}`,
    ],
  });
  if (!applied) {
    const again = await selectDocument(db, projectId, documentId, userId);
    if (!again) return null;
    assertActive(again);
    assertUnlocked(again);
    throw new HttpError(409, 'This document changed elsewhere. Reload it before continuing.');
  }
  return existing;
}

async function mapDocumentForUser(
  db: Db,
  row: DocumentModel,
  userId: string,
): Promise<DocumentRow> {
  const favorites = await favoriteDocumentIds(db, userId, [row.id]);
  const parentId = await visibleDocumentParentId(db, row.projectId, row.parentId, userId);
  return mapDocument({ ...row, parentId }, favorites.has(row.id));
}

async function visibleDocumentParentId(
  db: Db,
  projectId: number,
  parentId: number | null,
  userId: string,
): Promise<number | null> {
  if (parentId === null) return null;
  const [parent] = await db
    .select({ id: projectDocument.id })
    .from(projectDocument)
    .where(
      and(
        eq(projectDocument.id, parentId),
        eq(projectDocument.projectId, projectId),
        documentAccess(userId),
      ),
    );
  return parent?.id ?? null;
}

// Foreign keys replace the `FOR KEY SHARE` lock on the acting user: a user deleted while
// a write is in flight makes the batch fail, which reads as the 404 it always was.
async function writing<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof Error && /FOREIGN KEY/i.test(`${error.message} ${String(error.cause)}`)) {
      throw new HttpError(404, 'User not found');
    }
    throw error;
  }
}

// The columns a write sets, as `column = ?` pairs (booleans become 0/1).
type Assignments = Array<[column: string, value: Bindable | boolean]>;

function assignments(sets: Assignments): Stmt {
  const params: Bindable[] = [];
  const text = sets
    .map(([column, value]) => {
      params.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
      return `${column} = ?`;
    })
    .join(', ');
  return { sql: text, params };
}

// UPDATE of one page: version + 1, updated_at, and the caller's columns. Applies only when
// the batch's fence passed (and, redundantly, on the expected version).
function updateDocumentStatement(
  ok: Stmt,
  projectId: number,
  documentId: number,
  version: number,
  userId: string,
  now: number,
  sets: Assignments,
): Stmt {
  const columns = assignments([...sets, ['updated_by_user_id', userId], ['updated_at', now]]);
  return stmt`UPDATE project_document SET ${columns}, version = version + 1
    WHERE id = ${documentId} AND project_id = ${projectId} AND version = ${version} AND ${ok}`;
}

function versionGuard(documentId: number, version: number): Stmt {
  return stmt`EXISTS (SELECT 1 FROM project_document WHERE id = ${documentId} AND version = ${version})`;
}

export async function createDocument(
  db: Db,
  input: {
    projectId: number;
    userId: string;
    title?: string;
    content?: string;
    contentJson?: Record<string, unknown> | null;
    icon?: string | null;
    metadata?: Record<string, unknown>;
    fullWidth?: boolean;
    isPrivate?: boolean;
    parentId?: number | null;
  },
): Promise<DocumentRow> {
  assertValidDocumentContentJson(input.contentJson);
  assertValidMetadata(input.metadata);
  const parentId = input.parentId ?? null;
  const id = await writing(() =>
    treeWrite(db, input.projectId, (snapshot) => {
      assertValidParent(snapshot, null, parentId, input.userId);
      const position = nextPosition(snapshot, parentId);
      const now = Date.now();
      return {
        build: (ok) => [
          stmt`INSERT INTO project_document (project_id, parent_id, title, content, content_json, icon, metadata,
              full_width, is_private, position, owner_user_id, created_by_user_id, updated_by_user_id, created_at, updated_at)
            SELECT ${input.projectId}, ${parentId}, ${input.title ?? ''}, ${input.content ?? ''}, ${json(input.contentJson ?? null)},
              ${input.icon ?? null}, ${json(input.metadata ?? {})}, ${input.fullWidth ?? false}, ${input.isPrivate ?? false},
              ${position}, ${input.userId}, ${input.userId}, ${input.userId}, ${now}, ${now}
            WHERE ${ok}`,
          ...captureRevisions(ok, 'last-insert'),
        ],
        result: (results) => results[0]!.meta.last_row_id,
      };
    }),
  );
  const row = await selectDocument(db, input.projectId, id, input.userId);
  if (!row) throw new HttpError(404, 'Document not found');
  return mapDocumentForUser(db, row, input.userId);
}

function assertExpectedVersion(row: { version: number }, expected: number): void {
  if (row.version !== expected) {
    throw new HttpError(409, 'This document changed elsewhere. Reload it before continuing.');
  }
}

function assertActive(row: { archivedAt: Date | null }): void {
  if (row.archivedAt !== null) {
    throw new HttpError(409, 'Restore this document before changing it.');
  }
}

function assertUnlocked(row: { isLocked: boolean }): void {
  if (row.isLocked) {
    throw new HttpError(409, 'Unlock this document before changing it.');
  }
}

const MAX_DOCUMENT_JSON_BYTES = 1_000_000;

const MAX_DOCUMENT_JSON_NODES = 10_000;
const MAX_DOCUMENT_JSON_DEPTH = 100;
const MAX_DOCUMENT_METADATA_BYTES = 16_384;
const DOCUMENT_NODE_TYPES = new Set([
  'doc',
  'paragraph',
  'text',
  'blockquote',
  'bulletList',
  'orderedList',
  'listItem',
  'heading',
  'horizontalRule',
  'hardBreak',
  'codeBlock',
  'image',
  'table',
  'tableRow',
  'tableHeader',
  'tableCell',
  'taskList',
  'taskItem',
]);
const DOCUMENT_MARK_TYPES = new Set([
  'bold',
  'italic',
  'strike',
  'code',
  'link',
  'textStyle',
  'underline',
  'highlight',
]);

const TEXT_ALIGN = ['left', 'center', 'right'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertJsonByteSize(value: unknown, maximum: number, field: string): void {
  let bytes: number;
  try {
    bytes = new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    throw new HttpError(400, `${field} must contain valid JSON values.`);
  }
  if (bytes > maximum) throw new HttpError(400, `${field} exceeds the ${maximum} byte limit.`);
}

function documentAttributes(value: Record<string, unknown>): Record<string, unknown> {
  if (value.attrs == null) return {};
  if (!isRecord(value.attrs)) throw new HttpError(400, 'Document attrs must be an object.');
  return value.attrs;
}

function assertAllowedAttributes(
  attrs: Record<string, unknown>,
  allowed: readonly string[],
  context: string,
): void {
  const allowedKeys = new Set([...allowed, 'blockId']);
  if (
    attrs.blockId != null &&
    (typeof attrs.blockId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(attrs.blockId))
  )
    throw new HttpError(400, 'Invalid document block identifier.');
  const unknown = Object.keys(attrs).find((key) => !allowedKeys.has(key));
  if (unknown) throw new HttpError(400, `${context} contains an unsupported "${unknown}" attr.`);
}

function assertOptionalBoolean(value: unknown, context: string): void {
  if (value != null && typeof value !== 'boolean') {
    throw new HttpError(400, `${context} must be a boolean.`);
  }
}

function assertOptionalOneOf(value: unknown, allowed: readonly string[], context: string): void {
  if (value == null || allowed.includes(String(value))) return;
  const list =
    allowed.length < 3
      ? allowed.join(' or ')
      : `${allowed.slice(0, -1).join(', ')}, or ${allowed[allowed.length - 1]}`;
  throw new HttpError(400, `${context} must be ${list}.`);
}

function assertOptionalBoundedString(value: unknown, maximum: number, context: string): void {
  if (value == null) return;
  if (typeof value !== 'string' || value.length > maximum) {
    throw new HttpError(400, `${context} must be a string no longer than ${maximum} characters.`);
  }
}

function containsUnsafeUrlCharacter(value: string): boolean {
  return [...value].some(
    (character) => character === '\\' || /[\p{White_Space}\p{Cc}\p{Cf}]/u.test(character),
  );
}

function assertSafeLinkHref(value: unknown): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) {
    throw new HttpError(400, 'A link href must be a non-empty string up to 2048 characters.');
  }
  if (containsUnsafeUrlCharacter(value)) {
    throw new HttpError(400, 'A link href cannot contain whitespace, controls, or backslashes.');
  }
  if (value.startsWith('#')) return;
  if (value.startsWith('/') && !value.startsWith('//')) return;
  if (/^(mailto:|tel:)/i.test(value)) {
    if (value.slice(value.indexOf(':') + 1).length > 0) return;
    throw new HttpError(400, 'A mailto or tel link must contain a destination.');
  }
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      !parsed.username &&
      !parsed.password
    ) {
      return;
    }
  } catch {
    // Fall through to the uniform validation error below.
  }
  throw new HttpError(400, 'A link href must use http, https, mailto, tel, /path, or #anchor.');
}

const DOCUMENT_ASSET_PATH =
  /^\/(?:protected-media\/)?projects\/[A-Za-z0-9._~%+-]+\/documents\/[1-9]\d*\/assets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/raw$/i;

function assertSafeImageSource(value: unknown): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096) {
    throw new HttpError(400, 'An image src must be a non-empty string up to 4096 characters.');
  }
  if (containsUnsafeUrlCharacter(value)) {
    throw new HttpError(400, 'An image src cannot contain whitespace, controls, or backslashes.');
  }
  if (DOCUMENT_ASSET_PATH.test(value)) return;
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      !parsed.username &&
      !parsed.password
    ) {
      return;
    }
  } catch {
    // Fall through to the uniform validation error below.
  }
  throw new HttpError(400, 'An image src must use http, https, or a protected Docs asset URL.');
}

function assertSafeColor(value: unknown): void {
  if (
    value !== undefined &&
    value !== null &&
    (typeof value !== 'string' ||
      !/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value))
  ) {
    throw new HttpError(400, 'Document colors must use a hexadecimal color value.');
  }
}

function assertDocumentNodeAttributes(node: Record<string, unknown>): void {
  const attrs = documentAttributes(node);
  switch (node.type) {
    case 'paragraph':
      assertAllowedAttributes(attrs, ['textAlign'], 'A paragraph');
      assertOptionalOneOf(attrs.textAlign, TEXT_ALIGN, 'Paragraph textAlign');
      return;
    case 'heading':
      assertAllowedAttributes(attrs, ['level', 'textAlign'], 'A heading');
      if (!Number.isInteger(attrs.level) || Number(attrs.level) < 1 || Number(attrs.level) > 6) {
        throw new HttpError(400, 'Heading level must be an integer from 1 to 6.');
      }
      assertOptionalOneOf(attrs.textAlign, TEXT_ALIGN, 'Heading textAlign');
      return;
    case 'image': {
      assertAllowedAttributes(attrs, ['src', 'alt', 'title', 'width', 'style'], 'An image');
      assertSafeImageSource(attrs.src);
      assertOptionalBoundedString(attrs.alt, 1_000, 'Image alt');
      assertOptionalBoundedString(attrs.title, 1_000, 'Image title');
      if (
        attrs.width != null &&
        (!Number.isInteger(attrs.width) || Number(attrs.width) < 1 || Number(attrs.width) > 4_096)
      ) {
        throw new HttpError(400, 'Image width must be an integer from 1 to 4096.');
      }
      if (
        attrs.style != null &&
        (typeof attrs.style !== 'string' || !/^max-width: *(?:100|[1-9]\d?)%;?$/i.test(attrs.style))
      ) {
        throw new HttpError(400, 'Image style may only contain a max-width percentage.');
      }
      return;
    }
    case 'taskItem':
      assertAllowedAttributes(attrs, ['checked'], 'A task item');
      if (attrs.checked !== undefined && typeof attrs.checked !== 'boolean') {
        throw new HttpError(400, 'Task item checked must be a boolean.');
      }
      return;
    case 'tableCell':
    case 'tableHeader': {
      assertAllowedAttributes(attrs, ['colspan', 'rowspan', 'colwidth', 'align'], 'A table cell');
      assertOptionalOneOf(attrs.align, TEXT_ALIGN, 'Table cell align');
      for (const key of ['colspan', 'rowspan'] as const) {
        const span = attrs[key];
        if (
          span !== undefined &&
          (!Number.isInteger(span) || Number(span) < 1 || Number(span) > 100)
        ) {
          throw new HttpError(400, `Table ${key} must be an integer from 1 to 100.`);
        }
      }
      if (
        attrs.colwidth != null &&
        (!Array.isArray(attrs.colwidth) ||
          attrs.colwidth.length === 0 ||
          attrs.colwidth.length > 100 ||
          attrs.colwidth.some(
            (width) => !Number.isInteger(width) || Number(width) < 1 || Number(width) > 10_000,
          ))
      ) {
        throw new HttpError(400, 'Table colwidth must contain positive integer widths.');
      }
      return;
    }
    case 'bulletList':
      assertAllowedAttributes(attrs, ['tight'], 'A bullet list');
      assertOptionalBoolean(attrs.tight, 'List tight');
      return;
    case 'orderedList':
      assertAllowedAttributes(attrs, ['start', 'tight', 'type'], 'An ordered list');
      assertOptionalBoolean(attrs.tight, 'List tight');
      assertOptionalOneOf(attrs.type, ['a', 'A', 'i', 'I', '1'], 'Ordered-list type');
      if (
        attrs.start !== undefined &&
        (!Number.isInteger(attrs.start) ||
          Number(attrs.start) < 1 ||
          Number(attrs.start) > 1_000_000)
      ) {
        throw new HttpError(400, 'Ordered-list start must be a positive integer.');
      }
      return;
    case 'codeBlock':
      assertAllowedAttributes(attrs, ['language'], 'A code block');
      assertOptionalBoundedString(attrs.language, 100, 'Code-block language');
      return;
    default:
      assertAllowedAttributes(attrs, [], `A ${String(node.type)} node`);
  }
}

function assertDocumentMarkAttributes(mark: Record<string, unknown>): void {
  const attrs = documentAttributes(mark);
  switch (mark.type) {
    case 'link':
      assertAllowedAttributes(attrs, ['href', 'target', 'rel', 'class', 'title'], 'A link');
      assertOptionalBoundedString(attrs.title, 1_000, 'Link title');
      assertSafeLinkHref(attrs.href);
      assertOptionalOneOf(attrs.target, ['_blank', '_self'], 'Link target');
      assertOptionalBoundedString(attrs.rel, 200, 'Link rel');
      if (typeof attrs.rel === 'string' && !/^[a-z -]*$/i.test(attrs.rel)) {
        throw new HttpError(400, 'Link rel contains unsupported characters.');
      }
      assertOptionalBoundedString(attrs.class, 200, 'Link class');
      if (typeof attrs.class === 'string' && !/^[a-z0-9 _-]*$/i.test(attrs.class)) {
        throw new HttpError(400, 'Link class contains unsupported characters.');
      }
      return;
    case 'textStyle':
    case 'highlight':
      assertAllowedAttributes(attrs, ['color'], `A ${String(mark.type)} mark`);
      assertSafeColor(attrs.color);
      return;
    default:
      assertAllowedAttributes(attrs, [], `A ${String(mark.type)} mark`);
  }
}

function assertDocumentJsonNode(value: unknown, depth: number, counter: { value: number }): void {
  if (!isRecord(value) || typeof value.type !== 'string' || !DOCUMENT_NODE_TYPES.has(value.type)) {
    throw new HttpError(400, 'contentJson contains an unsupported document node.');
  }
  counter.value += 1;
  if (counter.value > MAX_DOCUMENT_JSON_NODES || depth > MAX_DOCUMENT_JSON_DEPTH) {
    throw new HttpError(400, 'contentJson is too deeply nested or contains too many nodes.');
  }
  if (value.type === 'text' && typeof value.text !== 'string') {
    throw new HttpError(400, 'A contentJson text node must contain text.');
  }
  assertDocumentNodeAttributes(value);
  if ('content' in value) {
    if (!Array.isArray(value.content)) {
      throw new HttpError(400, 'contentJson node content must be an array.');
    }
    for (const child of value.content) assertDocumentJsonNode(child, depth + 1, counter);
  }
  if ('marks' in value) {
    if (!Array.isArray(value.marks)) {
      throw new HttpError(400, 'contentJson node marks must be an array.');
    }
    for (const mark of value.marks) {
      if (!isRecord(mark) || typeof mark.type !== 'string' || !DOCUMENT_MARK_TYPES.has(mark.type)) {
        throw new HttpError(400, 'contentJson contains an unsupported document mark.');
      }
      assertDocumentMarkAttributes(mark);
    }
  }
}

export function assertValidDocumentContentJson(
  value: Record<string, unknown> | null | undefined,
): void {
  if (value == null) return;
  if (!isRecord(value) || value.type !== 'doc') {
    throw new HttpError(400, 'contentJson must be a Tiptap document object.');
  }
  assertJsonByteSize(value, MAX_DOCUMENT_JSON_BYTES, 'contentJson');
  assertDocumentJsonNode(value, 0, { value: 0 });
}

function assertValidMetadata(value: Record<string, unknown> | undefined): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new HttpError(400, 'metadata must be an object.');
  assertJsonByteSize(value, MAX_DOCUMENT_METADATA_BYTES, 'metadata');
}

type UpdateDocumentInput = {
  version: number;
  title?: string;
  content?: string;
  contentJson?: Record<string, unknown> | null;
  icon?: string | null;
  metadata?: Record<string, unknown>;
  fullWidth?: boolean;
  parentId?: number | null;
  position?: number;
  previousSiblingId?: number | null;
  nextSiblingId?: number | null;
};

// Editing the body invalidates the live editing session and detaches the comment anchors.
function dropCollaboration(ok: Stmt, documentId: number): Stmt[] {
  return [
    stmt`DELETE FROM document_collaboration WHERE document_id = ${documentId} AND ${ok}`,
    stmt`UPDATE document_comment SET orphaned = 1 WHERE document_id = ${documentId} AND ${ok}`,
  ];
}

export async function updateDocument(
  db: Db,
  projectId: number,
  documentId: number,
  userId: string,
  input: UpdateDocumentInput,
): Promise<DocumentRow | null> {
  assertValidDocumentContentJson(input.contentJson);
  assertValidMetadata(input.metadata);
  const anchoredMove = input.previousSiblingId !== undefined || input.nextSiblingId !== undefined;
  if (anchoredMove && (input.parentId === undefined || input.position === undefined)) {
    throw new HttpError(400, 'An anchored move requires parentId and position.');
  }
  if (input.position !== undefined && !Number.isFinite(input.position)) {
    throw new HttpError(400, 'Document position must be finite.');
  }
  const touchesTree = input.parentId !== undefined || input.position !== undefined;
  const contentChanged = input.content !== undefined || input.contentJson !== undefined;

  // Builds the batch from the page as it is now and, for a tree write, the tree snapshot.
  const prepare = async (snapshot: TreeSnapshot | null) => {
    const current = await selectDocument(db, projectId, documentId, userId);
    if (!current) throw new EarlyResult(null);
    assertExpectedVersion(current, input.version);
    assertActive(current);
    assertUnlocked(current);
    if (input.parentId !== undefined) {
      assertValidParent(snapshot!, documentId, input.parentId, userId);
    }
    const movePlan = anchoredMove
      ? planDocumentMove(
          snapshot!,
          documentId,
          input.parentId!,
          input.previousSiblingId ?? null,
          input.nextSiblingId ?? null,
        )
      : null;
    const now = Date.now();
    const sets: Assignments = [];
    if (input.title !== undefined) sets.push(['title', input.title]);
    if (input.content !== undefined) sets.push(['content', input.content]);
    const nextContentJson =
      input.contentJson !== undefined
        ? input.contentJson
        : input.content !== undefined
          ? null
          : current.contentJson;
    if (input.contentJson !== undefined || input.content !== undefined) {
      sets.push(['content_json', json(nextContentJson)]);
    }
    if (input.icon !== undefined) sets.push(['icon', input.icon]);
    if (input.metadata !== undefined) sets.push(['metadata', json(input.metadata)]);
    if (input.fullWidth !== undefined) sets.push(['full_width', input.fullWidth]);
    if (input.parentId !== undefined) sets.push(['parent_id', input.parentId]);
    const nextPositionValue = movePlan?.position ?? input.position;
    if (nextPositionValue !== undefined) sets.push(['position', nextPositionValue]);

    const after = {
      ...current,
      title: input.title ?? current.title,
      content: input.content ?? current.content,
      contentJson: nextContentJson,
      icon: input.icon !== undefined ? input.icon : current.icon,
      metadata: input.metadata ?? current.metadata,
      fullWidth: input.fullWidth ?? current.fullWidth,
      parentId: input.parentId !== undefined ? input.parentId : current.parentId,
      position: nextPositionValue ?? current.position,
    };
    const tail = await readRevisionTail(db, documentId);
    const coalesceInto = coalesceTarget(tail, current, after, userId, now);
    // Position normalization is not page history: siblings are renumbered without a new
    // version or snapshot, only the sync marker moves.
    const normalized = (movePlan?.siblingPositions ?? []).filter((s) => s.id !== documentId);

    return {
      guard: versionGuard(documentId, input.version),
      build: (ok: Stmt) => [
        updateDocumentStatement(ok, projectId, documentId, input.version, userId, now, sets),
        ...(contentChanged ? dropCollaboration(ok, documentId) : []),
        ...renumberSiblings(ok, projectId, normalized),
        ...captureRevisions(ok, [documentId], coalesceInto),
      ],
      result: () => 'ok' as const,
    };
  };

  let outcome: 'ok' | null;
  if (touchesTree) {
    outcome = await treeWrite<'ok' | null>(db, projectId, (snapshot) => prepare(snapshot));
  } else {
    try {
      const write = await prepare(null);
      const { applied } = await fencedBatch(db, {
        projectId,
        rev: null,
        guard: write.guard,
        build: write.build,
      });
      if (!applied) {
        // The page moved on between the read and the write: report what is there now.
        const again = await selectDocument(db, projectId, documentId, userId);
        if (!again) return null;
        assertExpectedVersion(again, input.version);
        throw new HttpError(409, 'This document changed elsewhere. Reload it before continuing.');
      }
      outcome = 'ok';
    } catch (error) {
      if (error instanceof EarlyResult) return null;
      throw error;
    }
  }
  if (outcome === null) return null;
  const row = await selectDocument(db, projectId, documentId, userId);
  return row ? mapDocumentForUser(db, row, userId) : null;
}

async function ownedDocument(
  db: Db,
  projectId: number,
  documentId: number,
  userId: string,
  isProjectOwner: boolean,
) {
  const current = await selectDocument(db, projectId, documentId, userId);
  if (!current) return null;
  assertOwned(current, userId, isProjectOwner);
  return current;
}

function assertOwned(
  doc: { ownerUserId: string | null; isPrivate: boolean },
  userId: string,
  isProjectOwner: boolean,
): void {
  if (doc.ownerUserId !== userId && !(isProjectOwner && !doc.isPrivate)) {
    throw new HttpError(403, 'Only the document owner can change this setting.');
  }
}

// One-page change of access, ownership or lock: a tree write (it moves the tree revision),
// followed by a checkpoint snapshot.
async function mutateDocument(
  db: Db,
  o: {
    projectId: number;
    documentId: number;
    userId: string;
    version: number;
    isProjectOwner: boolean;
    check: (doc: TreeDoc) => Promise<{ sets: Assignments; guard?: Stmt } | 'unchanged'>;
  },
): Promise<DocumentRow | null> {
  const outcome = await writing(() =>
    treeWrite<'changed' | 'unchanged' | null>(db, o.projectId, async (snapshot) => {
      const doc = snapshot.docs.get(o.documentId);
      if (!doc || !canSee(doc, o.userId)) throw new EarlyResult(null);
      assertOwned(doc, o.userId, o.isProjectOwner);
      assertExpectedVersion(doc, o.version);
      const change = await o.check(doc);
      if (change === 'unchanged') throw new EarlyResult('unchanged' as const);
      const now = Date.now();
      return {
        guard: change.guard
          ? stmt`${versionGuard(o.documentId, o.version)} AND ${change.guard}`
          : versionGuard(o.documentId, o.version),
        build: (ok) => [
          updateDocumentStatement(
            ok,
            o.projectId,
            o.documentId,
            o.version,
            o.userId,
            now,
            change.sets,
          ),
          ...captureRevisions(ok, [o.documentId]),
        ],
        result: () => 'changed' as const,
      };
    }),
  );
  if (outcome === null) return null;
  const row = await selectDocument(db, o.projectId, o.documentId, o.userId);
  return row ? mapDocumentForUser(db, row, o.userId) : null;
}

export async function setDocumentAccess(
  db: Db,
  projectId: number,
  documentId: number,
  userId: string,
  version: number,
  isPrivate: boolean,
): Promise<DocumentRow | null> {
  return mutateDocument(db, {
    projectId,
    documentId,
    userId,
    version,
    isProjectOwner: false,
    check: async (doc) => {
      assertActive(doc);
      return doc.isPrivate === isPrivate ? 'unchanged' : { sets: [['is_private', isPrivate]] };
    },
  });
}

export async function transferDocumentOwnership(
  db: Db,
  projectId: number,
  documentId: number,
  userId: string,
  version: number,
  ownerUserId: string,
  isProjectOwner: boolean,
): Promise<DocumentRow | null> {
  return mutateDocument(db, {
    projectId,
    documentId,
    userId,
    version,
    isProjectOwner,
    check: async (doc) => {
      const [target] = await db
        .select({ userId: projectMember.userId })
        .from(projectMember)
        .where(and(eq(projectMember.projectId, projectId), eq(projectMember.userId, ownerUserId)));
      if (!target) throw new HttpError(400, 'The new document owner must belong to this project.');
      if (doc.ownerUserId === ownerUserId) return 'unchanged';
      return {
        sets: [['owner_user_id', ownerUserId]],
        // The new owner must still be a member when the write lands.
        guard: stmt`EXISTS (SELECT 1 FROM project_member WHERE project_id = ${projectId} AND user_id = ${ownerUserId})`,
      };
    },
  });
}

export async function setDocumentLocked(
  db: Db,
  projectId: number,
  documentId: number,
  userId: string,
  version: number,
  isLocked: boolean,
  isProjectOwner: boolean,
): Promise<DocumentRow | null> {
  return mutateDocument(db, {
    projectId,
    documentId,
    userId,
    version,
    isProjectOwner,
    check: async (doc) => {
      assertActive(doc);
      return doc.isLocked === isLocked ? 'unchanged' : { sets: [['is_locked', isLocked]] };
    },
  });
}

export async function archiveDocument(
  db: Db,
  projectId: number,
  documentId: number,
  userId: string,
  version: number,
  isProjectOwner: boolean,
): Promise<DocumentRow | null> {
  const outcome = await treeWrite<'ok' | null>(db, projectId, (snapshot) => {
    const doc = snapshot.docs.get(documentId);
    if (!doc || !canSee(doc, userId)) throw new EarlyResult(null);
    assertOwned(doc, userId, isProjectOwner);
    assertExpectedVersion(doc, version);
    assertActive(doc);
    assertUnlocked(doc);
    const descendants = documentSubtreeIds(snapshot, documentId, userId).filter(
      (id) => id !== documentId && snapshot.docs.get(id)!.archivedAt === null,
    );
    const now = Date.now();
    return {
      guard: versionGuard(documentId, version),
      build: (ok) => [
        stmt`UPDATE project_document SET archived_at = ${now}, archived_by_ancestor_id = NULL,
          updated_by_user_id = ${userId}, updated_at = ${now}, version = version + 1
          WHERE id = ${documentId} AND project_id = ${projectId} AND version = ${version}
            AND archived_at IS NULL AND ${ok}`,
        ...(descendants.length > 0
          ? [
              stmt`UPDATE project_document SET archived_at = ${now}, archived_by_ancestor_id = ${documentId},
                updated_by_user_id = ${userId}, updated_at = ${now}, version = version + 1
                WHERE id IN (SELECT value FROM json_each(${JSON.stringify(descendants)}))
                  AND archived_at IS NULL AND ${ok}`,
            ]
          : []),
        ...captureRevisions(ok, [documentId, ...descendants]),
      ],
      result: () => 'ok' as const,
    };
  });
  if (outcome === null) return null;
  const row = await selectDocument(db, projectId, documentId, userId);
  return row ? mapDocumentForUser(db, row, userId) : null;
}

export async function restoreDocument(
  db: Db,
  projectId: number,
  documentId: number,
  userId: string,
  version: number,
  isProjectOwner: boolean,
): Promise<DocumentRow | null> {
  const outcome = await treeWrite<'ok' | null>(db, projectId, (snapshot) => {
    const doc = snapshot.docs.get(documentId);
    if (!doc || !canSee(doc, userId)) throw new EarlyResult(null);
    assertOwned(doc, userId, isProjectOwner);
    assertExpectedVersion(doc, version);
    if (doc.archivedAt === null) throw new HttpError(409, 'This document is not archived.');
    const archiveBatchId = doc.archivedByAncestorId ?? documentId;
    const descendants = documentSubtreeIds(snapshot, documentId, userId).filter((id) => {
      const d = snapshot.docs.get(id)!;
      return (
        id !== documentId && d.archivedAt !== null && d.archivedByAncestorId === archiveBatchId
      );
    });
    let detachFromParent = false;
    if (doc.parentId !== null) {
      const parent = snapshot.docs.get(doc.parentId);
      detachFromParent = !parent || !canSee(parent, userId) || parent.archivedAt !== null;
    }
    const now = Date.now();
    return {
      guard: versionGuard(documentId, version),
      build: (ok) => [
        stmt`UPDATE project_document SET archived_at = NULL, archived_by_ancestor_id = NULL,
          parent_id = ${detachFromParent ? null : doc.parentId},
          updated_by_user_id = ${userId}, updated_at = ${now}, version = version + 1
          WHERE id = ${documentId} AND project_id = ${projectId} AND version = ${version}
            AND archived_at IS NOT NULL AND ${ok}`,
        ...(descendants.length > 0
          ? [
              stmt`UPDATE project_document SET archived_at = NULL, archived_by_ancestor_id = NULL,
                updated_by_user_id = ${userId}, updated_at = ${now}, version = version + 1
                WHERE id IN (SELECT value FROM json_each(${JSON.stringify(descendants)}))
                  AND archived_by_ancestor_id = ${archiveBatchId} AND archived_at IS NOT NULL AND ${ok}`,
            ]
          : []),
        ...captureRevisions(ok, [documentId, ...descendants]),
      ],
      result: () => 'ok' as const,
    };
  });
  if (outcome === null) return null;
  const row = await selectDocument(db, projectId, documentId, userId);
  return row ? mapDocumentForUser(db, row, userId) : null;
}

async function currentSequence(db: Db): Promise<number> {
  const row = await d1Of(db)
    .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'project_document'")
    .first<{ seq: number }>();
  return row?.seq ?? 0;
}

// Copies a page and its assets. The bucket objects are copied first (and removed again if the
// copy fails); the page, its assets and its history then land in one fenced batch. The new
// page id is predicted from the AUTOINCREMENT sequence and checked by the fence, so the body
// can be rewritten to point at the copied assets before the insert.
export async function duplicateDocument(
  db: Db,
  bucket: R2Bucket,
  input: {
    projectId: number;
    documentId: number;
    userId: string;
    version: number;
    title?: string;
    parentId?: number | null;
  },
): Promise<DocumentRow | null> {
  const copiedObjectKeys: string[] = [];
  try {
    const source = await selectDocument(db, input.projectId, input.documentId, input.userId);
    if (!source) return null;
    assertExpectedVersion(source, input.version);
    assertValidDocumentContentJson(source.contentJson);
    const assets = await db
      .select()
      .from(documentAsset)
      .where(eq(documentAsset.documentId, source.id));
    for (const asset of assets) {
      await assertAttachmentFileAllowed(db, asset.sizeBytes, asset.contentType);
    }
    const totalBytes = assets.reduce((total, asset) => total + asset.sizeBytes, 0);
    const [projectRow] = await db
      .select({ teamId: project.teamId, key: project.key })
      .from(project)
      .where(eq(project.id, input.projectId));

    const copies: Array<{ publicId: string; key: string; asset: (typeof assets)[number] }> = [];
    const folderId = (await currentSequence(db)) + 1;
    for (const asset of assets) {
      const key = attachmentObjectKey(input.projectId, 'documents', folderId, asset.filename);
      await cloneAttachmentObject(bucket, asset.s3Key, key, asset.contentType);
      copiedObjectKeys.push(key);
      copies.push({ publicId: crypto.randomUUID(), key, asset });
    }
    const publicIds = new Map(
      copies.map((copy) => [copy.asset.publicId.toLowerCase(), copy.publicId]),
    );

    const newId = await writing(() =>
      treeWrite<number>(db, input.projectId, async (snapshot) => {
        const fresh = await selectDocument(db, input.projectId, input.documentId, input.userId);
        if (!fresh) throw new EarlyResult(-1);
        assertExpectedVersion(fresh, input.version);
        let parentId: number | null;
        if (input.parentId === undefined) {
          parentId = source.parentId;
          try {
            assertValidParent(snapshot, null, parentId, input.userId);
          } catch (error) {
            if (error instanceof HttpError && error.status === 400) parentId = null;
            else throw error;
          }
        } else {
          parentId = input.parentId;
          assertValidParent(snapshot, null, parentId, input.userId);
        }
        const position = nextPosition(snapshot, parentId);
        const sequence = await currentSequence(db);
        const id = sequence + 1;
        const quota = await attachmentQuotaCondition(db, input.projectId, totalBytes);
        const rewrite = <V>(value: V): V =>
          copies.length > 0 && projectRow
            ? replaceAssetReferences(value, source.id, projectRow, id, publicIds)
            : value;
        const now = Date.now();
        return {
          guard: stmt`${versionGuard(source.id, source.version)}
            AND COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'project_document'), 0) = ${sequence}
            AND (SELECT COUNT(*) FROM document_asset WHERE document_id = ${source.id}) = ${assets.length}
            AND COALESCE((SELECT SUM(size_bytes) FROM document_asset WHERE document_id = ${source.id}), 0) = ${totalBytes}
            AND ${quota}`,
          build: (ok) => [
            stmt`INSERT INTO project_document (id, project_id, parent_id, title, content, content_json, icon, metadata,
                full_width, is_private, position, owner_user_id, created_by_user_id, updated_by_user_id, created_at, updated_at)
              SELECT ${id}, ${input.projectId}, ${parentId}, ${input.title ?? `${source.title || 'Untitled'} (Copy)`},
                ${rewrite(source.content)}, ${json(rewrite(source.contentJson))}, ${source.icon}, ${json(source.metadata)},
                ${source.fullWidth}, ${source.isPrivate}, ${position}, ${input.userId}, ${input.userId}, ${input.userId}, ${now}, ${now}
              WHERE ${ok}`,
            ...copies.map(
              ({ publicId, key, asset }) =>
                stmt`INSERT INTO document_asset (public_id, document_id, uploaded_by_user_id, s3_key, filename, content_type, size_bytes)
                SELECT ${publicId}, ${id}, ${input.userId}, ${key}, ${asset.filename}, ${asset.contentType}, ${asset.sizeBytes}
                WHERE ${ok}`,
            ),
            ...captureRevisions(ok, [id]),
          ],
          result: () => id,
        };
      }),
    );
    if (newId < 0) {
      await Promise.all(copiedObjectKeys.map((key) => deleteAttachmentObject(bucket, key)));
      return null;
    }
    const row = await selectDocument(db, input.projectId, newId, input.userId);
    return row ? mapDocumentForUser(db, row, input.userId) : null;
  } catch (error) {
    await Promise.all(copiedObjectKeys.map((key) => deleteAttachmentObject(bucket, key)));
    throw error;
  }
}

export async function setDocumentPreference(
  db: Db,
  projectId: number,
  documentId: number,
  userId: string,
  isFavorite: boolean,
): Promise<{ isFavorite: boolean } | null> {
  if (!(await selectDocument(db, projectId, documentId, userId))) return null;
  const now = Date.now();
  await fencedBatch(db, {
    projectId,
    rev: null,
    build: (ok) => [
      stmt`INSERT INTO project_document_preference (document_id, user_id, is_favorite, updated_at)
        SELECT ${documentId}, ${userId}, ${isFavorite}, ${now} WHERE ${ok}
        ON CONFLICT (document_id, user_id) DO UPDATE SET is_favorite = excluded.is_favorite, updated_at = excluded.updated_at`,
    ],
  });
  return { isFavorite };
}

export async function listDocumentRevisions(
  db: Db,
  projectId: number,
  documentId: number,
  userId: string,
): Promise<DocumentRevisionSummaryRow[] | null> {
  const current = await selectDocument(db, projectId, documentId, userId);
  if (!current) return null;
  const rows = await db
    .select()
    .from(projectDocumentRevision)
    .where(
      and(
        eq(projectDocumentRevision.documentId, documentId),
        or(
          eq(projectDocumentRevision.isPrivate, false),
          eq(projectDocumentRevision.ownerUserId, userId),
        ),
      ),
    )
    .orderBy(desc(projectDocumentRevision.version));
  return rows.map(revisionSummaryOf);
}

export async function getDocumentRevision(
  db: Db,
  projectId: number,
  documentId: number,
  revisionId: number,
  userId: string,
): Promise<DocumentRevisionRow | null> {
  const current = await selectDocument(db, projectId, documentId, userId);
  if (!current) return null;
  const [row] = await db
    .select()
    .from(projectDocumentRevision)
    .where(
      and(
        eq(projectDocumentRevision.id, revisionId),
        eq(projectDocumentRevision.documentId, documentId),
        or(
          eq(projectDocumentRevision.isPrivate, false),
          eq(projectDocumentRevision.ownerUserId, userId),
        ),
      ),
    );
  if (!row) return null;
  const parentId = await visibleDocumentParentId(db, projectId, row.parentId, userId);
  return mapRevision({ ...row, parentId });
}

export async function restoreDocumentRevision(
  db: Db,
  projectId: number,
  documentId: number,
  revisionId: number,
  userId: string,
  version: number,
): Promise<DocumentRow | null> {
  const outcome = await writing(() =>
    treeWrite<'ok' | null>(db, projectId, async (snapshot) => {
      const current = await selectDocument(db, projectId, documentId, userId);
      if (!current) throw new EarlyResult(null);
      assertExpectedVersion(current, version);
      assertActive(current);
      assertUnlocked(current);
      const [revision] = await db
        .select()
        .from(projectDocumentRevision)
        .where(
          and(
            eq(projectDocumentRevision.id, revisionId),
            eq(projectDocumentRevision.documentId, documentId),
            or(
              eq(projectDocumentRevision.isPrivate, false),
              eq(projectDocumentRevision.ownerUserId, userId),
            ),
          ),
        );
      if (!revision) throw new HttpError(404, 'Document revision not found');
      if (
        revision.isPrivate &&
        (revision.ownerUserId !== userId || current.ownerUserId !== userId)
      ) {
        throw new HttpError(403, 'Only the current document owner can restore a private revision.');
      }
      assertValidDocumentContentJson(revision.contentJson);
      let parentId = revision.parentId;
      if (parentId !== null) {
        try {
          assertValidParent(snapshot, documentId, parentId, userId);
        } catch (error) {
          if (error instanceof HttpError && error.status === 400) parentId = null;
          else throw error;
        }
      }
      const sets: Assignments = [
        ['parent_id', parentId],
        ['title', revision.title],
        ['content', revision.content],
        ['content_json', json(revision.contentJson)],
        ['icon', revision.icon],
        ['metadata', json(revision.metadata)],
        ['full_width', revision.fullWidth],
        ['position', revision.position],
        // A historical secret may never be restored into a public current row.
        // Restoring a public snapshot into a private page keeps the safer current
        // access level instead of unexpectedly publishing it.
        ...(revision.isPrivate ? ([['is_private', true]] as Assignments) : []),
      ];
      const now = Date.now();
      return {
        guard: versionGuard(documentId, version),
        build: (ok) => [
          updateDocumentStatement(ok, projectId, documentId, version, userId, now, sets),
          ...dropCollaboration(ok, documentId),
          // A restore is always an explicit checkpoint: never merged into the last snapshot.
          ...captureRevisions(ok, [documentId]),
        ],
        result: () => 'ok' as const,
      };
    }),
  );
  if (outcome === null) return null;
  const row = await selectDocument(db, projectId, documentId, userId);
  return row ? mapDocumentForUser(db, row, userId) : null;
}

export async function exportDocument(
  db: Db,
  projectId: number,
  documentId: number,
  userId: string,
): Promise<{
  filename: string;
  mimeType: 'text/markdown';
  content: string;
  version: number;
  exportedAt: string;
} | null> {
  const document = await getDocument(db, projectId, documentId, userId);
  if (!document) return null;
  const printableTitle = [...document.title.trim()]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? '-' : character;
    })
    .join('');
  const stem = printableTitle.replace(/[<>:"/\\|?*]/g, '-').slice(0, 120) || 'untitled';
  return {
    filename: `${stem}.md`,
    mimeType: 'text/markdown',
    content: document.content,
    version: document.version,
    exportedAt: iso(new Date()),
  };
}

// Deletes an archived page and returns the bucket keys of its assets, which the caller
// removes from R2 once the rows are gone. The fence checks the asset set it read, so an
// asset uploaded in between is never orphaned in the bucket.
export async function deleteDocument(
  db: Db,
  projectId: number,
  documentId: number,
  userId: string,
  version: number,
  isProjectOwner: boolean,
): Promise<string[] | null> {
  return treeWrite<string[] | null>(db, projectId, async (snapshot) => {
    const doc = snapshot.docs.get(documentId);
    if (!doc || !canSee(doc, userId)) throw new EarlyResult(null);
    assertOwned(doc, userId, isProjectOwner);
    assertExpectedVersion(doc, version);
    assertUnlocked(doc);
    if (doc.archivedAt === null) {
      throw new HttpError(409, 'Archive this document before deleting it.');
    }
    const children = [...snapshot.docs.values()]
      .filter((d) => d.parentId === documentId)
      .map((d) => d.id);
    const assets = await db
      .select({ s3Key: documentAsset.s3Key, sizeBytes: documentAsset.sizeBytes })
      .from(documentAsset)
      .where(eq(documentAsset.documentId, documentId));
    const now = Date.now();
    return {
      guard: stmt`${versionGuard(documentId, version)}
        AND (SELECT COUNT(*) FROM document_asset WHERE document_id = ${documentId}) = ${assets.length}`,
      build: (ok) => [
        ...(children.length > 0
          ? [
              stmt`UPDATE project_document SET parent_id = NULL, updated_by_user_id = ${userId},
                updated_at = ${now}, version = version + 1
                WHERE id IN (SELECT value FROM json_each(${JSON.stringify(children)})) AND ${ok}`,
              ...captureRevisions(ok, children),
            ]
          : []),
        stmt`DELETE FROM project_document WHERE id = ${documentId} AND project_id = ${projectId}
          AND version = ${version} AND ${ok}`,
      ],
      result: () => assets.map((asset) => asset.s3Key),
    };
  });
}
