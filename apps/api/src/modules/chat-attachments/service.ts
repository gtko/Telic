import { chatAttachment, type Db } from '@repo/db';
import { eq, sql } from 'drizzle-orm';
import { HttpError, iso, num } from '#shared/lib';
import { isTableFilename, parseImportFile } from './parse';
import {
  attachmentQuotaCondition,
  quotaExceeded,
  type SqlCondition,
} from '#modules/attachments/storage';

// Data access for chat attachments. File bytes live in the S3-compatible object
// store (@repo/storage); these rows hold the metadata and the object key. publicId is
// the unguessable id used in the public download URL and in the marker a chat
// message carries for an attached file.

export interface ChatAttachmentRow {
  id: number;
  publicId: string;
  projectId: number;
  uploadedByUserId: string | null;
  s3Key: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
}

function mapRow(row: typeof chatAttachment.$inferSelect): ChatAttachmentRow {
  return {
    id: row.id,
    publicId: row.publicId,
    projectId: row.projectId,
    uploadedByUserId: row.uploadedByUserId,
    s3Key: row.s3Key,
    filename: row.filename,
    contentType: row.contentType,
    sizeBytes: num(row.sizeBytes),
    createdAt: iso(row.createdAt),
  };
}

// A bound condition (`?` placeholders and their values) as a drizzle fragment.
function conditionSql(condition: SqlCondition) {
  const parts = condition.sql.split('?');
  const out = [sql.raw(parts[0]!)];
  for (const [index, value] of condition.params.entries()) {
    out.push(sql`${value}`, sql.raw(parts[index + 1]!));
  }
  return sql.join(out, sql.raw(''));
}

// The quota is checked INSIDE the insert (INSERT ... SELECT ... WHERE <fits>): D1 runs one
// statement atomically, so two parallel uploads cannot both pass a check that only one of
// them fits. This replaces the advisory lock of the Postgres version.
export async function createChatAttachment(
  db: Db,
  input: {
    projectId: number;
    uploadedByUserId: string | null;
    s3Key: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
  },
): Promise<ChatAttachmentRow> {
  const quota = await attachmentQuotaCondition(db, input.projectId, input.sizeBytes);
  const publicId = crypto.randomUUID();
  const inserted = await db.all<{ public_id: string }>(sql`
    INSERT INTO chat_attachment (public_id, project_id, uploaded_by_user_id, s3_key, filename, content_type, size_bytes)
    SELECT ${publicId}, ${input.projectId}, ${input.uploadedByUserId}, ${input.s3Key}, ${input.filename}, ${input.contentType}, ${input.sizeBytes}
    WHERE ${conditionSql(quota)}
    RETURNING public_id`);
  if (inserted.length === 0) throw await quotaExceeded(db, input.projectId, input.sizeBytes);
  const [row] = await db.select().from(chatAttachment).where(eq(chatAttachment.publicId, publicId));
  return mapRow(row!);
}

export async function getChatAttachmentByPublicId(
  db: Db,
  publicId: string,
): Promise<ChatAttachmentRow | null> {
  const rows = await db.select().from(chatAttachment).where(eq(chatAttachment.publicId, publicId));
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function getChatAttachmentProjectId(db: Db, publicId: string): Promise<number | null> {
  const rows = await db
    .select({ projectId: chatAttachment.projectId })
    .from(chatAttachment)
    .where(eq(chatAttachment.publicId, publicId));
  return rows[0]?.projectId ?? null;
}

// Bytes currently stored for a project as chat attachments. Read before an upload
// to enforce the instance project quota.
export async function getProjectChatAttachmentBytes(db: Db, projectId: number): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`coalesce(sum(${chatAttachment.sizeBytes}), 0)` })
    .from(chatAttachment)
    .where(eq(chatAttachment.projectId, projectId));
  return num(rows[0]?.total ?? 0);
}

export async function readAttachmentBytes(bucket: R2Bucket, s3Key: string): Promise<Buffer> {
  const obj = await bucket.get(s3Key).catch(() => null);
  if (!obj) throw new HttpError(404, 'The uploaded file is gone from the object store');
  return Buffer.from(await obj.arrayBuffer());
}

export interface ChatAttachmentContent {
  table?: { headers: string[]; sampleRows: string[][]; totalRows: number };
  text?: string;
}

function isTextLike(row: ChatAttachmentRow): boolean {
  if (/^(text\/|application\/(json|xml))/.test(row.contentType)) return true;
  return /\.(txt|md|log|json|xml|ya?ml)$/i.test(row.filename);
}

// The content of a stored file in the shape the read route answers with: a table
// for a spreadsheet or document, the full text for a text file, nothing for a
// binary one (its download url is in the metadata either way). A text file is
// returned whole: what it costs in context is the user's call, and the chat
// shows the conversation's context size.
export async function readChatAttachmentContent(
  bucket: R2Bucket,
  row: ChatAttachmentRow,
): Promise<ChatAttachmentContent> {
  const bytes = await readAttachmentBytes(bucket, row.s3Key);
  if (isTableFilename(row.filename)) {
    const parsed = await parseImportFile(bytes, row.filename);
    return {
      table: {
        headers: parsed.headers,
        sampleRows: parsed.rows.slice(0, 10),
        totalRows: parsed.totalRows,
      },
    };
  }
  if (isTextLike(row)) return { text: bytes.toString('utf8') };
  return {};
}
