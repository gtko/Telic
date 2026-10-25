import { execFileSync } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { type D1Target, readTargetTables, resolveWranglerBin, runSqlFile } from './d1.ts';
import { apply, run, validate } from './pipeline.ts';
import { buildPlan, orderTables, type SourceTable, type TargetTable } from './plan.ts';
import { keyOf, Reservoir, rowSha256 } from './sample.ts';
import {
  CHUNK_BYTES,
  InsertBatcher,
  SqlFileWriter,
  appendStatement,
  deferredStatements,
  insertStatement,
  prepareRow,
  quoteIdent,
  splitCodePoints,
  sqlLiteral,
} from './sql.ts';
import { CHECKPOINT, MANIFEST, type Manifest, readJsonFile } from './state.ts';
import {
  MAX_ROW_BYTES,
  pgKind,
  selectExpr,
  toD1Value,
  utf8Length,
  valueBytes,
} from './transform.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const fixtures = join(here, 'fixtures');
// Les tests d'intégration lancent wrangler (quelques secondes par appel).
setDefaultTimeout(240_000);

describe('transform : mapping des types', () => {
  test('pgKind couvre les types de la source et refuse le reste', () => {
    expect(pgKind('timestamp with time zone', 'timestamptz')).toBe('ts');
    expect(pgKind('timestamp without time zone', 'timestamp')).toBe('ts');
    expect(pgKind('date', 'date')).toBe('date');
    expect(pgKind('jsonb', 'jsonb')).toBe('json');
    expect(pgKind('ARRAY', '_text')).toBe('array');
    expect(pgKind('boolean', 'bool')).toBe('bool');
    expect(pgKind('bigint', 'int8')).toBe('int');
    expect(pgKind('numeric', 'numeric')).toBe('real');
    expect(pgKind('uuid', 'uuid')).toBe('text');
    expect(() => pgKind('bytea', 'bytea')).toThrow('type Postgres non géré');
    expect(() => pgKind('USER-DEFINED', 'tsvector')).toThrow('non géré');
  });

  test('toD1Value : epoch ms, booléens 0/1, JSON compact, réel fini, entier sûr', () => {
    expect(toD1Value('ts', '1714557600123', 'x')).toBe(1714557600123);
    expect(toD1Value('bool', 1, 'x')).toBe(1);
    expect(toD1Value('bool', 0, 'x')).toBe(0);
    expect(() => toD1Value('bool', 2, 'x')).toThrow('booléen');
    expect(toD1Value('json', '{"a": [1, 2], "b": {"c": "é"}}', 'x')).toBe(
      '{"a":[1,2],"b":{"c":"é"}}',
    );
    expect(toD1Value('array', '["x",null]', 'x')).toBe('["x",null]');
    expect(toD1Value('date', '2024-02-29', 'x')).toBe('2024-02-29');
    expect(() => toD1Value('date', '29/02/2024', 'x')).toThrow('date ISO');
    expect(toD1Value('real', '12.5', 'x')).toBe(12.5);
    expect(() => toD1Value('real', NaN, 'x')).toThrow('réel fini');
    expect(() => toD1Value('int', '9007199254740993', 'x')).toThrow('entier sûr');
    expect(toD1Value('int', '42', 'x')).toBe(42);
    expect(toD1Value('text', null, 'x')).toBeNull();
    expect(() => toD1Value('text', 'a\u0000b', 'x')).toThrow('NUL');
  });

  test('selectExpr : les conversions restent dans la requête Postgres', () => {
    expect(selectExpr('ts', 'created_at')).toContain('EXTRACT(EPOCH FROM "created_at")');
    expect(selectExpr('array', 'tags')).toContain('array_to_json("tags")');
    expect(selectExpr('bool', 'done')).toContain('CASE WHEN "done" THEN 1');
  });

  test("valueBytes et utf8Length comptent l'UTF-8", () => {
    expect(utf8Length('aé€😀')).toBe(1 + 2 + 3 + 4);
    expect(valueBytes(null)).toBe(0);
    expect(valueBytes(5)).toBe(8);
    expect(valueBytes('€')).toBe(3);
  });
});

describe('sql : littéraux et instructions', () => {
  test('sqlLiteral double les apostrophes et refuse NUL et non-fini', () => {
    expect(sqlLiteral("it's")).toBe("'it''s'");
    expect(sqlLiteral(null)).toBe('NULL');
    expect(sqlLiteral(-0)).toBe('0');
    expect(sqlLiteral(1.5)).toBe('1.5');
    expect(() => sqlLiteral('a\u0000')).toThrow('NUL');
    expect(() => sqlLiteral(Infinity)).toThrow('non finie');
  });

  test('quoteIdent refuse les identifiants hors [A-Za-z_][A-Za-z0-9_]*', () => {
    expect(quoteIdent('issue_link')).toBe('"issue_link"');
    expect(() => quoteIdent('a"b')).toThrow('identifiant refusé');
  });

  test('INSERT rejouable : NOT EXISTS sur la clé primaire', () => {
    const sql = insertStatement({ table: 'team', columns: ['id', 'name'], pk: ['id'] }, [
      [1, 'a'],
      [2, "b'c"],
    ]);
    expect(sql).toContain(
      'WHERE NOT EXISTS (SELECT 1 FROM "team" AS "__t" WHERE "__t"."id" = "__src"."id")',
    );
    expect(sql).toContain("(2, 'b''c')");
  });

  test('chunks : aucun caractère coupé, morceaux bornés, concaténation exacte', () => {
    const text = 'ab€😀'.repeat(50);
    const chunks = splitCodePoints(text, 20);
    expect(chunks.join('')).toBe(text);
    for (const c of chunks) expect(utf8Length(c)).toBeLessThanOrEqual(20);
    expect(splitCodePoints('', 10)).toEqual([]);
  });

  test('prepareRow vide les gros textes et reconstruit la valeur par UPDATE bornés', () => {
    const big = 'é'.repeat(300_000); // 600 Ko : au-delà du budget d'une instruction
    const prepared = prepareRow([1, big, 'small'], [0], 100_000);
    expect(prepared.values[1]).toBe('');
    expect(prepared.values[0]).toBe(1);
    expect(prepared.appends).toHaveLength(1);
    const app = prepared.appends[0]!;
    expect(app.chunks.join('')).toBe(big);
    expect(app.offsets[0]).toBe(0);
    expect(app.offsets[1]).toBe([...app.chunks[0]!].length);
    expect(prepared.bytes).toBeLessThanOrEqual(50_000 + 20);
    for (const c of app.chunks) expect(utf8Length(c)).toBeLessThanOrEqual(CHUNK_BYTES);
  });

  test('appendStatement est gardé par length() pour être rejouable', () => {
    const sql = appendStatement(
      { table: 'doc', columns: ['id', 'body'], pk: ['id'] },
      ['d1'],
      'body',
      'xy',
      4,
    );
    expect(sql).toBe(
      `UPDATE "doc" SET "body" = "body" || 'xy' WHERE "id" = 'd1' AND length("body") = 4;`,
    );
  });

  test('InsertBatcher : au plus MAX_PARAMS / colonnes lignes, chaque instruction sous la borne', async () => {
    const cols = Array.from({ length: 30 }, (_, i) => `c${i}`);
    const groups: { statements: string[]; rows: number }[] = [];
    const batcher = new InsertBatcher(
      { table: 'wide', columns: cols, pk: ['c0'] },
      100_000,
      async (statements, rows) => {
        groups.push({ statements, rows });
      },
    );
    for (let i = 0; i < 25; i++) {
      await batcher.add(
        prepareRow(
          cols.map((_, j) => (j === 0 ? i : `v${i}-${j}`)),
          batcher.indexes,
          100_000,
        ),
      );
    }
    await batcher.flush();
    const total = groups.reduce((n, g) => n + g.rows, 0);
    expect(total).toBe(25);
    for (const g of groups) {
      expect(g.rows).toBeLessThanOrEqual(Math.floor(100 / 30));
      for (const s of g.statements) expect(utf8Length(s)).toBeLessThanOrEqual(100_000);
    }
  });

  test('deferredStatements : une clé étrangère par ligne, regroupées', () => {
    const entries = Array.from({ length: 60 }, (_, i) => ({ pk: [i + 2], value: 1 }));
    const stmts = deferredStatements(
      { table: 'issue', columns: ['id', 'parent_id'], pk: ['id'] },
      'parent_id',
      entries,
      100_000,
    );
    expect(stmts.length).toBe(Math.ceil(60 / Math.floor(100 / 2)));
    expect(stmts[0]).toContain('UPDATE "issue" SET "parent_id" = (SELECT "__src"."parent_id"');
  });

  test('SqlFileWriter : rotation par taille, empreinte du contenu écrit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pgd1-writer-'));
    try {
      const writer = new SqlFileWriter(dir, 200);
      for (let i = 0; i < 10; i++)
        await writer.addGroup([`SELECT '${'x'.repeat(60)}${i}';`], 1, 't');
      const files = await writer.finish();
      expect(files.length).toBeGreaterThan(1);
      expect(files.reduce((n, f) => n + f.rows, 0)).toBe(10);
      const { createHash } = await import('node:crypto');
      for (const f of files) {
        const content = readFileSync(join(dir, f.name), 'utf8');
        expect(createHash('sha256').update(content).digest('hex')).toBe(f.sha256);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('plan : ordre des tables et croisement des schémas', () => {
  const t = (name: string, fks: [string, string][] = [], cols: string[] = ['id']): TargetTable => ({
    name,
    columns: cols.map((c, i) => ({
      name: c,
      type: 'text',
      notNull: i === 0,
      hasDefault: false,
      pkPosition: i === 0 ? 1 : 0,
    })),
    foreignKeys: fks.map(([column, parent]) => ({ column, parent })),
  });

  test('orderTables : parents avant enfants, auto-références ignorées, tables isolées incluses', () => {
    const order = orderTables([
      t('issue', [
        ['parent_id', 'issue'],
        ['team_id', 'team'],
      ]),
      t('team'),
      t('lonely'),
      t('member', [['team_id', 'team']]),
    ]);
    expect(order.length).toBe(4);
    expect(order.indexOf('team')).toBeLessThan(order.indexOf('issue'));
    expect(order.indexOf('team')).toBeLessThan(order.indexOf('member'));
    expect(order).toContain('lonely');
  });

  test('orderTables : cycle entre tables détecté', () => {
    expect(() => orderTables([t('a', [['b_id', 'b']]), t('b', [['a_id', 'a']])])).toThrow(
      'cycle de clés étrangères',
    );
  });

  test('buildPlan : colonnes écartées, tables ignorées et absentes, auto-référence repérée', () => {
    const target: TargetTable[] = [
      {
        name: 'issue',
        columns: [
          { name: 'id', type: 'integer', notNull: true, hasDefault: false, pkPosition: 1 },
          { name: 'parent_id', type: 'integer', notNull: false, hasDefault: false, pkPosition: 0 },
          { name: 'title', type: 'text', notNull: true, hasDefault: false, pkPosition: 0 },
        ],
        foreignKeys: [{ column: 'parent_id', parent: 'issue' }],
      },
      {
        name: 'empty',
        columns: [{ name: 'id', type: 'integer', notNull: true, hasDefault: false, pkPosition: 1 }],
        foreignKeys: [],
      },
    ];
    const source: SourceTable[] = [
      {
        name: 'issue',
        pk: ['id'],
        columns: [
          { name: 'id', dataType: 'bigint', udt: 'int8' },
          { name: 'parent_id', dataType: 'bigint', udt: 'int8' },
          { name: 'title', dataType: 'text', udt: 'text' },
          { name: 'search', dataType: 'tsvector', udt: 'tsvector' },
        ],
      },
      { name: 'legacy', pk: ['id'], columns: [{ name: 'id', dataType: 'integer', udt: 'int4' }] },
    ];
    const plan = buildPlan(target, source);
    const issue = plan.tables.get('issue')!;
    expect(issue.selfColumns).toEqual(['parent_id']);
    expect(issue.droppedColumns).toEqual(['search']);
    expect(issue.columns.map((c) => c.name)).toEqual(['id', 'parent_id', 'title']);
    expect(plan.ignoredSourceTables).toEqual(['legacy']);
    expect(plan.absentFromSource).toEqual(['empty']);
  });

  test('buildPlan : colonne NOT NULL sans défaut absente de la source = erreur', () => {
    const target: TargetTable[] = [
      {
        name: 'x',
        columns: [
          { name: 'id', type: 'text', notNull: true, hasDefault: false, pkPosition: 1 },
          { name: 'token', type: 'text', notNull: true, hasDefault: false, pkPosition: 0 },
        ],
        foreignKeys: [],
      },
    ];
    const source: SourceTable[] = [
      { name: 'x', pk: ['id'], columns: [{ name: 'id', dataType: 'text', udt: 'text' }] },
    ];
    expect(() => buildPlan(target, source)).toThrow('NOT NULL sans défaut');
  });

  test('buildPlan : clé de pagination non entière ni texte = erreur', () => {
    const target: TargetTable[] = [
      {
        name: 'x',
        columns: [{ name: 'at', type: 'integer', notNull: true, hasDefault: false, pkPosition: 1 }],
        foreignKeys: [],
      },
    ];
    const source: SourceTable[] = [
      {
        name: 'x',
        pk: ['at'],
        columns: [{ name: 'at', dataType: 'timestamp with time zone', udt: 'timestamptz' }],
      },
    ];
    expect(() => buildPlan(target, source)).toThrow('clé de pagination');
  });

  test('Reservoir : taille k, déterministe pour un seed', () => {
    const a = new Reservoir<number>(5, 42);
    const b = new Reservoir<number>(5, 42);
    for (let i = 0; i < 100; i++) {
      a.offer(i);
      b.offer(i);
    }
    expect(a.sample()).toHaveLength(5);
    expect(a.sample()).toEqual(b.sample());
    expect(keyOf([1, 'a'])).toBe('[1,"a"]');
    expect(rowSha256([1, null])).toBe(rowSha256([1, null]));
    expect(MAX_ROW_BYTES).toBe(2_000_000);
  });
});

// ----- Intégration : Postgres en mémoire (PGlite, protocole réseau) + D1 local (wrangler) -----

const WRANGLER_ENV = { ...process.env, WRANGLER_SEND_METRICS: 'false' };
const wranglerBin = resolveWranglerBin(repoRoot);

function wrangler(args: string[]): string {
  return execFileSync('node', [wranglerBin, ...args], {
    env: WRANGLER_ENV,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function d1Target(base: string, over: Partial<D1Target> = {}): D1Target {
  return {
    remote: false,
    database: 'DB',
    config: join(fixtures, 'wrangler.jsonc'),
    persistTo: join(base, 'persist'),
    workDir: join(base, 'work'),
    wranglerBin,
    hiddenEnv: ['PG_SOURCE_URL'],
    ...over,
  };
}

const uuidOf = (i: number): string =>
  `${String(i + 1).padStart(8, '0')}-0000-4000-8000-000000000000`;
const sqlStr = (s: string): string => `'${s.replaceAll("'", "''")}'`;

/** Données source, en SQL Postgres : petites tables, lot de 250 lignes, gros textes. */
function pgData(): string {
  const parts: string[] = [];
  parts.push(`INSERT INTO team (id, name, created_at, settings, is_active, tags, starts_on, score, ref, legacy_blob, search_vector) VALUES
(1, 'O''Brien', '2024-05-01 10:00:00.123456+00', '{"a": [1, 2], "b": {"c": "é"}}', true, ARRAY['x','y with ''q''',NULL]::text[], '2024-02-29', 12.5, '11111111-1111-4111-8111-111111111111', '\\xdeadbeef', to_tsvector('simple','hello')),
(2, 'Two', '2024-05-02 00:00:00+00', '{}', false, NULL, NULL, NULL, '22222222-2222-4222-8222-222222222222', NULL, NULL),
(3, 'Three', '2024-12-31 23:59:59.999999+00', '[]', true, ARRAY[]::text[], '1999-01-01', 0, '33333333-3333-4333-8333-333333333333', NULL, NULL);`);
  const users = Array.from({ length: 250 }, (_, i) => {
    const naive = new Date(Date.UTC(2024, 0, 1) + i * 60_000)
      .toISOString()
      .slice(0, 19)
      .replace('T', ' ');
    return `('${uuidOf(i)}', 'user${i}@example.com', '${naive}', ${i % 3 === 0 ? "ARRAY['admin']::text[]" : 'ARRAY[]::text[]'}, ${2 ** 40 + i}, ${i % 2 ? i / 3 : 'NULL'})`;
  });
  parts.push(
    `INSERT INTO app_user (id, email, created_at, roles, big_counter, ratio) VALUES\n${users.join(',\n')};`,
  );
  const members = Array.from(
    { length: 40 },
    (_, i) =>
      `(${(i % 3) + 1}, '${uuidOf(i)}', '2024-03-${String((i % 28) + 1).padStart(2, '0')}')`,
  );
  parts.push(
    `INSERT INTO team_member (team_id, user_id, joined_on) VALUES\n${members.join(',\n')};`,
  );
  const issues = Array.from({ length: 120 }, (_, i) => {
    const id = 1000 + i;
    const parent = i < 10 ? 'NULL' : i === 1 ? 1050 : 1000 + (i - 10);
    const meta = i % 4 === 0 ? 'NULL' : sqlStr(`{"n": ${i}}`);
    return `(${id}, ${(i % 3) + 1}, ${parent}, ${sqlStr(`Issue ${i}`)}, ${sqlStr(`line one;\nline two 'quoted' -- not a comment ${i}`)}, ${i % 5 === 0 ? 'NULL' : i / 4}, ${i % 2 === 0}, ${meta})`;
  });
  parts.push(
    `INSERT INTO issue (id, team_id, parent_id, title, body, estimate, done, meta) VALUES\n${issues.join(',\n')};`,
  );
  parts.push(`INSERT INTO doc (id, body) VALUES
('small', ${sqlStr("é;\n-- x\n'q'")}),
('chunked', ${sqlStr('ab€😀'.repeat(40_000))}),
('huge', ${sqlStr('x'.repeat(2_100_000))});`);
  parts.push(`INSERT INTO pg_only_audit (note) VALUES ('a'), ('b');`);
  return parts.join('\n');
}

async function freePort(): Promise<number> {
  return new Promise((ok, ko) => {
    const srv = createServer();
    srv.once('error', ko);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => ok(port));
    });
  });
}

describe('intégration : copie complète Postgres -> D1 local', () => {
  const base = mkdtempSync(join(tmpdir(), 'pgd1-e2e-'));
  const target = d1Target(base);
  const workDir = target.workDir;
  let pg: PGlite;
  let server: PGLiteSocketServer;
  let sourceUrl = '';
  let manifest: Manifest;
  let validation: Awaited<ReturnType<typeof validate>>;

  const count = async (table: string): Promise<number> => {
    const dir = join(base, 'q');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `count-${table}.sql`);
    writeFileSync(file, `SELECT COUNT(*) AS n FROM ${quoteIdent(table)};\n`);
    const out = await runSqlFile(target, file);
    return Number(out[0]!.results[0]!.n);
  };
  const query = async (sql: string): Promise<Record<string, unknown>[]> => {
    const dir = join(base, 'q');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `q-${Math.random().toString(36).slice(2)}.sql`);
    writeFileSync(file, `${sql}\n`);
    return (await runSqlFile(target, file))[0]!.results;
  };

  beforeAll(async () => {
    pg = await PGlite.create();
    await pg.exec(readFileSync(join(fixtures, 'pg-schema.sql'), 'utf8'));
    await pg.exec(pgData());
    const port = await freePort();
    server = new PGLiteSocketServer({ db: pg, port, host: '127.0.0.1' });
    await server.start();
    sourceUrl = `postgres://postgres@127.0.0.1:${port}/postgres?sslmode=disable`;
    await runSqlFile(target, join(fixtures, 'd1-schema.sql'));
    validation = (
      await run({
        workDir,
        target,
        maxFileBytes: 60_000,
        maxStatementBytes: 100_000,
        sampleSize: 20,
        pageSize: 100,
        sourceLabel: 'pglite:test',
        sourceUrl,
        dryRun: false,
        resume: false,
      })
    ).validation!;
    manifest = (await readJsonFile<Manifest>(join(workDir, MANIFEST)))!;
  }, 300_000);

  afterAll(async () => {
    await server?.stop();
    await pg?.close();
    rmSync(base, { recursive: true, force: true });
  }, 60_000);

  test("la validation passe : comptes et empreintes d'échantillon", () => {
    const failing = validation.tables.filter((t) => !t.ok);
    expect(failing).toEqual([]);
    expect(validation.ok).toBe(true);
  });

  test('les comptes D1 suivent la source moins les lignes écartées', async () => {
    expect(await count('team')).toBe(3);
    expect(await count('app_user')).toBe(250);
    expect(await count('team_member')).toBe(40);
    expect(await count('issue')).toBe(120);
    expect(await count('doc')).toBe(2);
    expect(await count('audit_empty')).toBe(0);
  });

  test('la ligne de plus de 2 Mo est écartée, rapportée, et ses blobs écrits', () => {
    expect(manifest.skipped).toHaveLength(1);
    const skip = manifest.skipped[0]!;
    expect(skip.table).toBe('doc');
    expect(skip.key).toEqual(['huge']);
    expect(skip.bytes).toBeGreaterThan(MAX_ROW_BYTES);
    expect(skip.blobs).toHaveLength(1);
    expect(existsSync(join(workDir, 'blobs', ...skip.blobs[0]!.file.split('/')))).toBe(true);
    expect(manifest.tables.find((t) => t.name === 'doc')!.expectedRows).toBe(2);
  });

  test('le rapport signale les tables et colonnes non copiées', () => {
    expect(manifest.ignoredSourceTables).toEqual(['pg_only_audit']);
    expect(manifest.absentFromSource).toEqual(['audit_empty']);
    expect(manifest.droppedColumns.team).toEqual(['legacy_blob', 'search_vector']);
  });

  test('conversions : timestamps en ms, booléens 0/1, JSON, tableaux, dates, réels', async () => {
    const [t1] = await query(
      `SELECT created_at, settings, is_active, tags, starts_on, score, ref FROM team WHERE id = 1;`,
    );
    expect(t1!.created_at).toBe(Date.parse('2024-05-01T10:00:00.123Z'));
    expect(JSON.parse(String(t1!.settings))).toEqual({ a: [1, 2], b: { c: 'é' } });
    expect(t1!.is_active).toBe(1);
    expect(JSON.parse(String(t1!.tags))).toEqual(['x', "y with 'q'", null]);
    expect(t1!.starts_on).toBe('2024-02-29');
    expect(t1!.score).toBe(12.5);
    const [t2] = await query(`SELECT is_active, tags, starts_on, score FROM team WHERE id = 2;`);
    expect(t2!.is_active).toBe(0);
    expect(t2!.tags).toBeNull();
    expect(t2!.score).toBeNull();
    const [u5] = await query(
      `SELECT created_at, roles, big_counter, ratio FROM app_user WHERE id = '${uuidOf(5)}';`,
    );
    expect(u5!.created_at).toBe(Date.UTC(2024, 0, 1) + 5 * 60_000);
    expect(u5!.roles).toBe('[]');
    expect(u5!.big_counter).toBe(2 ** 40 + 5);
    expect(u5!.ratio).toBeCloseTo(5 / 3, 12);
  });

  test('auto-référence : chaque parent est posé, y compris le lien en avant (1001 -> 1050)', async () => {
    const rows = await query(`SELECT id, parent_id FROM issue ORDER BY id;`);
    const expected = Array.from({ length: 120 }, (_, i) => ({
      id: 1000 + i,
      parent_id: i < 10 ? null : i === 1 ? 1050 : 1000 + (i - 10),
    }));
    expect(rows).toEqual(expected);
  });

  test("le gros texte découpé en UPDATE revient à l'identique (160 000 caractères)", async () => {
    const [d] = await query(`SELECT length(body) AS n, body FROM doc WHERE id = 'chunked';`);
    expect(d!.n).toBe(160_000);
    expect(d!.body).toBe('ab€😀'.repeat(40_000));
    const [s] = await query(`SELECT body FROM doc WHERE id = 'small';`);
    expect(s!.body).toBe("é;\n-- x\n'q'");
  });

  test('plusieurs fichiers SQL, tous appliqués et marqués faits', async () => {
    expect(manifest.files.length).toBeGreaterThan(1);
    const cp = await readJsonFile<{ files: Record<string, { status: string }> }>(
      join(workDir, CHECKPOINT),
    );
    for (const f of manifest.files) expect(cp!.files[f.name]!.status).toBe('done');
  });

  test('reprise : rejouer des fichiers déjà appliqués ne duplique rien', async () => {
    const cpPath = join(workDir, CHECKPOINT);
    const cp = (await readJsonFile<{ files: Record<string, unknown> }>(cpPath))!;
    // Scénario de crash après le premier fichier : le reste est rejoué alors qu'il est déjà en cible.
    for (const f of manifest.files.slice(1)) delete cp.files[f.name];
    writeFileSync(cpPath, JSON.stringify(cp));
    await apply({
      workDir,
      target,
      maxFileBytes: 0,
      maxStatementBytes: 100_000,
      sampleSize: 0,
      pageSize: 1,
      sourceLabel: '',
      log: () => {},
    });
    expect(await count('issue')).toBe(120);
    expect(await count('app_user')).toBe(250);
    const [d] = await query(`SELECT length(body) AS n FROM doc WHERE id = 'chunked';`);
    expect(d!.n).toBe(160_000);
    const again = await validate({
      workDir,
      target,
      maxFileBytes: 0,
      maxStatementBytes: 100_000,
      sampleSize: 0,
      pageSize: 1,
      sourceLabel: '',
    });
    expect(again.ok).toBe(true);
  });

  test("refus : une cible non vide n'accepte pas un nouvel import", async () => {
    const fresh = join(base, 'fresh-work');
    await run({
      workDir: fresh,
      target,
      maxFileBytes: 60_000,
      maxStatementBytes: 100_000,
      sampleSize: 5,
      pageSize: 100,
      sourceLabel: 'pglite:test',
      sourceUrl,
      dryRun: true,
      resume: false,
    });
    expect(existsSync(join(fresh, CHECKPOINT))).toBe(false);
    await expect(
      apply({
        workDir: fresh,
        target,
        maxFileBytes: 0,
        maxStatementBytes: 100_000,
        sampleSize: 0,
        pageSize: 1,
        sourceLabel: '',
      }),
    ).rejects.toThrow('cible non vide');
  });

  test('la vérification détecte une ligne retirée de la cible', async () => {
    const file = join(base, 'q', 'delete-member.sql');
    mkdirSync(join(base, 'q'), { recursive: true });
    writeFileSync(
      file,
      `DELETE FROM team_member WHERE team_id = 1 AND user_id = '${uuidOf(0)}';\n`,
    );
    await runSqlFile(target, file);
    const v = await validate({
      workDir,
      target,
      maxFileBytes: 0,
      maxStatementBytes: 100_000,
      sampleSize: 20,
      pageSize: 1,
      sourceLabel: '',
    });
    expect(v.ok).toBe(false);
    const member = v.tables.find((t) => t.name === 'team_member')!;
    expect(member.countOk).toBe(false);
    expect(member.targetRows).toBe(39);
  });
});

describe('intégration : schéma réel de packages/db', () => {
  const base = mkdtempSync(join(tmpdir(), 'pgd1-real-'));
  const dbConfig = join(repoRoot, 'packages', 'db', 'wrangler.jsonc');
  let tables: TargetTable[];

  beforeAll(async () => {
    const target = d1Target(base, { config: dbConfig });
    wrangler([
      'd1',
      'migrations',
      'apply',
      'DB',
      '--local',
      '--config',
      dbConfig,
      '--persist-to',
      target.persistTo!,
    ]);
    tables = await readTargetTables(target);
  }, 300_000);

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test('88 tables lues, ordre sans cycle, parents avant enfants pour toute clé étrangère', () => {
    expect(tables).toHaveLength(88);
    const order = orderTables(tables);
    expect(order).toHaveLength(88);
    const pos = new Map(order.map((n, i) => [n, i]));
    for (const t of tables) {
      for (const fk of t.foreignKeys) {
        if (fk.parent === t.name) continue;
        expect(pos.get(fk.parent)!).toBeLessThan(pos.get(t.name)!);
      }
    }
  });

  test('les auto-références sont exactement les cinq colonnes attendues', () => {
    const self = tables
      .flatMap((t) =>
        t.foreignKeys.filter((fk) => fk.parent === t.name).map((fk) => `${t.name}.${fk.column}`),
      )
      .sort();
    expect(self).toEqual([
      'document_comment.parent_id',
      'issue.parent_id',
      'issue_activity.reply_to_id',
      'project_document.archived_by_ancestor_id',
      'project_document.parent_id',
    ]);
  });
});

describe("contrat d'exécution", () => {
  test('--remote est refusé sans PG_TO_D1_ALLOW_REMOTE=1', async () => {
    const saved = process.env.PG_TO_D1_ALLOW_REMOTE;
    delete process.env.PG_TO_D1_ALLOW_REMOTE;
    try {
      await expect(
        runSqlFile({ ...d1Target(tmpdir()), remote: true }, join(fixtures, 'd1-schema.sql')),
      ).rejects.toThrow('écriture distante refusée');
    } finally {
      if (saved !== undefined) process.env.PG_TO_D1_ALLOW_REMOTE = saved;
    }
  });
});
