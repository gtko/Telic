import { createHash } from 'node:crypto';
import {
  getStorageSettings,
  mimeAllowed,
  MB,
  projectStoredBytes,
  projectTeamId,
  teamWorkspaceId,
  workspaceStoredBytes,
  type Db,
} from '@repo/db';
import { HttpError } from '#shared/lib';
import { getLimits } from '#shared/limits';

// Attachment bytes live in R2 (binding `BUCKET`, handed to the routes through the request
// context as `bucket`). Only the metadata and the object key are rows in the owning table.

// Keeps a filename usable as a path segment and free of control characters, falling back
// to a plain default when nothing usable is left.
export function safeAttachmentFilename(input: string, fallback = 'file'): string {
  const basename = input.split(/[\\/]/).pop() ?? '';
  const printable = [...basename]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? '_' : character;
    })
    .join('')
    .trim();
  const filename = printable.slice(-255);
  return filename && filename !== '.' && filename !== '..' ? filename : fallback;
}

// The object key an attachment is stored under: scoped by project and namespace,
// optionally by an owner within it (an issue id, say), and made unique with a uuid so
// re-uploading the same filename never collides with or overwrites an earlier version.
export function attachmentObjectKey(
  projectId: number,
  namespace: 'attachments' | 'chat' | 'documents' | 'initiatives',
  ownerId: number | null,
  filename: string,
): string {
  const safeName = safeAttachmentFilename(filename)
    .replace(/[^\w.-]+/g, '_')
    .slice(-100);
  const ownerPath = ownerId === null ? '' : `${ownerId}/`;
  return `projects/${projectId}/${namespace}/${ownerPath}${crypto.randomUUID()}-${safeName}`;
}

// A bound SQL condition, shaped like the `Stmt` of the document tree so it can be inlined
// in a statement.
export interface SqlCondition {
  sql: string;
  params: Array<string | number | null>;
}

// Stored bytes per project and per workspace, as SQL. The quota is checked INSIDE the
// statement that inserts the attachment (`INSERT ... SELECT ... WHERE <condition>`), so two
// parallel uploads cannot both pass a check that only one of them fits: D1 runs a
// statement atomically, and this replaces the advisory lock of the Postgres version.
const PROJECT_USED_SQL = `(
  COALESCE((SELECT SUM(ia.size_bytes) FROM issue_attachment ia JOIN issue i ON i.id = ia.issue_id WHERE i.project_id = ?), 0)
  + COALESCE((SELECT SUM(ca.size_bytes) FROM chat_attachment ca WHERE ca.project_id = ?), 0)
  + COALESCE((SELECT SUM(da.size_bytes) FROM document_asset da JOIN project_document pd ON pd.id = da.document_id WHERE pd.project_id = ?), 0)
  + COALESCE((SELECT SUM(na.size_bytes) FROM initiative_attachment na JOIN initiative it ON it.id = na.initiative_id WHERE it.project_id = ?), 0)
)`;

const WORKSPACE_USED_SQL = `(
  COALESCE((SELECT SUM(ia.size_bytes) FROM issue_attachment ia JOIN issue i ON i.id = ia.issue_id JOIN project p ON p.id = i.project_id JOIN team t ON t.id = p.team_id WHERE t.workspace_id = ?), 0)
  + COALESCE((SELECT SUM(ca.size_bytes) FROM chat_attachment ca JOIN project p ON p.id = ca.project_id JOIN team t ON t.id = p.team_id WHERE t.workspace_id = ?), 0)
  + COALESCE((SELECT SUM(da.size_bytes) FROM document_asset da JOIN project_document pd ON pd.id = da.document_id JOIN project p ON p.id = pd.project_id JOIN team t ON t.id = p.team_id WHERE t.workspace_id = ?), 0)
  + COALESCE((SELECT SUM(na.size_bytes) FROM initiative_attachment na JOIN initiative it ON it.id = na.initiative_id JOIN project p ON p.id = it.project_id JOIN team t ON t.id = p.team_id WHERE t.workspace_id = ?), 0)
)`;

// The condition under which `addedBytes` still fit the project and workspace quotas once
// `replacedBytes` are freed. Throws the 413 right away when the quota is already blown (the
// message the client shows); the returned condition is what actually enforces it at write
// time. Unlimited quotas (0) add nothing.
export async function attachmentQuotaCondition(
  db: Db,
  projectId: number,
  addedBytes: number,
  replacedBytes = 0,
): Promise<SqlCondition> {
  await assertAttachmentStorageCapacity(db, projectId, addedBytes, replacedBytes);
  const limits = await getStorageSettings(db);
  const teamId = await projectTeamId(db, projectId);
  if (teamId == null) throw new HttpError(404, 'Project not found');
  const workspaceId = await teamWorkspaceId(teamId, db);
  const { maxStorageBytes } = await getLimits(workspaceId);

  const parts: string[] = [];
  const params: Array<string | number | null> = [];
  if (limits.projectQuotaMb > 0) {
    parts.push(`(${PROJECT_USED_SQL} - ? + ? <= ?)`);
    params.push(projectId, projectId, projectId, projectId);
    params.push(replacedBytes, addedBytes, limits.projectQuotaMb * MB);
  }
  if (maxStorageBytes > 0) {
    parts.push(`(${WORKSPACE_USED_SQL} - ? + ? <= ?)`);
    params.push(workspaceId, workspaceId, workspaceId, workspaceId);
    params.push(replacedBytes, addedBytes, maxStorageBytes);
  }
  return { sql: parts.length > 0 ? parts.join(' AND ') : '1', params };
}

// What a refused quota insert tells the client: the same 413 as the early check.
export async function quotaExceeded(
  db: Db,
  projectId: number,
  addedBytes: number,
  replacedBytes = 0,
): Promise<HttpError> {
  try {
    await assertAttachmentStorageCapacity(db, projectId, addedBytes, replacedBytes);
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  // Space was freed between the refused insert and this read: still refused, as it was.
  return new HttpError(413, 'The storage quota was reached while uploading. Try again.');
}

export async function assertAttachmentStorageCapacity(
  db: Db,
  projectId: number,
  addedBytes: number,
  replacedBytes = 0,
): Promise<void> {
  const limits = await getStorageSettings(db);
  if (limits.projectQuotaMb > 0) {
    const used = (await projectStoredBytes(db, projectId)) - replacedBytes;
    if (used + addedBytes > limits.projectQuotaMb * MB) {
      throw new HttpError(
        413,
        `The project has used its ${limits.projectQuotaMb} MB storage quota. Delete attachments to free space.`,
      );
    }
  }
  // The instance quota above is per project; a workspace may hold a ceiling of its own
  // across all of them.
  const teamId = await projectTeamId(db, projectId);
  if (teamId == null) throw new HttpError(404, 'Project not found');
  const workspaceId = await teamWorkspaceId(teamId, db);
  const { maxStorageBytes } = await getLimits(workspaceId);
  if (maxStorageBytes > 0) {
    const used = (await workspaceStoredBytes(db, workspaceId)) - replacedBytes;
    if (used + addedBytes > maxStorageBytes) {
      throw new HttpError(
        413,
        `The workspace has used its ${Math.round(maxStorageBytes / MB)} MB of storage. Delete attachments to free space.`,
      );
    }
  }
}

export async function assertAttachmentUploadAllowed(
  db: Db,
  projectId: number,
  size: number,
  contentType: string,
  replacedBytes = 0,
): Promise<void> {
  await assertAttachmentFileAllowed(db, size, contentType);
  await assertAttachmentStorageCapacity(db, projectId, size, replacedBytes);
}

export async function assertAttachmentFileAllowed(
  db: Db,
  size: number,
  contentType: string,
): Promise<void> {
  const limits = await getStorageSettings(db);
  if (size > limits.maxAttachmentMb * MB) {
    throw new HttpError(413, `File exceeds the ${limits.maxAttachmentMb} MB limit`);
  }
  if (!mimeAllowed(contentType, limits.attachmentMimeTypes)) {
    throw new HttpError(400, `Files of type "${contentType}" are not accepted on this instance`);
  }
}

// What R2 accepts as an upload body. A File or Blob is streamed, never copied into a
// Buffer: the Workers runtime hands R2 the stream with its known size.
export type ObjectBody = Blob | ArrayBuffer | ArrayBufferView | string | ReadableStream;

// R2 refuses a stream of unknown length. A Blob/File knows its size, so its stream goes
// through a FixedLengthStream (a Workers global) and is never buffered; outside the Workers
// runtime (tests) the bytes are passed whole.
async function uploadPayload(
  body: ObjectBody,
): Promise<ReadableStream | ArrayBuffer | ArrayBufferView | string> {
  if (!(body instanceof Blob)) return body;
  if (typeof FixedLengthStream === 'undefined') return body.arrayBuffer();
  const fixed = new FixedLengthStream(body.size);
  body
    .stream()
    .pipeTo(fixed.writable)
    .catch(() => {
      // The error surfaces on the readable half, i.e. in the put.
    });
  return fixed.readable;
}

export async function storeAttachmentObject(
  bucket: R2Bucket,
  key: string,
  body: ObjectBody,
  contentType: string,
): Promise<void> {
  try {
    await bucket.put(key, await uploadPayload(body), { httpMetadata: { contentType } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[planner] object store PUT failed (key=${key}):`, error);
    throw new HttpError(502, `Object store error: ${message}`);
  }
}

// Copies an object inside the bucket without reading it through the Worker when the
// runtime allows it: the body is streamed from the source `get` into the target `put`.
export async function cloneAttachmentObject(
  bucket: R2Bucket,
  sourceKey: string,
  targetKey: string,
  contentType: string,
): Promise<void> {
  const source = await bucket.get(sourceKey).catch((error) => {
    throw new HttpError(
      502,
      `Could not read the source asset: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  if (!source) throw new HttpError(502, 'Could not read the source asset: object not found');
  await storeAttachmentObject(
    bucket,
    targetKey,
    source.body,
    contentType || source.httpMetadata?.contentType || 'application/octet-stream',
  );
}

export async function deleteAttachmentObject(bucket: R2Bucket, key: string): Promise<void> {
  await bucket.delete(key).catch((error) => {
    console.error(
      `[planner] failed to delete object ${key}:`,
      error instanceof Error ? error.message : error,
    );
  });
}

const VIEWABLE_IMAGE = /^image\/(png|jpeg|gif|webp)$/i;
const MAX_IMAGE_MB = 5;
const MAX_IMAGES = 8;
const MAX_VIEW_MB = 10;

export const VIEWABLE_IMAGES = `PNG, JPEG, GIF and WebP images of up to ${MAX_IMAGE_MB} MB, at most ${MAX_IMAGES} images and ${MAX_VIEW_MB} MB per call`;

function toBase64(bytes: ArrayBuffer): string {
  let binary = '';
  const view = new Uint8Array(bytes);
  const chunk = 0x8000;
  for (let offset = 0; offset < view.length; offset += chunk) {
    binary += String.fromCharCode(...view.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

// The images go into the assistant's context whole, so a call is bounded; an attachment
// left out comes back as its DTO, whose url fetches it.
export async function viewAttachments<
  Row extends {
    publicId: string;
    s3Key: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
  },
  Dto,
>(bucket: R2Bucket, rows: Row[], dto: (row: Row) => Dto) {
  const images: { id: string; filename: string; contentType: string; data: string }[] = [];
  const others: Dto[] = [];
  let bytes = 0;
  for (const row of rows) {
    const fits =
      VIEWABLE_IMAGE.test(row.contentType) &&
      row.sizeBytes <= MAX_IMAGE_MB * MB &&
      images.length < MAX_IMAGES &&
      bytes + row.sizeBytes <= MAX_VIEW_MB * MB;
    if (!fits) {
      others.push(dto(row));
      continue;
    }
    const object = await bucket.get(row.s3Key).catch((error) => {
      throw new HttpError(
        502,
        `Could not read ${row.filename}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    if (!object) throw new HttpError(502, `Could not read ${row.filename}: object not found`);
    const data = toBase64(await object.arrayBuffer());
    images.push({ id: row.publicId, filename: row.filename, contentType: row.contentType, data });
    bytes += row.sizeBytes;
  }
  return { images, others };
}

export function attachmentEtag(s3Key: string): string {
  return `"${createHash('sha256').update(s3Key).digest('base64url').slice(0, 22)}"`;
}

export function attachmentResponseHeaders(input: {
  contentType: string;
  filename: string;
  contentLength?: number;
  etag: string;
  download: boolean;
}): Record<string, string> {
  const inlineSafe = /^(image\/(png|jpe?g|gif|webp|avif|bmp)|video\/|audio\/)/i.test(
    input.contentType,
  );
  const inline = inlineSafe && !input.download;
  const headers: Record<string, string> = {
    'Content-Type': input.contentType,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(input.filename)}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-cache',
    ETag: input.etag,
  };
  if (input.contentLength !== undefined) headers['Content-Length'] = String(input.contentLength);
  if (!inline) headers['Content-Security-Policy'] = "default-src 'none'; sandbox";
  return headers;
}

// An embed of a deleted attachment left in markdown would 404 once the object is
// gone. Strip any construct whose URL carries this attachment's publicId: a
// markdown image/link, or an inline <img>/<video>. The publicId is a uuid, so a
// URL substring match is specific to this one attachment.
export function stripAttachmentEmbeds(text: string, publicId: string): string {
  const id = publicId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text
    .replace(new RegExp(`!?\\[[^\\]]*\\]\\([^)]*${id}[^)]*\\)`, 'g'), '')
    .replace(new RegExp(`<img\\b[^>]*${id}[^>]*>`, 'g'), '')
    .replace(new RegExp(`<video\\b[^>]*${id}[^>]*>(?:\\s*</video>)?`, 'g'), '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// The body of a public raw-download route. The bytes behind a publicId can be
// replaced, so the response is revalidated instead of cached for good: every write
// stores the file under a key with a fresh uuid, so a digest of the key changes
// with the bytes. It is the digest, not the key, because these routes are public
// and the key carries the project id, the owner id and the stored filename.
//
// The bytes and their content type are attacker-controlled, and the routes are
// public and same-origin as the planner UI, so serving an HTML or SVG file inline
// would be stored XSS. attachmentResponseHeaders is what keeps them inert.
export async function attachmentObjectResponse(input: {
  bucket: R2Bucket;
  s3Key: string;
  contentType: string;
  filename: string;
  request: Request;
  download: boolean;
}): Promise<Response> {
  const etag = attachmentEtag(input.s3Key);
  if (input.request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }

  let obj;
  try {
    obj = await input.bucket.get(input.s3Key);
  } catch (err) {
    throw new HttpError(404, err instanceof Error ? err.message : 'Object not found');
  }
  if (!obj) throw new HttpError(404, 'Object not found');

  // The body is the R2 stream, passed through untouched: nothing is buffered here.
  return new Response(obj.body, {
    headers: attachmentResponseHeaders({
      contentType: input.contentType || obj.httpMetadata?.contentType || 'application/octet-stream',
      filename: input.filename,
      contentLength: obj.size,
      etag,
      download: input.download,
    }),
  });
}
