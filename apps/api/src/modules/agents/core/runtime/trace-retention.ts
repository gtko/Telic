import { aiSpans, type Db } from '@repo/db';
import { sql, type SQL } from 'drizzle-orm';
import { getAgentSettings } from '#modules/settings/service';
import type { AgentRuntime } from './bindings';

// D1 binds at most 100 parameters to a statement: a batch of trace ids goes through one
// `IN (...)`, so it stays well under that.
const BATCH = 50;
const MAX_BATCHES = 100;

// Deletes one batch of traces whose root matches `where`, with the R2 objects their large
// payloads were moved to. Returns the spans deleted.
async function deleteBatch(rt: AgentRuntime, where: SQL): Promise<number> {
  const roots = await rt.db.all<{ traceId: string }>(sql`
    SELECT trace_id AS traceId FROM ${aiSpans}
    WHERE parent_span_id IS NULL AND (${where})
    LIMIT ${BATCH}
  `);
  if (roots.length === 0) return 0;
  const ids = sql.join(
    roots.map((root) => sql`${root.traceId}`),
    sql`, `,
  );
  if (rt.payloads) {
    const refs = await rt.db.all<{ inputRef: string | null; outputRef: string | null }>(sql`
      SELECT input_ref AS inputRef, output_ref AS outputRef FROM ${aiSpans}
      WHERE trace_id IN (${ids}) AND (input_ref IS NOT NULL OR output_ref IS NOT NULL)
    `);
    const keys = refs.flatMap((row) => [row.inputRef, row.outputRef]).filter((k) => k != null);
    // R2 deletes at most 1000 keys per call; a batch of 50 traces holds far fewer.
    if (keys.length > 0) await rt.payloads.delete(keys);
  }
  const res = await rt.db.run(sql`DELETE FROM ${aiSpans} WHERE trace_id IN (${ids})`);
  return res.meta?.changes ?? 0;
}

async function deleteUntilDone(rt: AgentRuntime, where: SQL): Promise<number> {
  let deleted = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const rows = await deleteBatch(rt, where);
    deleted += rows;
    if (rows === 0) break;
  }
  return deleted;
}

async function pruneRunTraces(db: Db, cutoffMs: number): Promise<number> {
  let deleted = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const removed = await db.run(sql`
      DELETE FROM agent_run_trace
      WHERE (run_id, attempt) IN (
        SELECT t.run_id, t.attempt FROM agent_run_trace t
        INNER JOIN agent_run r ON r.id = t.run_id
        WHERE r.status <> 'pending' AND coalesce(r.finished_at, r.created_at) < ${cutoffMs}
        LIMIT ${BATCH}
      )
    `);
    const count = removed.meta?.changes ?? 0;
    deleted += count;
    if (count === 0) break;
  }
  return deleted;
}

// Zero days keeps all traces. Pending external runs are never pruned.
export async function pruneAgentTraces(rt: AgentRuntime, now = Date.now()): Promise<number> {
  const { traceRetentionDays } = await getAgentSettings(rt.db);
  let deleted = 0;
  if (traceRetentionDays > 0) {
    const cutoffMs = now - traceRetentionDays * 86_400_000;
    deleted += await pruneRunTraces(rt.db, cutoffMs);
    deleted += await deleteUntilDone(rt, sql`started_at < ${cutoffMs}`);
  }
  // A deleted team takes its agents and its runs with it, but the spans carry no foreign
  // keys of ours, so its traces are left behind for this.
  deleted += await deleteUntilDone(
    rt,
    sql`team_id IS NULL OR team_id NOT IN (SELECT id FROM team)`,
  );
  return deleted;
}
