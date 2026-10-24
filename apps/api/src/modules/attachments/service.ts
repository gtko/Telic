import { issue, issueAttachment, issueFieldValue, type Db } from '@repo/db';
import { and, eq, sql } from 'drizzle-orm';
import { HttpError, iso, num } from '#shared/lib';
import { d1Of, stmt } from '#modules/documents/tree';
import { attachmentQuotaCondition, quotaExceeded, stripAttachmentEmbeds } from './storage';

// Data access for issue attachments. File bytes live in the S3-compatible object
// store (R2); these rows hold the metadata and the object key. publicId is
// the unguessable id used in the public download URL.

export interface AttachmentRow {
  id: number;
  publicId: string;
  issueId: number;
  s3Key: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
}

export function mapAttachment(row: typeof issueAttachment.$inferSelect): AttachmentRow {
  return {
    id: row.id,
    publicId: row.publicId,
    issueId: row.issueId,
    s3Key: row.s3Key,
    filename: row.filename,
    contentType: row.contentType,
    sizeBytes: num(row.sizeBytes),
    createdAt: iso(row.createdAt),
  };
}

// The quota is checked INSIDE the insert (INSERT ... SELECT ... WHERE <fits>): D1 runs one
// statement atomically, so two parallel uploads cannot both take the last free bytes.
export async function createAttachment(
  db: Db,
  input: {
    projectId: number;
    issueId: number;
    s3Key: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
  },
): Promise<AttachmentRow> {
  const quota = await attachmentQuotaCondition(db, input.projectId, input.sizeBytes);
  const publicId = crypto.randomUUID();
  const { sql: text, params } =
    stmt`INSERT INTO issue_attachment (public_id, issue_id, s3_key, filename, content_type, size_bytes)
    SELECT ${publicId}, ${input.issueId}, ${input.s3Key}, ${input.filename}, ${input.contentType}, ${input.sizeBytes}
    WHERE ${quota}`;
  const result = await d1Of(db)
    .prepare(text)
    .bind(...params)
    .run();
  if (result.meta.changes !== 1) throw await quotaExceeded(db, input.projectId, input.sizeBytes);
  const [row] = await db
    .select()
    .from(issueAttachment)
    .where(eq(issueAttachment.publicId, publicId));
  return mapAttachment(row!);
}

export async function listAttachments(db: Db, issueId: number): Promise<AttachmentRow[]> {
  const rows = await db
    .select()
    .from(issueAttachment)
    .where(eq(issueAttachment.issueId, issueId))
    .orderBy(issueAttachment.createdAt);
  return rows.map(mapAttachment);
}

// Bytes currently stored for a project, across every issue in it. Read before an
// upload to enforce the instance project quota.
export async function getProjectAttachmentBytes(db: Db, projectId: number): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`coalesce(sum(${issueAttachment.sizeBytes}), 0)` })
    .from(issueAttachment)
    .innerJoin(issue, eq(issue.id, issueAttachment.issueId))
    .where(eq(issue.projectId, projectId));
  return num(rows[0]?.total ?? 0);
}

export async function getAttachmentByPublicId(
  db: Db,
  publicId: string,
): Promise<AttachmentRow | null> {
  const rows = await db
    .select()
    .from(issueAttachment)
    .where(eq(issueAttachment.publicId, publicId));
  return rows[0] ? mapAttachment(rows[0]) : null;
}

// Points an attachment at new bytes, keeping its row and its publicId. An embed
// of it in a description keeps working and shows the new file, which is what
// makes editing an attachment in place possible. Returns null if no row matched.
export async function replaceAttachmentContent(
  db: Db,
  publicId: string,
  projectId: number,
  input: { s3Key: string; filename: string; contentType: string; sizeBytes: number },
): Promise<{ attachment: AttachmentRow; replacedS3Key: string } | null> {
  // Read the row, then update it only if it is still the row that was read (same size, which
  // the quota arithmetic relies on) and the new size still fits: one statement. A concurrent
  // replacement changes the size guard, so the loop starts over on the fresh row.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const [current] = await db
      .select({ attachment: issueAttachment })
      .from(issueAttachment)
      .innerJoin(issue, eq(issue.id, issueAttachment.issueId))
      .where(and(eq(issueAttachment.publicId, publicId), eq(issue.projectId, projectId)));
    if (!current) return null;
    const replacedBytes = num(current.attachment.sizeBytes);
    const quota = await attachmentQuotaCondition(db, projectId, input.sizeBytes, replacedBytes);
    const { sql: text, params } = stmt`UPDATE issue_attachment
      SET s3_key = ${input.s3Key}, filename = ${input.filename},
          content_type = ${input.contentType}, size_bytes = ${input.sizeBytes}
      WHERE id = ${current.attachment.id} AND s3_key = ${current.attachment.s3Key}
        AND size_bytes = ${replacedBytes} AND ${quota}`;
    const result = await d1Of(db)
      .prepare(text)
      .bind(...params)
      .run();
    if (result.meta.changes === 1) {
      const [row] = await db
        .select()
        .from(issueAttachment)
        .where(eq(issueAttachment.id, current.attachment.id));
      if (!row) return null;
      return { attachment: mapAttachment(row), replacedS3Key: current.attachment.s3Key };
    }
    // Refused: the row moved under us (retry) or the quota is full (report it).
    const [again] = await db
      .select({ s3Key: issueAttachment.s3Key, sizeBytes: issueAttachment.sizeBytes })
      .from(issueAttachment)
      .where(eq(issueAttachment.id, current.attachment.id));
    if (!again) return null;
    if (again.s3Key === current.attachment.s3Key && num(again.sizeBytes) === replacedBytes) {
      throw await quotaExceeded(db, projectId, input.sizeBytes, replacedBytes);
    }
  }
  throw new HttpError(409, 'The attachment is being changed elsewhere. Try again.');
}

// Deletes the row and returns it (with its s3Key) so the caller can remove the
// object from the store. Returns null if no row matched.
export async function deleteAttachmentByPublicId(
  db: Db,
  publicId: string,
): Promise<AttachmentRow | null> {
  const rows = await db
    .delete(issueAttachment)
    .where(eq(issueAttachment.publicId, publicId))
    .returning();
  return rows[0] ? mapAttachment(rows[0]) : null;
}

// Remove embeds of one attachment from the issue description and its markdown
// custom field values. Called on delete so a removed attachment leaves no broken
// image behind.
export async function removeAttachmentEmbeds(
  db: Db,
  issueId: number,
  publicId: string,
): Promise<void> {
  let changed = false;

  const [row] = await db
    .select({ description: issue.description })
    .from(issue)
    .where(eq(issue.id, issueId));
  if (row) {
    const next = stripAttachmentEmbeds(row.description, publicId);
    if (next !== row.description) {
      await db.update(issue).set({ description: next }).where(eq(issue.id, issueId));
      changed = true;
    }
  }

  const values = await db
    .select({ id: issueFieldValue.id, valueText: issueFieldValue.valueText })
    .from(issueFieldValue)
    .where(eq(issueFieldValue.issueId, issueId));
  for (const v of values) {
    if (v.valueText == null) continue;
    const next = stripAttachmentEmbeds(v.valueText, publicId);
    if (next !== v.valueText) {
      await db.update(issueFieldValue).set({ valueText: next }).where(eq(issueFieldValue.id, v.id));
      changed = true;
    }
  }

  // Stripping an embed is an edit of the issue, and sorting by "recently updated"
  // has to place it accordingly.
  if (changed) {
    await db.update(issue).set({ updatedAt: new Date() }).where(eq(issue.id, issueId));
  }
}
