import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  countTargetRows,
  fetchSampleRows,
  readTargetTables,
  runSqlFile,
  type D1Target,
} from './d1.ts';
import { type TablePlan, buildPlan } from './plan.ts';
import { type PgReader, withPgSnapshot } from './pg-source.ts';
import { fnv1a, keyOf, Reservoir, rowSha256 } from './sample.ts';
import {
  InsertBatcher,
  SqlFileWriter,
  type TableSpec,
  deferredStatements,
  prepareRow,
} from './sql.ts';
import {
  CHECKPOINT,
  MANIFEST,
  REPORT,
  type Checkpoint,
  type Manifest,
  type ManifestTable,
  type SkippedRow,
  loadManifest,
  readJsonFile,
  writeJsonAtomic,
} from './state.ts';
import {
  MAX_ROW_BYTES,
  type D1Value,
  selectExpr,
  toD1Value,
  utf8Length,
  valueBytes,
} from './transform.ts';

export interface Options {
  workDir: string;
  target: D1Target;
  maxFileBytes: number;
  maxStatementBytes: number;
  sampleSize: number;
  pageSize: number;
  /** Hôte et base, sans identifiants : seul libellé de la source écrit dans le manifest. */
  sourceLabel: string;
  log?: (line: string) => void;
}

/** Gros textes écrits à part quand une ligne est écartée. */
const BLOB_MIN_BYTES = 100_000;

const now = (): string => new Date().toISOString();
const sha256 = (content: string): string => createHash('sha256').update(content).digest('hex');

interface CopyResult {
  table: ManifestTable;
  skipped: SkippedRow[];
}

/** Étape 1 : lit la source dans un instantané, transforme, écrit les fichiers SQL et le manifest. */
export async function extract(o: Options & { sourceUrl: string }): Promise<Manifest> {
  const log = o.log ?? (() => {});
  await mkdir(o.workDir, { recursive: true });
  if ((await readdir(o.workDir)).length > 0) {
    throw new Error(
      `dossier de travail non vide : ${o.workDir}. Reprendre avec --resume, ou choisir un autre --work-dir.`,
    );
  }
  const blobsDir = join(o.workDir, 'blobs');
  await mkdir(join(o.workDir, 'sql'), { recursive: true });
  await mkdir(blobsDir, { recursive: true });
  const targetTables = await readTargetTables(o.target);
  if (targetTables.length === 0) throw new Error('cible sans table : migrations non appliquées ?');
  return withPgSnapshot(o.sourceUrl, async (pg) => {
    const source = await pg.tables();
    const plan = buildPlan(targetTables, source);
    const writer = new SqlFileWriter(join(o.workDir, 'sql'), o.maxFileBytes);
    const tables: ManifestTable[] = [];
    const skipped: SkippedRow[] = [];
    const seq = { n: 0 };
    for (const name of plan.order) {
      const tp = plan.tables.get(name);
      if (!tp) {
        tables.push({
          name,
          columns: [],
          pk: [],
          sourceRows: 0,
          skippedRows: 0,
          expectedRows: 0,
          samples: [],
        });
        continue;
      }
      const result = await copyTable(pg, tp, o, writer, blobsDir, seq);
      tables.push(result.table);
      skipped.push(...result.skipped);
      log(`${name} : ${result.table.sourceRows} lignes lues, ${result.table.skippedRows} écartées`);
    }
    const files = await writer.finish();
    const manifest: Manifest = {
      version: 1,
      createdAt: now(),
      source: { database: o.sourceLabel },
      target: { database: o.target.database, remote: o.target.remote },
      files,
      tables,
      ignoredSourceTables: plan.ignoredSourceTables,
      absentFromSource: plan.absentFromSource,
      droppedColumns: Object.fromEntries(
        [...plan.tables]
          .filter(([, t]) => t.droppedColumns.length > 0)
          .map(([n, t]) => [n, t.droppedColumns]),
      ),
      skipped,
    };
    await writeJsonAtomic(join(o.workDir, MANIFEST), manifest);
    return manifest;
  });
}

async function copyTable(
  pg: PgReader,
  tp: TablePlan,
  o: Options,
  writer: SqlFileWriter,
  blobsDir: string,
  seq: { n: number },
): Promise<CopyResult> {
  const spec: TableSpec = { table: tp.name, columns: tp.columns.map((c) => c.name), pk: tp.pk };
  const select = tp.columns.map((c) => ({ name: c.name, expr: selectExpr(c.kind, c.name) }));
  const batcher = new InsertBatcher(spec, o.maxStatementBytes, (stmts, rows) =>
    writer.addGroup(stmts, rows, tp.name),
  );
  const pkIdx = batcher.indexes;
  // Auto-références : insérées à NULL, puis fixées une fois toutes les lignes présentes.
  const selfIdx = tp.selfColumns.map((c) => spec.columns.indexOf(c));
  const deferred = new Map<number, { pk: D1Value[]; value: D1Value }[]>(
    selfIdx.map((i) => [i, []]),
  );
  const reservoir = new Reservoir<D1Value[]>(o.sampleSize, fnv1a(tp.name));
  const skipped: SkippedRow[] = [];
  let sourceRows = 0;

  for await (const raw of pg.rows(tp.name, select, tp.sourcePk, o.pageSize)) {
    sourceRows++;
    const full = tp.columns.map((c) => toD1Value(c.kind, raw[c.name], `${tp.name}.${c.name}`));
    const pk = pkIdx.map((i) => full[i] ?? null);
    const bytes = full.reduce<number>((n, v) => n + valueBytes(v), 0);
    if (bytes > MAX_ROW_BYTES) {
      skipped.push(await skipRow(tp.name, spec.columns, full, pk, bytes, blobsDir, seq));
      continue;
    }
    reservoir.offer(full);
    const ins = [...full];
    for (const i of selfIdx) {
      const v = ins[i] ?? null;
      if (v !== null) {
        deferred.get(i)!.push({ pk, value: v });
        ins[i] = null;
      }
    }
    await batcher.add(prepareRow(ins, pkIdx, o.maxStatementBytes));
  }
  await batcher.flush();
  for (const i of selfIdx) {
    for (const stmt of deferredStatements(
      spec,
      spec.columns[i]!,
      deferred.get(i)!,
      o.maxStatementBytes,
    )) {
      await writer.addGroup([stmt], 0, tp.name);
    }
  }

  const counted = await pg.count(tp.name);
  if (counted !== sourceRows)
    throw new Error(`${tp.name} : ${sourceRows} lignes lues, ${counted} annoncées par count(*)`);
  return {
    table: {
      name: tp.name,
      columns: spec.columns,
      pk: tp.pk,
      sourceRows,
      skippedRows: skipped.length,
      expectedRows: sourceRows - skipped.length,
      samples: reservoir
        .sample()
        .map((full) => ({ key: pkIdx.map((i) => full[i] ?? null), sha256: rowSha256(full) })),
    },
    skipped,
  };
}

/** Ligne au-delà de 2 Mo : jamais écrite. Ses gros textes partent dans blobs/ pour un dépôt R2 éventuel. */
async function skipRow(
  table: string,
  columns: string[],
  full: D1Value[],
  pk: D1Value[],
  bytes: number,
  blobsDir: string,
  seq: { n: number },
): Promise<SkippedRow> {
  const blobs: SkippedRow['blobs'] = [];
  await mkdir(join(blobsDir, table), { recursive: true });
  for (let i = 0; i < full.length; i++) {
    const v = full[i];
    if (typeof v !== 'string' || utf8Length(v) < BLOB_MIN_BYTES) continue;
    seq.n++;
    const rel = `${table}/${String(seq.n).padStart(6, '0')}-${columns[i]}.txt`;
    await writeFile(join(blobsDir, ...rel.split('/')), v, 'utf8');
    blobs.push({ column: columns[i]!, bytes: utf8Length(v), file: rel });
  }
  return { table, key: pk, bytes, blobs };
}

/** Étape 2 : applique les fichiers SQL dans l'ordre, un par un, avec un point de reprise après chacun. */
export async function apply(o: Options): Promise<void> {
  const log = o.log ?? (() => {});
  const manifest = await loadManifest(o.workDir);
  const cpPath = join(o.workDir, CHECKPOINT);
  const cp = (await readJsonFile<Checkpoint>(cpPath)) ?? { files: {} };
  if (Object.keys(cp.files).length === 0) {
    // Premier passage : la cible doit être vide, sinon un import partiel précédent serait mélangé.
    const counts = await countTargetRows(
      o.target,
      manifest.tables.map((t) => t.name),
    );
    const filled = [...counts].filter(([, n]) => n !== 0);
    if (filled.length > 0) {
      throw new Error(
        `cible non vide (${filled
          .slice(0, 5)
          .map(([n, c]) => `${n}=${c}`)
          .join(', ')}) : import refusé`,
      );
    }
  }
  for (const file of manifest.files) {
    if (cp.files[file.name]?.status === 'done') continue;
    const path = join(o.workDir, 'sql', file.name);
    const content = await readFile(path, 'utf8');
    if (sha256(content) !== file.sha256)
      throw new Error(`${file.name} : empreinte différente du manifest (fichier modifié ?)`);
    cp.files[file.name] = { status: 'started', at: now() };
    await writeJsonAtomic(cpPath, cp);
    await runSqlFile(o.target, path);
    cp.files[file.name] = { status: 'done', at: now() };
    await writeJsonAtomic(cpPath, cp);
    log(`${file.name} appliqué (${file.rows} lignes, ${file.statements} instructions)`);
  }
}

export interface TableCheck {
  name: string;
  sourceRows: number;
  skippedRows: number;
  expectedRows: number;
  targetRows: number;
  countOk: boolean;
  samples: number;
  sampleMismatches: number;
  ok: boolean;
}

const normalize = (v: unknown): D1Value => (v === undefined ? null : (v as D1Value));

/** Étape 3 : compare le nombre de lignes et l'empreinte d'un échantillon de lignes à la source. */
export async function validate(o: Options): Promise<{ ok: boolean; tables: TableCheck[] }> {
  const manifest = await loadManifest(o.workDir);
  const counts = await countTargetRows(
    o.target,
    manifest.tables.map((t) => t.name),
  );
  const withSamples = manifest.tables.filter((t) => t.samples.length > 0 && t.columns.length > 0);
  const found = await fetchSampleRows(
    o.target,
    withSamples.map((t) => ({
      table: t.name,
      columns: t.columns,
      pk: t.pk,
      keys: t.samples.map((s) => s.key),
    })),
  );
  const tables: TableCheck[] = manifest.tables.map((t) => {
    const targetRows = counts.get(t.name) ?? NaN;
    const countOk = targetRows === t.expectedRows;
    let sampleMismatches = 0;
    const idx = withSamples.indexOf(t);
    if (idx >= 0) {
      const byKey = new Map(found[idx]!.map((r) => [keyOf(t.pk.map((c) => normalize(r[c]))), r]));
      for (const s of t.samples) {
        const row = byKey.get(keyOf(s.key));
        if (!row || rowSha256(t.columns.map((c) => normalize(row[c]))) !== s.sha256)
          sampleMismatches++;
      }
    }
    return {
      name: t.name,
      sourceRows: t.sourceRows,
      skippedRows: t.skippedRows,
      expectedRows: t.expectedRows,
      targetRows,
      countOk,
      samples: t.samples.length,
      sampleMismatches,
      ok: countOk && sampleMismatches === 0,
    };
  });
  const ok = tables.every((t) => t.ok);
  await writeJsonAtomic(join(o.workDir, REPORT), { checkedAt: now(), ok, tables });
  return { ok, tables };
}

/** Enchaîne les étapes. Avec dryRun, s'arrête après la génération des fichiers. */
export async function run(
  o: Options & { sourceUrl: string; dryRun: boolean; resume: boolean },
): Promise<{ extracted: boolean; validation?: { ok: boolean; tables: TableCheck[] } }> {
  const hasManifest = (await readJsonFile<Manifest>(join(o.workDir, MANIFEST))) !== null;
  let extracted = false;
  if (!(o.resume && hasManifest)) {
    await extract(o);
    extracted = true;
  }
  if (o.dryRun) return { extracted };
  await apply(o);
  return { extracted, validation: await validate(o) };
}
