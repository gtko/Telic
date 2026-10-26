// Migration 0007_sentry_triage on a database that already holds columns, an issue and the rows
// that point at those columns: applies 0000..0006, inserts the rows, then 0007, and checks the
// columns keep their ids, names and positions, the references keep their column, and a triage
// column can be inserted.
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../client';
import { migrateD1, migrationsFolder } from '../migrate';

type Column = { id: number; name: string; position: number };

let mf: Miniflare;
let db: Db;
let columnsBefore: Column[];

const insertTriageColumn = () =>
  db.run(
    sql`INSERT INTO project_column (project_id, name, state_type, position) VALUES (1, 'Triage', 'triage', 2000)`,
  );

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: 'sentry-triage-migration-db' },
  });
  db = createDb((await mf.getD1Database('DB')) as unknown as D1Database);

  const before = mkdtempSync(join(tmpdir(), 'd1-0006-'));
  cpSync(migrationsFolder, before, { recursive: true });
  const journalPath = join(before, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  journal.entries = journal.entries.filter((e: { tag: string }) => e.tag < '0007');
  writeFileSync(journalPath, JSON.stringify(journal));
  await migrateD1(db, before);

  await db.run(sql`INSERT INTO user (id, name, email) VALUES ('u1', 'Ada', 'a@example.com')`);
  await db.run(sql`INSERT INTO workspace (name) VALUES ('Acme')`);
  await db.run(sql`INSERT INTO team (workspace_id, name) VALUES (1, 'Core')`);
  await db.run(sql`INSERT INTO project (team_id, key, name) VALUES (1, 'MKT', 'Marketing')`);
  await db.run(
    sql`INSERT INTO project_column (project_id, name, state_type, position) VALUES (1, 'Backlog', 'backlog', 0)`,
  );
  await db.run(
    sql`INSERT INTO project_column (project_id, name, state_type, position) VALUES (1, 'In progress', 'started', 1000)`,
  );
  await db.run(
    sql`INSERT INTO issue (project_id, sequence_number, column_id, title) VALUES (1, 1, 1, 'Keep me')`,
  );
  await db.run(
    sql`INSERT INTO issue_status (issue_id, column_id, column_name, state_type) VALUES (1, 2, 'In progress', 'started')`,
  );
  await db.run(sql`INSERT INTO issue_template (project_id, name, column_id) VALUES (1, 'Bug', 2)`);

  columnsBefore = await db.all<Column>(
    sql`SELECT id, name, position FROM project_column ORDER BY id`,
  );
  // Before 0007 the CHECK on state_type does not list 'triage', so the insert is refused.
  await expect(insertTriageColumn()).rejects.toThrow();

  await migrateD1(db);
});

afterAll(async () => {
  await mf.dispose();
});

describe('0007_sentry_triage on existing data', () => {
  it('keeps every column with its id, name and position', async () => {
    const columns = await db.all<Column>(
      sql`SELECT id, name, position FROM project_column ORDER BY id`,
    );
    expect(columns).toEqual(columnsBefore);
  });

  it('keeps the issue in its column', async () => {
    const [row] = await db.all<{ column_id: number }>(
      sql`SELECT column_id FROM issue WHERE id = 1`,
    );
    expect(row!.column_id).toBe(1);
  });

  it('keeps the status and template references on their column', async () => {
    const [status] = await db.all<{ column_id: number | null }>(
      sql`SELECT column_id FROM issue_status WHERE issue_id = 1`,
    );
    expect(status!.column_id).toBe(2);
    const [template] = await db.all<{ column_id: number | null }>(
      sql`SELECT column_id FROM issue_template WHERE name = 'Bug'`,
    );
    expect(template!.column_id).toBe(2);
  });

  it('leaves no foreign key violation', async () => {
    expect(await db.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
  });

  it('accepts a column in the triage state', async () => {
    await insertTriageColumn();
    const rows = await db.all<{ name: string }>(
      sql`SELECT name FROM project_column WHERE state_type = 'triage'`,
    );
    expect(rows).toEqual([{ name: 'Triage' }]);
  });
});
