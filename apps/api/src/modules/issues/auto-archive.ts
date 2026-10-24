import { type Db } from '@repo/db';
import { sql } from 'drizzle-orm';
import { recordActivityForIssues } from './activity';
import { getIssues } from './service';
import { emitIssueEvents } from './webhook-payload';

// Archives active issues that have sat inactive in a completed/canceled column past
// their project's threshold. Inactivity is measured by issue.updated_at: moving to a
// terminal column bumps it, and any later edit resets the clock, so an issue is
// archived only after the full period with no activity.
export async function sweepStaleIssues(db: Db): Promise<number> {
  // The threshold lives in project_setting under key 'auto_archive' as
  // { completedDays, canceledDays } (kept in sync with getAutoArchiveSettings in
  // modules/projects/service.ts); a positive day count enables archiving for that state
  // group, null/absent disables it. The digits-only test guards the cast, so a
  // malformed value is treated as disabled rather than raising. Timestamps are epoch
  // milliseconds, computed here: a single UPDATE ... RETURNING is atomic on D1.
  const nowMs = Date.now();
  const DAY_MS = 86_400_000;
  const days = (key: string) => sql.raw(`CAST(json_extract(s.value, '$.${key}') AS TEXT)`);
  const digits = (key: string) =>
    sql`(${days(key)} IS NOT NULL AND length(${days(key)}) BETWEEN 1 AND 4 AND ${days(key)} NOT GLOB '*[^0-9]*')`;
  const rows = await db.all<{ id: number; project_id: number }>(sql`
    UPDATE issue
    SET archived_at = ${nowMs}
    WHERE archived_at IS NULL
      AND id IN (
        SELECT i.id
        FROM issue i
        JOIN project_column c ON c.id = i.column_id
        JOIN project_setting s ON s.project_id = i.project_id AND s.key = 'auto_archive'
        JOIN project p ON p.id = i.project_id
        WHERE p.archived_at IS NULL
          AND i.archived_at IS NULL
          AND (
            (c.state_type = 'completed'
              AND ${digits('completedDays')}
              AND i.updated_at < ${nowMs} - CAST(${days('completedDays')} AS INTEGER) * ${DAY_MS})
            OR
            (c.state_type = 'canceled'
              AND ${digits('canceledDays')}
              AND i.updated_at < ${nowMs} - CAST(${days('canceledDays')} AS INTEGER) * ${DAY_MS})
          )
      )
    RETURNING id, project_id
  `);
  const archivedRows = rows;
  const archived = archivedRows.map((row) => row.id);
  const actor = { system: 'Auto-archive' };
  await recordActivityForIssues(db, archived, { action: 'archived' }, actor);
  const idsByProject = new Map<number, number[]>();
  for (const row of archivedRows) {
    const ids = idsByProject.get(row.project_id) ?? [];
    ids.push(row.id);
    idsByProject.set(row.project_id, ids);
  }
  for (const [projectId, ids] of idsByProject)
    await emitIssueEvents(db, projectId, 'issue.updated', () => getIssues(db, ids), actor);
  return archived.length;
}
