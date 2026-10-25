// Migration 0006_remove_ai on a database that already holds data: applies 0000..0005, inserts
// rows, then 0006, and checks the AI tables are gone and the other rows survive.
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../client';
import { migrateD1, migrationsFolder } from '../migrate';

let mf: Miniflare;
let db: Db;

const count = async (query: string) =>
  (await db.all<{ n: number }>(sql.raw(`SELECT count(*) AS n FROM ${query}`)))[0]!.n;

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: 'remove-ai-db' },
  });
  db = createDb((await mf.getD1Database('DB')) as unknown as D1Database);

  const before = mkdtempSync(join(tmpdir(), 'd1-before-'));
  cpSync(migrationsFolder, before, { recursive: true });
  const journalPath = join(before, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  journal.entries = journal.entries.filter((e: { tag: string }) => e.tag < '0006');
  writeFileSync(journalPath, JSON.stringify(journal));
  await migrateD1(db, before);

  await db.run(sql`INSERT INTO user (id, name, email) VALUES ('u1', 'Ada', 'a@example.com')`);
  await db.run(sql`INSERT INTO user (id, name, email) VALUES ('bot', 'Bot', 'bot@example.com')`);
  await db.run(sql`INSERT INTO workspace (name) VALUES ('Acme')`);
  await db.run(sql`INSERT INTO team (workspace_id, name) VALUES (1, 'Core')`);
  await db.run(sql`INSERT INTO project (team_id, key, name) VALUES (1, 'MKT', 'Marketing')`);
  await db.run(sql`INSERT INTO project_column (project_id, name, position) VALUES (1, 'Todo', 0)`);
  await db.run(
    sql`INSERT INTO issue (project_id, sequence_number, column_id, title, delegate_user_id)
        VALUES (1, 1, 1, 'Keep me', 'bot')`,
  );
  await db.run(
    sql`INSERT INTO ai_agent (team_id, user_id, username, kind) VALUES (1, 'bot', 'bot', 'external')`,
  );

  await migrateD1(db);
});

afterAll(async () => {
  await mf.dispose();
});

describe('0006_remove_ai on existing data', () => {
  it('drops the AI tables and their triggers', async () => {
    const names = await db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE substr(name, 1, 3) = 'ai_' OR substr(name, 1, 6) = 'agent_' OR name IN ('model_price', 'chat_attachment', 'issue_import', 'integration_credential')`,
    );
    expect(names).toEqual([]);
  });

  it('keeps the non-AI rows and clears the delegate', async () => {
    expect(await count('issue')).toBe(1);
    expect(await count('project')).toBe(1);
    const [row] = await db.all<{ delegate_user_id: string | null }>(
      sql`SELECT delegate_user_id FROM issue`,
    );
    expect(row!.delegate_user_id).toBeNull();
  });

  it('leaves no foreign key violation', async () => {
    expect(await db.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
  });

  it('dropped the AI columns', async () => {
    const team = await db.all<{ name: string }>(sql`PRAGMA table_info(team)`);
    expect(team.map((c) => c.name)).not.toContain('default_agent_ids');
    const pref = await db.all<{ name: string }>(sql`PRAGMA table_info(user_preference)`);
    expect(pref.map((c) => c.name)).not.toContain('show_chat_by_default');
  });
});
