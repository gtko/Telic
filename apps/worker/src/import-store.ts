import {
  issue,
  issueLabel,
  issueActivity,
  issueLink,
  project,
  projectColumn,
  user,
  projectMember,
  importJob,
  importRecord,
  getStorageSettings,
  mimeAllowed,
  MB,
  projectStoredBytes,
  type Db,
  type ImportSource,
} from '@repo/db';
import { and, eq, gt, inArray, isNull, isNotNull, sql, type Column } from 'drizzle-orm';
import { decryptSecret, type EncryptedSecret } from '@repo/crypto';
import {
  putObject,
  deleteObject,
  safeAttachmentFilename,
  attachmentObjectKey,
} from '@repo/storage';
import type { CanonicalState, CanonicalLabel, CanonicalCycle } from './canonical';
import type { ImportCredential } from './import-sources';
import { AttachmentRejectedError } from './attachment-download';
import { allRows, batchResults, chunks, parseJson, type SqlValue, type Statement } from './d1';

export { AttachmentRejectedError };

// All @repo/db access for a source import: claiming due import_job rows (the same lease
// pattern as store.ts uses for webhook_delivery), reading/writing a job's progress, the
// import_record upsert primitive, and creating the local rows an import produces. The
// credential decrypt lives here rather than packages/db/src/domains/: that directory is for
// config more than one process reads, and only the worker ever decrypts an import job's stored
// credential — the api only sees the raw token once, at creation, before it is encrypted.
//
// D1 has no interactive transaction and no row lock. A write that must land with another (a
// local row and its import_record mapping) is one db batch of raw statements; the reuse
// lookups that precede it are plain reads, which stays safe because a job is leased to one
// consumer at a time (claimDueImportJobs). Every bulk statement is chunked to stay under
// D1's 100 bound parameters.

// Longer than the 120 s of the polling worker: a queue consumer may spend a while on a
// rate-limited source, and a job re-claimed while its consumer still runs would be done twice.
const LEASE_SECONDS = 300;

// The SQL form of "now" for a column default, for the timestamps an insert may override.
const NOW_MS_SQL = `CAST(unixepoch('subsecond') * 1000 AS INTEGER)`;

export interface ClaimedImportJob {
  id: number;
  projectId: number;
  source: ImportSource;
  phase: string;
  status: string;
  config: Record<string, unknown>;
  cursor: Record<string, unknown>;
  attempts: number;
  credentialCiphertext: string | null;
  credentialIv: string | null;
  credentialAuthTag: string | null;
}

type ClaimedImportRow = Omit<ClaimedImportJob, 'config' | 'cursor'> & {
  config: string;
  cursor: string;
};

// Claims up to `limit` due import jobs (default 1: one job per queue message). Claiming
// pushes next_attempt_at forward by the lease and bumps attempts, so a job whose consumer
// crashes mid-tick becomes claimable again once the lease expires — status stays 'pending'
// throughout, the same as webhook_delivery, so the lease alone drives crash recovery. The
// claim is one UPDATE ... WHERE id IN (SELECT ...): D1 serializes writes, so two consumers
// never get the same job.
//
// last_error is cleared here too, the moment a claim starts a new attempt — not only on
// success. The Settings UI reads a non-null last_error as "waiting out a retry" (see
// SettingsImportExportJobRow.tsx), computing the countdown from next_attempt_at; without
// this, a poll landing while the new attempt is still in flight would show the old error next
// to the lease's own deadline as if it were the retry countdown, even though the job is
// actively working, not waiting.
export async function claimDueImportJobs(
  db: Db,
  limit = 1,
  nowMs: number = Date.now(),
): Promise<ClaimedImportJob[]> {
  const rows = await allRows<ClaimedImportRow>(
    db,
    `UPDATE import_job
     SET attempts = attempts + 1, next_attempt_at = ?, last_error = NULL
     WHERE status = 'pending' AND next_attempt_at <= ? AND id IN (
       SELECT id FROM import_job
       WHERE status = 'pending' AND next_attempt_at <= ?
       ORDER BY next_attempt_at, id
       LIMIT ?
     )
     RETURNING
       id,
       project_id AS projectId,
       source,
       phase,
       status,
       config,
       cursor,
       attempts,
       credential_ciphertext AS credentialCiphertext,
       credential_iv AS credentialIv,
       credential_auth_tag AS credentialAuthTag`,
    [nowMs + LEASE_SECONDS * 1000, nowMs, nowMs, limit],
  );
  return rows.map((r) => ({
    ...r,
    config: parseJson<Record<string, unknown>>(r.config, {}),
    cursor: parseJson<Record<string, unknown>>(r.cursor, {}),
  }));
}

// Whether a job is due, for the cron to decide to wake the queue consumer.
export async function hasDueImportJobs(db: Db, nowMs: number = Date.now()): Promise<boolean> {
  const rows = await allRows<{ one: number }>(
    db,
    `SELECT 1 AS one FROM import_job WHERE status = 'pending' AND next_attempt_at <= ? LIMIT 1`,
    [nowMs],
  );
  return rows.length > 0;
}

export function decryptImportCredential(job: ClaimedImportJob): ImportCredential {
  if (!job.credentialCiphertext || !job.credentialIv || !job.credentialAuthTag) {
    throw new Error(`import job ${job.id} has no stored credential`);
  }
  const encrypted: EncryptedSecret = {
    ciphertext: job.credentialCiphertext,
    iv: job.credentialIv,
    authTag: job.credentialAuthTag,
  };
  return JSON.parse(decryptSecret(encrypted)) as ImportCredential;
}

// A successful tick clears the claim lease (nextAttemptAt) and lastError, and
// resets attempts, so the next tick can claim the job right away instead of
// waiting out the lease claimDueImportJobs set, and a resolved rate limit or
// transient failure doesn't linger as if it were still happening. `attempts`
// counts consecutive claims with no successful tick in between, not ticks
// claimed overall, so a transient error only fails the job after MAX_ATTEMPTS
// in a row.
export async function saveImportJobCursor(
  db: Db,
  jobId: number,
  cursor: object,
  nowMs: number = Date.now(),
): Promise<void> {
  await db
    .update(importJob)
    .set({
      cursor,
      attempts: 0,
      nextAttemptAt: new Date(nowMs),
      lastError: null,
      updatedAt: new Date(nowMs),
    })
    .where(eq(importJob.id, jobId));
}

export async function advanceImportJobPhase(
  db: Db,
  jobId: number,
  phase: string,
  cursor: object,
  nowMs: number = Date.now(),
): Promise<void> {
  await db
    .update(importJob)
    .set({
      phase,
      cursor,
      attempts: 0,
      nextAttemptAt: new Date(nowMs),
      lastError: null,
      updatedAt: new Date(nowMs),
    })
    .where(eq(importJob.id, jobId));
}

// Terminal states clear the credential columns: nothing needs to read them
// again once the job can no longer make progress.
export async function completeImportJob(db: Db, jobId: number): Promise<void> {
  await db
    .update(importJob)
    .set({
      status: 'completed',
      phase: 'done',
      lastError: null,
      updatedAt: new Date(),
      credentialCiphertext: null,
      credentialIv: null,
      credentialAuthTag: null,
    })
    .where(eq(importJob.id, jobId));
}

export async function failImportJob(db: Db, jobId: number, error: string): Promise<void> {
  await db
    .update(importJob)
    .set({
      status: 'failed',
      lastError: error.slice(0, 500),
      updatedAt: new Date(),
      credentialCiphertext: null,
      credentialIv: null,
      credentialAuthTag: null,
    })
    .where(eq(importJob.id, jobId));
}

// A transient failure (rate limited, a network error, an unreachable
// instance): reschedule rather than fail the job outright. A tick that does not
// count as an attempt (a rate limit) gives back the bump its claim made.
export async function retryImportJobLater(
  db: Db,
  jobId: number,
  delayMs: number,
  error: string,
  countsAsAttempt: boolean,
  nowMs: number = Date.now(),
): Promise<void> {
  const delaySeconds = Math.max(1, Math.ceil(delayMs / 1000));
  await db
    .update(importJob)
    .set({
      ...(countsAsAttempt ? {} : { attempts: sql`max(${importJob.attempts} - 1, 0)` }),
      nextAttemptAt: new Date(nowMs + delaySeconds * 1000),
      lastError: error.slice(0, 500),
      updatedAt: new Date(nowMs),
    })
    .where(eq(importJob.id, jobId));
}

export type ImportEntityType = 'issue' | 'comment' | 'label' | 'state' | 'cycle' | 'attachment';

// Bulk id-only snapshot write for the Discover phase: rows start with no local
// mapping. Idempotent — a source id already recorded (from an earlier attempt
// at this same phase) is left alone. Chunked under D1's bound-parameter limit, the chunks
// in one batch.
const DISCOVER_CHUNK = 30;

export async function insertDiscoveredIds(
  db: Db,
  jobId: number,
  entityType: ImportEntityType,
  sourceIds: string[],
): Promise<void> {
  if (sourceIds.length === 0) return;
  const statements = chunks(sourceIds, DISCOVER_CHUNK).map((ids) =>
    db
      .insert(importRecord)
      .values(
        ids.map((sourceId) => ({
          importJobId: jobId,
          sourceEntityType: entityType,
          sourceId,
        })),
      )
      .onConflictDoNothing(),
  );
  const [first, ...rest] = statements;
  await db.batch([first!, ...rest]);
}

// The idempotent-upsert primitive keyed on the unique index
// (import_job_id, source_entity_type, source_id): inserts a fresh mapping, or
// overwrites the local mapping of one that already exists (Discover wrote it
// with no local id, Create is now filling it in). `localIdSql` is the SQL that yields the
// local id, so the statement can sit in a batch behind the insert that creates the row; the
// mapping is written only while `guardSql` holds (default: always).
function recordUpsertStatement(
  jobId: number,
  entityType: ImportEntityType,
  sourceId: string,
  localEntityType: ImportEntityType | null,
  local: { sql: string; params: SqlValue[] },
  sourceDisplayId: string | null = null,
  guard: { sql: string; params: SqlValue[] } = { sql: '1', params: [] },
): Statement {
  return {
    sql: `INSERT INTO import_record
            (import_job_id, source_entity_type, source_id, source_display_id, local_entity_type, local_id)
          SELECT ?, ?, ?, ?, ?, (${local.sql}) WHERE ${guard.sql}
          ON CONFLICT (import_job_id, source_entity_type, source_id) DO UPDATE SET
            local_entity_type = excluded.local_entity_type,
            local_id = excluded.local_id,
            source_display_id = excluded.source_display_id`,
    params: [
      jobId,
      entityType,
      sourceId,
      sourceDisplayId,
      localEntityType,
      ...local.params,
      ...guard.params,
    ],
  };
}

const literalId = (id: number) => ({ sql: '?', params: [id] as SqlValue[] });

// True for a local row this job has not mapped yet. A row the same job already
// mapped belongs to another source record, so it is never that record's duplicate:
// two source issues may share a title, two comments a body and a timestamp. A row an
// earlier job mapped stays reusable, which is what makes a re-run not duplicate.
function notMappedByJob(jobId: number, entityType: ImportEntityType, localId: Column) {
  return sql`NOT EXISTS (
    SELECT 1 FROM ${importRecord}
    WHERE ${importRecord.importJobId} = ${jobId}
      AND ${importRecord.sourceEntityType} = ${entityType}
      AND ${importRecord.localId} = ${localId}
  )`;
}

export async function upsertImportRecord(
  db: Db,
  jobId: number,
  entityType: ImportEntityType,
  sourceId: string,
  localEntityType: ImportEntityType | null,
  localId: number | null,
): Promise<void> {
  const stmt = recordUpsertStatement(
    jobId,
    entityType,
    sourceId,
    localEntityType,
    localId === null ? { sql: 'NULL', params: [] } : literalId(localId),
  );
  await batchResults(db, [stmt]);
}

export async function findImportRecord(
  db: Db,
  jobId: number,
  entityType: ImportEntityType,
  sourceId: string,
): Promise<{ localId: number | null } | null> {
  const rows = await db
    .select({ localId: importRecord.localId })
    .from(importRecord)
    .where(
      and(
        eq(importRecord.importJobId, jobId),
        eq(importRecord.sourceEntityType, entityType),
        eq(importRecord.sourceId, sourceId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

// The same lookup for many source ids at once, in as few queries as the 100-parameter limit
// allows. Returns source id -> local id for the records that exist and are mapped.
export async function findImportRecordLocalIds(
  db: Db,
  jobId: number,
  entityType: ImportEntityType,
  sourceIds: string[],
): Promise<Map<string, number>> {
  const found = new Map<string, number>();
  for (const ids of chunks([...new Set(sourceIds)], 90)) {
    const rows = await db
      .select({ sourceId: importRecord.sourceId, localId: importRecord.localId })
      .from(importRecord)
      .where(
        and(
          eq(importRecord.importJobId, jobId),
          eq(importRecord.sourceEntityType, entityType),
          inArray(importRecord.sourceId, ids),
        ),
      );
    for (const row of rows) if (row.localId != null) found.set(row.sourceId, row.localId);
  }
  return found;
}

// Resolves a cross-reference like "ROOMS-524" during the Rewrite phase: the
// captured number is the source's own display id, not its sourceId (a UUID for
// Plane), so this looks up by the column Create stashed it in instead.
export async function findImportRecordByDisplayId(
  db: Db,
  jobId: number,
  entityType: ImportEntityType,
  sourceDisplayId: string,
): Promise<{ localId: number | null } | null> {
  const rows = await db
    .select({ localId: importRecord.localId })
    .from(importRecord)
    .where(
      and(
        eq(importRecord.importJobId, jobId),
        eq(importRecord.sourceEntityType, entityType),
        eq(importRecord.sourceDisplayId, sourceDisplayId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export interface ImportRecordRow {
  id: number;
  sourceId: string;
}

export async function listImportRecords(
  db: Db,
  jobId: number,
  entityType: ImportEntityType,
  afterId: number,
  limit: number,
): Promise<ImportRecordRow[]> {
  return db
    .select({ id: importRecord.id, sourceId: importRecord.sourceId })
    .from(importRecord)
    .where(
      and(
        eq(importRecord.importJobId, jobId),
        eq(importRecord.sourceEntityType, entityType),
        gt(importRecord.id, afterId),
      ),
    )
    .orderBy(importRecord.id)
    .limit(limit);
}

// The next chunk of this job's snapshot that has not been materialized yet,
// keyset-paginated on import_record's own id — Telic's own position in the
// snapshot list, not the source's pagination cursor (see the notes file). A
// retried tick naturally skips rows a crashed earlier attempt already created,
// since those no longer match "local id still null".
export async function listUncreatedImportRecords(
  db: Db,
  jobId: number,
  entityType: ImportEntityType,
  afterId: number,
  limit: number,
): Promise<ImportRecordRow[]> {
  return db
    .select({ id: importRecord.id, sourceId: importRecord.sourceId })
    .from(importRecord)
    .where(
      and(
        eq(importRecord.importJobId, jobId),
        eq(importRecord.sourceEntityType, entityType),
        gt(importRecord.id, afterId),
        isNull(importRecord.localId),
      ),
    )
    .orderBy(importRecord.id)
    .limit(limit);
}

export interface CreatedImportRecordRow extends ImportRecordRow {
  // Guaranteed set by the isNotNull(localId) filter below; the column itself
  // is nullable so the query builder can't narrow it on its own.
  localId: number;
}

// The next chunk of this job's already-created issues, for the Link phase to
// fetch relations for.
export async function listCreatedImportRecords(
  db: Db,
  jobId: number,
  entityType: ImportEntityType,
  afterId: number,
  limit: number,
): Promise<CreatedImportRecordRow[]> {
  const rows = await db
    .select({ id: importRecord.id, sourceId: importRecord.sourceId, localId: importRecord.localId })
    .from(importRecord)
    .where(
      and(
        eq(importRecord.importJobId, jobId),
        eq(importRecord.sourceEntityType, entityType),
        gt(importRecord.id, afterId),
        isNotNull(importRecord.localId),
      ),
    )
    .orderBy(importRecord.id)
    .limit(limit);
  return rows as CreatedImportRecordRow[];
}

export async function firstProjectColumnId(db: Db, projectId: number): Promise<number | null> {
  const rows = await db
    .select({ id: projectColumn.id })
    .from(projectColumn)
    .where(eq(projectColumn.projectId, projectId))
    .orderBy(projectColumn.position)
    .limit(1);
  return rows[0]?.id ?? null;
}

export async function getProjectKey(db: Db, projectId: number): Promise<string> {
  const [row] = await db
    .select({ key: project.key })
    .from(project)
    .where(eq(project.id, projectId));
  if (!row) throw new Error(`project ${projectId} not found`);
  return row.key;
}

export async function getIssueSequenceNumber(db: Db, issueId: number): Promise<number | null> {
  const [row] = await db
    .select({ sequenceNumber: issue.sequenceNumber })
    .from(issue)
    .where(eq(issue.id, issueId));
  return row?.sequenceNumber ?? null;
}

export interface IssueTextForRewrite {
  description: string;
  comments: { id: number; body: string }[];
}

// What the Rewrite phase scans: the issue's own description plus every comment
// on it, each already local (no more Plane requests needed for this phase).
export async function getIssueTextForRewrite(
  db: Db,
  issueId: number,
): Promise<IssueTextForRewrite> {
  const [issueRow] = await db
    .select({ description: issue.description })
    .from(issue)
    .where(eq(issue.id, issueId));
  const comments = await db
    .select({ id: issueActivity.id, body: issueActivity.body })
    .from(issueActivity)
    .where(and(eq(issueActivity.issueId, issueId), eq(issueActivity.kind, 'comment')));
  return {
    description: issueRow?.description ?? '',
    comments: comments.map((c) => ({ id: c.id, body: c.body ?? '' })),
  };
}

export async function updateIssueDescription(
  db: Db,
  issueId: number,
  description: string,
): Promise<void> {
  await db.update(issue).set({ description }).where(eq(issue.id, issueId));
}

export async function updateCommentBody(db: Db, commentId: number, body: string): Promise<void> {
  await db.update(issueActivity).set({ body }).where(eq(issueActivity.id, commentId));
}

// project_column has no unique constraint to upsert against like label does,
// so an exact name match within the project is looked up first and reused —
// otherwise every project's own default columns (every new project starts
// with a "Backlog") collide with Plane's own states of the same name and
// duplicate them. A match reuses the existing column's stateType rather than
// overwriting it with Plane's category: unlike a label's color, a column's
// category can move issues between board sections, so an import should not
// silently change how an existing, possibly hand-configured column behaves.
// The insert-unless-the-name-exists and the mapping are one batch for the same crash-safety
// reason as before — a project_column still has nothing to fall back on for a retry once
// created.
export async function createLocalStateAndRecord(
  db: Db,
  jobId: number,
  sourceId: string,
  projectId: number,
  state: CanonicalState,
): Promise<number> {
  const byName = {
    sql: `SELECT id FROM project_column WHERE project_id = ? AND name = ? ORDER BY id LIMIT 1`,
    params: [projectId, state.name] as SqlValue[],
  };
  const results = await batchResults(db, [
    {
      sql: `INSERT INTO project_column (project_id, name, state_type, position)
            SELECT ?, ?, ?, next_position
            FROM (SELECT COALESCE(MAX(position), 0) + 1 AS next_position
                  FROM project_column WHERE project_id = ?)
            WHERE NOT EXISTS (SELECT 1 FROM project_column WHERE project_id = ? AND name = ?)`,
      params: [projectId, state.name, state.category, projectId, projectId, state.name],
    },
    recordUpsertStatement(jobId, 'state', sourceId, 'state', byName),
    byName,
  ]);
  return Number(results[2]!.rows[0]!.id);
}

// A label of the same name already existing (created by hand before the
// import ran) is reused rather than duplicated, matching label's own
// unique(project_id, name).
export async function createLocalLabel(
  db: Db,
  projectId: number,
  canonicalLabel: CanonicalLabel,
): Promise<number> {
  const color = canonicalLabel.color ?? '#6b7280';
  const rows = await allRows<{ id: number }>(
    db,
    `INSERT INTO label (project_id, name, color) VALUES (?, ?, ?)
     ON CONFLICT (project_id, name) DO UPDATE SET color = excluded.color
     RETURNING id`,
    [projectId, canonicalLabel.name, color],
  );
  return rows[0]!.id;
}

// Same name-match-and-reuse reasoning as createLocalStateAndRecord: a cycle
// has no unique constraint to upsert against, so an existing cycle of the
// same name is reused rather than duplicated.
export async function createLocalCycleAndRecord(
  db: Db,
  jobId: number,
  sourceId: string,
  projectId: number,
  canonicalCycle: CanonicalCycle,
): Promise<number> {
  const byName = {
    sql: `SELECT id FROM cycle WHERE project_id = ? AND name = ? ORDER BY id LIMIT 1`,
    params: [projectId, canonicalCycle.name] as SqlValue[],
  };
  const results = await batchResults(db, [
    {
      sql: `INSERT INTO cycle (project_id, name, goal, start_date, end_date)
            SELECT ?, ?, ?, ?, ?
            WHERE NOT EXISTS (SELECT 1 FROM cycle WHERE project_id = ? AND name = ?)`,
      params: [
        projectId,
        canonicalCycle.name,
        canonicalCycle.goal ?? '',
        canonicalCycle.startDate,
        canonicalCycle.endDate,
        projectId,
        canonicalCycle.name,
      ],
    },
    recordUpsertStatement(jobId, 'cycle', sourceId, 'cycle', byName),
    byName,
  ]);
  return Number(results[2]!.rows[0]!.id);
}

export interface NewLocalIssue {
  projectId: number;
  columnId: number;
  cycleId: number | null;
  parentId: number | null;
  assigneeUserId: string | null;
  title: string;
  description: string;
  priority: string | null;
  startDate: string | null;
  dueDate: string | null;
  // The source's own ISO timestamps. Absent or unparseable leaves the column default, now().
  createdAt?: string;
  updatedAt?: string;
}

function sourceTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

// An issue whose title matches one already in the project (case- and
// whitespace-insensitive, the same comparison the file-based importer uses), and
// that this job has not already mapped to another source issue, is reused
// instead of duplicated — the same protection createLocalLabel and
// createLocalStateAndRecord give their own entities. Comments and labels the
// import attaches afterward land on that existing issue rather than being
// orphaned. Skipped for a blank title: input.title falls back to
// '(untitled)' below, and matching on that fallback would merge every
// untitled Plane issue into whichever one happened to import first, which is
// not a duplicate in any real sense.
//
// Sequence numbers ("MKT-42") come from project.next_sequence, bumped in the same batch as
// the insert (D1 runs a batch as one atomic write, so a bulk import never collides with a
// concurrent interactive create). The import_record mapping is written in that batch too: an
// issue has no unique constraint a retry could fall back on (a fresh sequence number is
// issued every time), so a crash between the insert and the mapping would otherwise
// duplicate the issue on the next attempt. sourceDisplayId (the source's own issue number)
// is stashed on that same mapping either way, for the Rewrite phase.
export async function createLocalIssueAndRecord(
  db: Db,
  jobId: number,
  sourceId: string,
  sourceDisplayId: string,
  input: NewLocalIssue,
): Promise<number> {
  if (input.title.trim()) {
    const [existing] = await db
      .select({ id: issue.id })
      .from(issue)
      .where(
        and(
          eq(issue.projectId, input.projectId),
          sql`lower(trim(${issue.title})) = lower(trim(${input.title}))`,
          notMappedByJob(jobId, 'issue', issue.id),
        ),
      )
      .orderBy(issue.id)
      .limit(1);
    if (existing) {
      await batchResults(db, [
        recordUpsertStatement(
          jobId,
          'issue',
          sourceId,
          'issue',
          literalId(existing.id),
          sourceDisplayId,
        ),
      ]);
      return existing.id;
    }
  }
  const issueByNewSequence = {
    sql: `SELECT id FROM issue WHERE project_id = ?
            AND sequence_number = (SELECT next_sequence - 1 FROM project WHERE id = ?)`,
    params: [input.projectId, input.projectId] as SqlValue[],
  };
  const results = await batchResults(db, [
    {
      sql: `UPDATE project SET next_sequence = next_sequence + 1 WHERE id = ?`,
      params: [input.projectId],
    },
    {
      sql: `INSERT INTO issue
              (project_id, sequence_number, column_id, cycle_id, parent_id, assignee_user_id,
               title, description, priority, start_date, due_date, position, created_at, updated_at)
            SELECT p.id, p.next_sequence - 1, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                   (SELECT COALESCE(MAX(position), 0) + 1000 FROM issue WHERE column_id = ?),
                   COALESCE(?, ${NOW_MS_SQL}), COALESCE(?, ${NOW_MS_SQL})
            FROM project p WHERE p.id = ?`,
      params: [
        input.columnId,
        input.cycleId,
        input.parentId,
        input.assigneeUserId,
        input.title || '(untitled)',
        input.description,
        input.priority,
        input.startDate,
        input.dueDate,
        input.columnId,
        sourceTimestamp(input.createdAt),
        sourceTimestamp(input.updatedAt),
        input.projectId,
      ],
    },
    recordUpsertStatement(jobId, 'issue', sourceId, 'issue', issueByNewSequence, sourceDisplayId, {
      sql: `EXISTS (SELECT 1 FROM project WHERE id = ?)`,
      params: [input.projectId],
    }),
    issueByNewSequence,
  ]);
  const row = results[3]!.rows[0];
  if (!row) throw new Error(`project ${input.projectId} not found`);
  return Number(row.id);
}

// issue_label rows are two bound parameters each: inserted a chunk per statement, in one batch.
export async function setIssueLabels(db: Db, issueId: number, labelIds: number[]): Promise<void> {
  if (labelIds.length === 0) return;
  const [first, ...rest] = chunks(labelIds, 40).map((ids) =>
    db
      .insert(issueLabel)
      .values(ids.map((labelId) => ({ issueId, labelId })))
      .onConflictDoNothing(),
  );
  await db.batch([first!, ...rest]);
}

// A comment already on the issue with the same body and createdAt (the two
// fields Plane's own record carries verbatim), and not already mapped by this
// job, is reused instead of duplicated — the same reuse-by-content protection
// issues, states, and cycles get, needed here because a second import job
// resolves the parent issue to the same, already-created row and would otherwise
// re-post every comment on it.
export async function createLocalComment(
  db: Db,
  jobId: number,
  issueId: number,
  authorUserId: string | null,
  authorName: string,
  bodyMarkdown: string,
  createdAt: Date,
  replyToId: number | null,
): Promise<number> {
  const [existing] = await db
    .select({ id: issueActivity.id })
    .from(issueActivity)
    .where(
      and(
        eq(issueActivity.issueId, issueId),
        eq(issueActivity.kind, 'comment'),
        eq(issueActivity.body, bodyMarkdown),
        eq(issueActivity.createdAt, createdAt),
        notMappedByJob(jobId, 'comment', issueActivity.id),
      ),
    )
    .orderBy(issueActivity.id)
    .limit(1);
  if (existing) return existing.id;

  const [row] = await db
    .insert(issueActivity)
    .values({
      issueId,
      kind: 'comment',
      body: bodyMarkdown,
      actorUserId: authorUserId,
      actorName: authorName,
      replyToId,
      createdAt,
    })
    .returning({ id: issueActivity.id });
  return row!.id;
}

// Sets an issue's parent the first time one resolves. Create sets parentId from
// whatever import_record knows at that moment, which misses a sub-issue processed
// before its parent exists; Link revisits every issue a second time (see runLink)
// and calls this once the parent is resolvable. The parent_id IS NULL guard makes
// a retry a no-op and never overwrites a parent Create already got right.
export async function setIssueParentIfUnset(
  db: Db,
  issueId: number,
  parentId: number,
): Promise<void> {
  if (issueId === parentId) return;
  await db
    .update(issue)
    .set({ parentId })
    .where(and(eq(issue.id, issueId), isNull(issue.parentId)));
}

// issue_link's unique index is on the unordered pair + kind, so re-running the
// Link phase for an issue whose relations were already created is a no-op:
// the duplicate insert is dropped by ON CONFLICT DO NOTHING rather than failing the tick.
export async function createIssueLink(
  db: Db,
  sourceIssueId: number,
  targetIssueId: number,
  kind: string,
): Promise<void> {
  if (sourceIssueId === targetIssueId) return;
  await db.insert(issueLink).values({ sourceIssueId, targetIssueId, kind }).onConflictDoNothing();
}

// Only a user who already belongs to the project is matched: an import never
// adds someone to the project on its own just because their email matched a
// Plane assignee or comment author.
export async function findProjectMemberUserId(
  db: Db,
  projectId: number,
  email: string,
): Promise<string | null> {
  const rows = await db
    .select({ userId: projectMember.userId })
    .from(projectMember)
    .innerJoin(user, eq(user.id, projectMember.userId))
    .where(and(eq(projectMember.projectId, projectId), sql`lower(${user.email}) = lower(${email})`))
    .limit(1);
  return rows[0]?.userId ?? null;
}

export interface NewLocalAttachment {
  projectId: number;
  issueId: number;
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

// The bytes a project has stored, summed in SQL across every kind that counts against its
// quota — the same three tables projectStoredBytes reads, as a subquery the insert can
// condition on. Three bound parameters, all the project id.
const PROJECT_STORED_BYTES_SQL = `(
    (SELECT COALESCE(SUM(a.size_bytes), 0) FROM issue_attachment a
       JOIN issue i ON i.id = a.issue_id WHERE i.project_id = ?)
  + (SELECT COALESCE(SUM(d.size_bytes), 0) FROM document_asset d
       JOIN project_document pd ON pd.id = d.document_id WHERE pd.project_id = ?)
  + (SELECT COALESCE(SUM(ia.size_bytes), 0) FROM initiative_attachment ia
       JOIN initiative n ON n.id = ia.initiative_id WHERE n.project_id = ?)
)`;

// Reuse-before-duplicate, the same shape as the other entities: an attachment
// already on this issue with the same filename is reused rather than re-uploaded
// on a second import run. Size, mime type, and project quota are all checked
// against the instance's own settings before the upload, so a file that cannot
// be stored never reaches the object store at all. The quota is then enforced by the insert
// itself, which only lands while the project's stored bytes plus this file stay within it:
// the first check keeps a doomed-to-reject file off the object store, the second is the one a
// concurrent write can't slip past (D1 has no lock to hold between a check and an insert).
export async function createLocalAttachmentAndRecord(
  db: Db,
  jobId: number,
  sourceId: string,
  input: NewLocalAttachment,
): Promise<number> {
  const filename = safeAttachmentFilename(input.filename);
  const existing = await allRows<{ id: number }>(
    db,
    `SELECT id FROM issue_attachment WHERE issue_id = ? AND filename = ? ORDER BY id LIMIT 1`,
    [input.issueId, filename],
  );
  if (existing[0]) {
    await upsertImportRecord(db, jobId, 'attachment', sourceId, 'attachment', existing[0].id);
    return existing[0].id;
  }

  const limits = await getStorageSettings(db);
  if (input.bytes.length > limits.maxAttachmentMb * MB) {
    throw new AttachmentRejectedError(
      `"${filename}" is ${Math.ceil(input.bytes.length / MB)} MB, over the ${limits.maxAttachmentMb} MB limit`,
    );
  }
  if (!mimeAllowed(input.contentType, limits.attachmentMimeTypes)) {
    throw new AttachmentRejectedError(
      `"${filename}" is type "${input.contentType}", not accepted on this instance`,
    );
  }
  const quotaBytes = limits.projectQuotaMb > 0 ? limits.projectQuotaMb * MB : 0;
  if (quotaBytes > 0) {
    const used = await projectStoredBytes(db, input.projectId);
    if (used + input.bytes.length > quotaBytes) {
      throw new AttachmentRejectedError(
        `the project has used its ${limits.projectQuotaMb} MB storage quota`,
      );
    }
  }

  const key = attachmentObjectKey(input.projectId, 'attachments', input.issueId, filename);
  await putObject(key, input.bytes, input.contentType);

  try {
    const byKey = {
      sql: `SELECT id FROM issue_attachment WHERE s3_key = ?`,
      params: [key] as SqlValue[],
    };
    const results = await batchResults(db, [
      {
        // public_id is generated by the ORM on D1, so a raw insert supplies it.
        sql: `INSERT INTO issue_attachment
                (public_id, issue_id, s3_key, filename, content_type, size_bytes)
              SELECT ?, ?, ?, ?, ?, ?
              WHERE ? = 0 OR ${PROJECT_STORED_BYTES_SQL} + ? <= ?`,
        params: [
          crypto.randomUUID(),
          input.issueId,
          key,
          filename,
          input.contentType,
          input.bytes.length,
          quotaBytes,
          input.projectId,
          input.projectId,
          input.projectId,
          input.bytes.length,
          quotaBytes,
        ],
      },
      recordUpsertStatement(jobId, 'attachment', sourceId, 'attachment', byKey, null, {
        sql: `EXISTS (SELECT 1 FROM issue_attachment WHERE s3_key = ?)`,
        params: [key],
      }),
      byKey,
    ]);
    const row = results[2]!.rows[0];
    if (!row) {
      throw new AttachmentRejectedError(
        `the project has used its ${limits.projectQuotaMb} MB storage quota`,
      );
    }
    return Number(row.id);
  } catch (error) {
    await deleteObject(key).catch(() => {});
    throw error;
  }
}
