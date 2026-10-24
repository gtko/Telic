import type { Db } from '@repo/db';
import { tryNextCronRun } from '@repo/cron';
import { allRows, runBatch, type Statement } from './d1';
import { parseScheduleTimestamp } from './schedule-timestamp';

type DueSchedule = {
  id: number;
  agentId: number;
  // The project the schedule's runs work in, which the run carries rather than
  // reading it back off the agent: an agent works in several projects of its team.
  projectId: number;
  prompt: string;
  cron: string;
  nextRunAt: number;
};

const BATCH_LIMIT = 50;

// Queues the run of every due cron schedule and moves its next_run_at forward. D1 has no
// row locks, so the claim is the schedule's own next_run_at: each schedule's run insert and
// advance go in one batch that only lands while next_run_at still holds the value that was
// read, so of two workers handling the same schedule the second one's batch changes nothing
// (and the unique (schedule_id, scheduled_for) index would drop a duplicate run anyway).
// Returns how many runs this call queued. `nowMs` is the caller's clock.
export async function enqueueDueSchedules(db: Db, nowMs: number = Date.now()): Promise<number> {
  const due = await allRows<DueSchedule>(
    db,
    `SELECT s.id, s.agent_id AS agentId, s.project_id AS projectId, s.prompt, s.cron,
            s.next_run_at AS nextRunAt
     FROM agent_schedule s
     JOIN project p ON p.id = s.project_id
     WHERE s.type = 'cron' AND s.status = 'active' AND s.next_run_at <= ?
       AND p.archived_at IS NULL
     ORDER BY s.next_run_at, s.id
     LIMIT ?`,
    [nowMs, BATCH_LIMIT],
  );

  let queued = 0;
  for (const row of due) {
    const scheduledFor = parseScheduleTimestamp(row.nextRunAt).getTime();
    const next = row.cron ? tryNextCronRun(row.cron, new Date(nowMs)) : null;
    const statements: Statement[] = [];
    if (!next) {
      statements.push({
        sql: `UPDATE agent_schedule SET status = 'paused', updated_at = ?
              WHERE id = ? AND next_run_at = ?`,
        params: [nowMs, row.id, scheduledFor],
      });
    } else {
      statements.push(
        {
          sql: `INSERT OR IGNORE INTO agent_run
                  (agent_id, project_id, schedule_id, "trigger", scheduled_for, prompt)
                SELECT ?, ?, ?, 'schedule', ?, ?
                WHERE EXISTS (SELECT 1 FROM agent_schedule WHERE id = ? AND next_run_at = ?)`,
          params: [
            row.agentId,
            row.projectId,
            row.id,
            scheduledFor,
            row.prompt,
            row.id,
            scheduledFor,
          ],
        },
        {
          sql: `UPDATE agent_schedule SET next_run_at = ?, last_run_at = ?, updated_at = ?
                WHERE id = ? AND next_run_at = ?`,
          params: [next.getTime(), scheduledFor, nowMs, row.id, scheduledFor],
        },
      );
    }
    const changes = await runBatch(db, statements);
    if (next && (changes[0] ?? 0) > 0) queued++;
  }
  return queued;
}
