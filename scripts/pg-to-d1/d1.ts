import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { TargetColumn, TargetTable } from './plan.ts';
import { quoteIdent, sqlLiteral } from './sql.ts';
import type { D1Value } from './transform.ts';

export interface D1Target {
  /** true : base distante. Réservé aux lots validés : --remote et PG_TO_D1_ALLOW_REMOTE=1. */
  remote: boolean;
  /** Nom du binding D1 dans la configuration wrangler (DB). */
  database: string;
  /** Chemin absolu du wrangler.jsonc. */
  config: string;
  /** Dossier de persistance de la base locale (local uniquement). */
  persistTo?: string;
  /** Dossier où écrire les fichiers SQL temporaires de requêtes. */
  workDir: string;
  /** Chemin absolu de bin/wrangler.js. */
  wranglerBin: string;
  /** Variables d'environnement à ne pas transmettre à wrangler (ex. l'URL Postgres). */
  hiddenEnv: string[];
}

export interface WranglerResult {
  results: Record<string, unknown>[];
  success: boolean;
}

/** wrangler est une dépendance de packages/db : on le résout depuis là, pas depuis la racine. */
export function resolveWranglerBin(repoRoot: string): string {
  const require = createRequire(join(repoRoot, 'packages', 'db', 'package.json'));
  return join(dirname(require.resolve('wrangler/package.json')), 'bin', 'wrangler.js');
}

function runNode(
  t: D1Target,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    WRANGLER_SEND_METRICS: 'false',
  };
  for (const k of t.hiddenEnv) delete env[k];
  return new Promise((resolve, reject) => {
    const child = spawn('node', [t.wranglerBin, ...args], { env, windowsHide: true });
    // Décodage après concaténation : un caractère UTF-8 peut être coupé entre deux paquets.
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      }),
    );
  });
}

function tail(s: string): string {
  return s.trim().split('\n').slice(-8).join('\n');
}

/** Exécute un fichier SQL sur D1 et renvoie un résultat par instruction. Lève une erreur au moindre échec. */
export async function runSqlFile(t: D1Target, file: string): Promise<WranglerResult[]> {
  if (t.remote && process.env.PG_TO_D1_ALLOW_REMOTE !== '1') {
    throw new Error(
      'écriture distante refusée : définir PG_TO_D1_ALLOW_REMOTE=1 et passer --remote',
    );
  }
  const args = [
    'd1',
    'execute',
    t.database,
    t.remote ? '--remote' : '--local',
    '--config',
    t.config,
    '--json',
    '--file',
    file,
  ];
  if (!t.remote && t.persistTo) args.push('--persist-to', t.persistTo);
  const { code, stdout, stderr } = await runNode(t, args);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`wrangler : sortie illisible (code ${code})\n${tail(stderr || stdout)}`);
  }
  if (!Array.isArray(parsed)) {
    const text =
      (parsed as { error?: { text?: string } })?.error?.text ??
      JSON.stringify(parsed).slice(0, 500);
    throw new Error(`wrangler : ${text}`);
  }
  const results = parsed as WranglerResult[];
  const failed = results.find((r) => r.success === false);
  if (code !== 0 || failed)
    throw new Error(`wrangler : échec (code ${code})\n${tail(stderr || stdout)}`);
  return results;
}

/** Écrit les instructions dans un fichier temporaire du dossier de travail puis les exécute. */
export async function runStatements(
  t: D1Target,
  statements: string[],
  label: string,
): Promise<WranglerResult[]> {
  const dir = join(t.workDir, 'queries');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${label}.sql`);
  await writeFile(file, `${statements.join('\n')}\n`, 'utf8');
  return runSqlFile(t, file);
}

const literalName = (name: string): string => `'${name.replaceAll("'", "''")}'`;

/**
 * Schéma de la cible : tables, colonnes et clés étrangères. Les tables pragma sont lues par nom
 * littéral : la forme corrélée (pragma_table_info(m.name)) est refusée par l'autorisation de D1.
 */
export async function readTargetTables(t: D1Target): Promise<TargetTable[]> {
  const listing = await runStatements(
    t,
    [`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;`],
    'tables',
  );
  const names = (listing[0]?.results ?? [])
    .map((r) => String(r.name))
    .filter((n) => !n.startsWith('sqlite_') && !n.startsWith('_cf_') && !n.startsWith('d1_'));
  const statements: string[] = [];
  for (const n of names) {
    statements.push(`SELECT * FROM pragma_table_info(${literalName(n)});`);
    statements.push(`SELECT * FROM pragma_foreign_key_list(${literalName(n)});`);
  }
  const results = names.length === 0 ? [] : await runStatements(t, statements, 'schema');
  return names.map((name, i) => {
    const cols = (results[2 * i]?.results ?? []) as Record<string, unknown>[];
    const fks = (results[2 * i + 1]?.results ?? []) as Record<string, unknown>[];
    const columns: TargetColumn[] = cols.map((c) => ({
      name: String(c.name),
      type: String(c.type ?? ''),
      notNull: Number(c.notnull) === 1,
      hasDefault: c.dflt_value !== null && c.dflt_value !== undefined,
      pkPosition: Number(c.pk ?? 0),
    }));
    return {
      name,
      columns,
      foreignKeys: fks.map((f) => ({ column: String(f.from), parent: String(f.table) })),
    };
  });
}

/** Nombre de lignes de chaque table cible, en une seule invocation. */
export async function countTargetRows(t: D1Target, tables: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (tables.length === 0) return out;
  const statements = tables.map((n) => `SELECT COUNT(*) AS n FROM ${quoteIdent(n)};`);
  const results = await runStatements(t, statements, 'counts');
  tables.forEach((n, i) => out.set(n, Number(results[i]?.results[0]?.n ?? NaN)));
  return out;
}

export interface SampleRequest {
  table: string;
  columns: string[];
  pk: string[];
  keys: D1Value[][];
}

/** Lignes cibles par clé primaire, pour la comparaison d'échantillon. */
export async function fetchSampleRows(
  t: D1Target,
  requests: SampleRequest[],
): Promise<Record<string, unknown>[][]> {
  const active = requests.filter((r) => r.keys.length > 0);
  if (active.length === 0) return requests.map(() => []);
  const statements = active.map((r) => {
    const cols = r.columns.map(quoteIdent).join(', ');
    const pk = r.pk.map(quoteIdent).join(', ');
    const values = r.keys.map((k) => `(${k.map(sqlLiteral).join(', ')})`).join(', ');
    return `SELECT ${cols} FROM ${quoteIdent(r.table)} WHERE (${pk}) IN (VALUES ${values});`;
  });
  const results = await runStatements(t, statements, 'samples');
  const byTable = new Map<string, Record<string, unknown>[]>();
  active.forEach((r, i) =>
    byTable.set(r.table, (results[i]?.results ?? []) as Record<string, unknown>[]),
  );
  return requests.map((r) => byTable.get(r.table) ?? []);
}
