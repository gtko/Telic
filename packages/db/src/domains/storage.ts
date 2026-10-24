import { eq, sql, type SQL } from 'drizzle-orm';
import type { Db, DbExecutor } from '../client';
import { getSetting } from '../settings';
import { project } from '../schema';

// Instance-wide upload limits (app_setting key 'storage'). Read by the api (every
// upload path, and the settings/god UI) and by the worker (an imported Plane
// attachment is checked against the same limits an interactive upload would be).
// The api owns the write (modules/settings/service.ts's setStorageSettings).
//
// The row is seeded by drizzle-d1/0002_seed.sql, so the limits are set in the database and
// edited in god mode — there is no env var for them. defaultStorageSettings() is
// the fallback for a missing row and the source of the seeded values; keep the two
// in sync.

export const STORAGE_SETTING_KEY = 'storage';

export const MB = 1024 * 1024;

export interface StorageSettings {
  // Upper bound on a single attachment. The multipart body is buffered in memory,
  // so this also bounds per-upload memory.
  maxAttachmentMb: number;
  // Upper bound on a single avatar image.
  maxAvatarMb: number;
  // Accepted attachment content types. An entry is a full type ('application/pdf')
  // or a wildcard ('image/*'). An empty list accepts any type.
  attachmentMimeTypes: string[];
  // Total stored attachment bytes allowed per project, in MB. 0 means unlimited.
  projectQuotaMb: number;
}

// Images, video, PDF, office documents and plain text formats. Executables,
// archives and anything else are refused until an admin adds them.
export const DEFAULT_ATTACHMENT_MIME_TYPES = [
  'image/*',
  'video/*',
  'application/pdf',
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.presentation',
];

export function defaultStorageSettings(): StorageSettings {
  return {
    maxAttachmentMb: 25,
    maxAvatarMb: 5,
    attachmentMimeTypes: DEFAULT_ATTACHMENT_MIME_TYPES,
    projectQuotaMb: 50 * 1024,
  };
}

export async function getStorageSettings(db: Db): Promise<StorageSettings> {
  const stored = await getSetting<Partial<StorageSettings>>(db, STORAGE_SETTING_KEY);
  // Merge over the default so a value written before a field was added stays valid.
  return { ...defaultStorageSettings(), ...(stored ?? {}) };
}

// Whether a content type passes the allowlist. An empty list accepts anything.
// Entries are matched case-insensitively; setStorageSettings normalizes what it stores.
export function mimeAllowed(contentType: string, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  const ct = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return allowed.some((pattern) =>
    pattern.endsWith('/*') ? ct.startsWith(pattern.slice(0, -1)) : ct === pattern,
  );
}

// One row (`size`) per attachment of every kind that counts against a quota — issue,
// document and initiative attachments — of one project or of every project of one workspace.
// A single UNION ALL, so the total costs one D1 round trip instead of three.
function attachmentSizes(scope: 'project' | 'workspace', id: number): SQL {
  const inScope = (projectColumn: string): SQL =>
    scope === 'project'
      ? sql`${sql.raw(projectColumn)} = ${id}`
      : sql`${sql.raw(projectColumn)} IN (
          SELECT p.id FROM project p JOIN team t ON t.id = p.team_id WHERE t.workspace_id = ${id})`;
  return sql`
    SELECT a.size_bytes AS size FROM issue_attachment a JOIN issue i ON i.id = a.issue_id
      WHERE ${inScope('i.project_id')}
    UNION ALL
    SELECT a.size_bytes FROM document_asset a JOIN project_document d ON d.id = a.document_id
      WHERE ${inScope('d.project_id')}
    UNION ALL
    SELECT a.size_bytes FROM initiative_attachment a JOIN initiative n ON n.id = a.initiative_id
      WHERE ${inScope('n.project_id')}`;
}

async function storedBytes(
  executor: DbExecutor,
  scope: 'project' | 'workspace',
  id: number,
): Promise<number> {
  const rows = await executor.all<{ total: number | null }>(
    sql`SELECT COALESCE(SUM(size), 0) AS total FROM (${attachmentSizes(scope, id)})`,
  );
  return Number(rows[0]?.total ?? 0);
}

// Total attachment bytes a project has stored, across every kind that counts
// against its quota (issue, document, initiative attachments) — what a new
// upload's size is checked against before it is allowed, and what a worker
// importing issue attachments checks against too. One statement. On its own the check is
// advisory: D1 has no row or advisory lock to serialize it against a concurrent insert, so
// an upload path that must enforce the quota calls reserveStorage, which checks and inserts
// in one statement.
export async function projectStoredBytes(executor: DbExecutor, projectId: number): Promise<number> {
  return storedBytes(executor, 'project', projectId);
}

// The project's team, read through the same executor a quota check runs on — a
// copy checks the quota of a project its own transaction has not committed yet.
export async function projectTeamId(
  executor: DbExecutor,
  projectId: number,
): Promise<number | null> {
  const [owner] = await executor
    .select({ teamId: project.teamId })
    .from(project)
    .where(eq(project.id, projectId));
  return owner?.teamId ?? null;
}

// The same total as projectStoredBytes, summed across every project of one workspace —
// what a workspace-wide storage ceiling is checked against.
export async function workspaceStoredBytes(
  executor: DbExecutor,
  workspaceId: number,
): Promise<number> {
  return storedBytes(executor, 'workspace', workspaceId);
}

export type AttachmentKind = 'issue' | 'document' | 'initiative';

export interface ReserveStorageInput {
  kind: AttachmentKind;
  // The project whose quota the upload counts against.
  projectId: number;
  // The row the attachment hangs on: the issue, document or initiative id.
  ownerId: number;
  s3Key: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  // Who uploaded it. Stored for 'document'; the other two tables have no column.
  uploadedByUserId?: string | null;
  // Allowed total for the project, in bytes. 0 or less means unlimited.
  quotaBytes: number;
  publicId?: string;
}

const RESERVE_TARGETS: Record<
  AttachmentKind,
  { table: string; ownerColumn: string; hasUploader: boolean }
> = {
  issue: { table: 'issue_attachment', ownerColumn: 'issue_id', hasUploader: false },
  document: { table: 'document_asset', ownerColumn: 'document_id', hasUploader: true },
  initiative: { table: 'initiative_attachment', ownerColumn: 'initiative_id', hasUploader: false },
};

// The owner row must exist and belong to the project the quota is charged to.
function ownerInProject(kind: AttachmentKind, ownerId: number, projectId: number): SQL {
  switch (kind) {
    case 'issue':
      return sql`SELECT 1 FROM issue WHERE id = ${ownerId} AND project_id = ${projectId}`;
    case 'document':
      return sql`SELECT 1 FROM project_document WHERE id = ${ownerId} AND project_id = ${projectId}`;
    case 'initiative':
      return sql`SELECT 1 FROM initiative WHERE id = ${ownerId} AND project_id = ${projectId}`;
  }
}

// Inserts the attachment row only if the project stays within its quota, check and insert in
// ONE statement (INSERT ... SELECT ... WHERE used + size <= quota). D1 runs statements one at a
// time, so N concurrent uploads cannot all pass a stale check the way a separate
// projectStoredBytes + insert could: the ones past the quota insert nothing. It also refuses an
// owner (issue, document, initiative) that is not in `projectId`, so a caller cannot charge
// another project's quota. Returns the new row, or null when the quota or the owner refuses it.
// The row is written before the object, so a failed object-store upload must delete it again.
export async function reserveStorage(
  executor: DbExecutor,
  input: ReserveStorageInput,
): Promise<{ id: number; publicId: string } | null> {
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) {
    throw new Error('reserveStorage: sizeBytes must be a non-negative integer');
  }
  const target = RESERVE_TARGETS[input.kind];
  const publicId = input.publicId ?? crypto.randomUUID();
  const ownerId = input.ownerId;
  const uploaderColumn = target.hasUploader ? sql.raw(', uploaded_by_user_id') : sql.raw('');
  const uploaderValue = target.hasUploader ? sql`, ${input.uploadedByUserId ?? null}` : sql.raw('');
  const withinQuota =
    input.quotaBytes > 0
      ? sql` AND (SELECT COALESCE(SUM(size), 0) FROM (${attachmentSizes('project', input.projectId)})) + ${input.sizeBytes} <= ${input.quotaBytes}`
      : sql.raw('');
  const rows = await executor.all<{ id: number; public_id: string }>(sql`
    INSERT INTO ${sql.raw(target.table)}
      (public_id, ${sql.raw(target.ownerColumn)}, s3_key, filename, content_type, size_bytes${uploaderColumn})
    SELECT ${publicId}, ${ownerId}, ${input.s3Key}, ${input.filename}, ${input.contentType}, ${input.sizeBytes}${uploaderValue}
    WHERE EXISTS (${ownerInProject(input.kind, ownerId, input.projectId)})${withinQuota}
    RETURNING id, public_id`);
  const row = rows[0];
  return row ? { id: row.id, publicId: row.public_id } : null;
}
