import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SqlFile } from './sql.ts';
import type { D1Value } from './transform.ts';

export const MANIFEST = 'manifest.json';
export const CHECKPOINT = 'checkpoint.json';
export const REPORT = 'report.json';

export interface ManifestSample {
  key: D1Value[];
  sha256: string;
}

export interface ManifestTable {
  name: string;
  columns: string[];
  pk: string[];
  sourceRows: number;
  /** Lignes écartées (au-delà de 2 Mo) : listées dans `skipped`, jamais écrites. */
  skippedRows: number;
  expectedRows: number;
  samples: ManifestSample[];
}

export interface SkippedRow {
  table: string;
  key: D1Value[];
  bytes: number;
  /** Gros textes écrits à part (blobs/), à déposer dans R2 si la décision est de les conserver. */
  blobs: { column: string; bytes: number; file: string }[];
}

export interface Manifest {
  version: 1;
  createdAt: string;
  source: { database: string };
  target: { database: string; remote: boolean };
  files: SqlFile[];
  tables: ManifestTable[];
  ignoredSourceTables: string[];
  absentFromSource: string[];
  droppedColumns: Record<string, string[]>;
  skipped: SkippedRow[];
}

export interface Checkpoint {
  files: Record<string, { status: 'started' | 'done'; at: string }>;
}

export async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Écriture atomique : un fichier partiel ne remplace jamais un état valide. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
}

export async function loadManifest(workDir: string): Promise<Manifest> {
  const m = await readJsonFile<Manifest>(join(workDir, MANIFEST));
  if (!m) throw new Error(`manifest absent dans ${workDir} : lancer d'abord l'extraction`);
  if (m.version !== 1) throw new Error(`version de manifest inconnue : ${String(m.version)}`);
  return m;
}
