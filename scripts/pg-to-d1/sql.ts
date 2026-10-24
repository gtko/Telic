import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type D1Value, utf8Length } from './transform.ts';

/** Paramètres liés par requête D1. Les valeurs sont écrites en littéraux ; on garde la même borne pour que le découpage vaille aussi pour un import par liaisons. */
export const MAX_PARAMS = 100;
/** Taille maximale d'une instruction SQL. Valeur prudente, à valider contre D1 distant avant bascule. */
export const DEFAULT_MAX_STATEMENT_BYTES = 100_000;
/** Morceau d'un gros texte, en octets UTF-8 (découpé entre deux points de code). */
export const CHUNK_BYTES = 32_000;
/** En dessous de cette taille, une valeur n'est jamais découpée. */
const SPLIT_MIN_BYTES = 1024;

export interface TableSpec {
  table: string;
  /** Colonnes insérées, dans l'ordre de la cible. */
  columns: string[];
  /** Clé primaire cible : sert à l'idempotence (NOT EXISTS) et aux UPDATE. */
  pk: string[];
}

export function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`identifiant refusé : ${name}`);
  return `"${name}"`;
}

export function sqlLiteral(v: D1Value): string {
  if (v === null) return 'NULL';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`valeur non finie : ${v}`);
    return Object.is(v, -0) ? '0' : String(v);
  }
  if (v.includes('\u0000')) throw new Error('caractère NUL refusé');
  return `'${v.replaceAll("'", "''")}'`;
}

function pkMatch(alias: string, pk: string[], other: string): string {
  return pk.map((c) => `${alias}.${quoteIdent(c)} = ${other}.${quoteIdent(c)}`).join(' AND ');
}

function valuesList(rows: D1Value[][]): string {
  return rows.map((r) => `(${r.map(sqlLiteral).join(', ')})`).join(',\n');
}

/**
 * INSERT multi-lignes rejouable : une ligne déjà présente (même clé primaire) est ignorée,
 * toute autre erreur (contrainte CHECK, UNIQUE sur un autre index, clé étrangère) reste bruyante.
 */
export function insertStatement(t: TableSpec, rows: D1Value[][]): string {
  const tbl = quoteIdent(t.table);
  const cols = t.columns.map(quoteIdent).join(', ');
  return (
    `WITH "__src"(${cols}) AS (VALUES ${valuesList(rows)}) ` +
    `INSERT INTO ${tbl} (${cols}) SELECT ${cols} FROM "__src" ` +
    `WHERE NOT EXISTS (SELECT 1 FROM ${tbl} AS "__t" WHERE ${pkMatch('"__t"', t.pk, '"__src"')});`
  );
}

function pkWhere(t: TableSpec, pkValues: D1Value[]): string {
  return t.pk.map((c, i) => `${quoteIdent(c)} = ${sqlLiteral(pkValues[i] ?? null)}`).join(' AND ');
}

/**
 * Ajoute un morceau à un texte déjà présent. Gardée par length(), donc rejouable :
 * si le morceau a déjà été ajouté, la longueur ne correspond plus et rien ne change.
 */
export function appendStatement(
  t: TableSpec,
  pkValues: D1Value[],
  column: string,
  chunk: string,
  offset: number,
): string {
  const col = quoteIdent(column);
  return (
    `UPDATE ${quoteIdent(t.table)} SET ${col} = ${col} || ${sqlLiteral(chunk)} ` +
    `WHERE ${pkWhere(t, pkValues)} AND length(${col}) = ${offset};`
  );
}

/** Fixe une clé étrangère vers la même table, après insertion de toutes les lignes (rejouable). */
export function deferredStatement(
  t: TableSpec,
  column: string,
  rows: { pk: D1Value[]; value: D1Value }[],
): string {
  const tbl = quoteIdent(t.table);
  const col = quoteIdent(column);
  const srcCols = [...t.pk.map(quoteIdent), col].join(', ');
  const values = rows.map((r) => [...r.pk, r.value]);
  const match = pkMatch('"__src"', t.pk, tbl);
  return (
    `WITH "__src"(${srcCols}) AS (VALUES ${valuesList(values)}) ` +
    `UPDATE ${tbl} SET ${col} = (SELECT "__src".${col} FROM "__src" WHERE ${match}) ` +
    `WHERE EXISTS (SELECT 1 FROM "__src" WHERE ${match});`
  );
}

/** Découpe un texte en morceaux d'au plus `maxBytes` octets, sans couper un caractère. */
export function splitCodePoints(text: string, maxBytes: number): string[] {
  const out: string[] = [];
  let current = '';
  let bytes = 0;
  for (const ch of text) {
    const size = utf8Length(ch);
    if (bytes + size > maxBytes && current !== '') {
      out.push(current);
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  if (current !== '') out.push(current);
  return out;
}

export interface PreparedRow {
  /** Valeurs insérées : les gros textes sont vides, leur contenu vient des UPDATE. */
  values: D1Value[];
  appends: { column: number; chunks: string[]; offsets: number[] }[];
  /** Taille estimée des littéraux de la ligne. */
  bytes: number;
}

function literalBytes(v: D1Value): number {
  if (v === null) return 4;
  if (typeof v === 'number') return String(v).length;
  let quotes = 0;
  for (let i = 0; i < v.length; i++) if (v.charCodeAt(i) === 39) quotes++;
  return utf8Length(v) + 2 + quotes;
}

/**
 * Prépare une ligne pour l'écriture. Si la ligne dépasse la moitié de `maxStatementBytes`,
 * les plus gros textes (hors clé primaire) sont vidés puis remplis par des UPDATE de morceaux.
 */
export function prepareRow(
  values: D1Value[],
  pkIndexes: number[],
  maxStatementBytes: number,
): PreparedRow {
  const budget = Math.floor(maxStatementBytes / 2);
  const sizes = values.map(literalBytes);
  let total = sizes.reduce((a, b) => a + b, 0);
  const appends: PreparedRow['appends'] = [];
  if (total > budget) {
    const candidates = values
      .map((v, i) => ({ v, i, size: sizes[i]! }))
      .filter(
        (c) => typeof c.v === 'string' && c.size > SPLIT_MIN_BYTES && !pkIndexes.includes(c.i),
      )
      .sort((a, b) => b.size - a.size);
    const out = [...values];
    for (const c of candidates) {
      if (total <= budget) break;
      const text = c.v as string;
      const chunks = splitCodePoints(text, CHUNK_BYTES);
      const offsets: number[] = [];
      let offset = 0;
      for (const chunk of chunks) {
        offsets.push(offset);
        offset += [...chunk].length;
      }
      out[c.i] = '';
      total -= c.size - 2;
      appends.push({ column: c.i, chunks, offsets });
    }
    return { values: out, appends, bytes: total };
  }
  return { values: [...values], appends, bytes: total };
}

/** Regroupe les lignes préparées en instructions INSERT (au plus MAX_PARAMS / colonnes par instruction). */
export class InsertBatcher {
  private rows: PreparedRow[] = [];
  private bytes = 0;
  private readonly rowsPerStatement: number;
  private readonly pkIndexes: number[];
  private readonly overhead: number;

  constructor(
    private readonly spec: TableSpec,
    private readonly maxStatementBytes: number,
    private readonly emit: (statements: string[], rows: number) => Promise<void>,
  ) {
    this.rowsPerStatement = Math.max(1, Math.floor(MAX_PARAMS / spec.columns.length));
    this.pkIndexes = spec.pk.map((c) => spec.columns.indexOf(c));
    if (this.pkIndexes.some((i) => i < 0))
      throw new Error(`${spec.table} : clé primaire absente des colonnes`);
    this.overhead = 2000 + 60 * spec.columns.length;
  }

  get indexes(): number[] {
    return this.pkIndexes;
  }

  async add(row: PreparedRow): Promise<void> {
    if (
      this.rows.length > 0 &&
      (this.rows.length >= this.rowsPerStatement ||
        this.bytes + row.bytes + this.overhead > this.maxStatementBytes)
    ) {
      await this.flush();
    }
    if (row.bytes + this.overhead > this.maxStatementBytes) {
      throw new Error(
        `${this.spec.table} : ligne de ${row.bytes} octets, au-delà de la taille d'instruction`,
      );
    }
    this.rows.push(row);
    this.bytes += row.bytes;
  }

  async flush(): Promise<void> {
    if (this.rows.length === 0) return;
    const statements = [
      insertStatement(
        this.spec,
        this.rows.map((r) => r.values),
      ),
    ];
    for (const row of this.rows) {
      const pkValues = this.pkIndexes.map((i) => row.values[i] ?? null);
      for (const a of row.appends) {
        const column = this.spec.columns[a.column]!;
        a.chunks.forEach((chunk, k) =>
          statements.push(appendStatement(this.spec, pkValues, column, chunk, a.offsets[k]!)),
        );
      }
    }
    const count = this.rows.length;
    this.rows = [];
    this.bytes = 0;
    await this.emit(statements, count);
  }
}

/** UPDATE des clés étrangères vers la même table, regroupées par instruction. */
export function deferredStatements(
  spec: TableSpec,
  column: string,
  entries: { pk: D1Value[]; value: D1Value }[],
  maxStatementBytes: number,
): string[] {
  const perStatement = Math.max(1, Math.floor(MAX_PARAMS / (spec.pk.length + 1)));
  const out: string[] = [];
  let batch: { pk: D1Value[]; value: D1Value }[] = [];
  let bytes = 0;
  for (const e of entries) {
    const size = e.pk.reduce<number>((n, v) => n + literalBytes(v), literalBytes(e.value)) + 20;
    if (batch.length > 0 && (batch.length >= perStatement || bytes + size > maxStatementBytes)) {
      out.push(deferredStatement(spec, column, batch));
      batch = [];
      bytes = 0;
    }
    batch.push(e);
    bytes += size;
  }
  if (batch.length > 0) out.push(deferredStatement(spec, column, batch));
  return out;
}

export interface SqlFile {
  name: string;
  sha256: string;
  bytes: number;
  statements: number;
  rows: number;
  tables: string[];
}

/** Écrit les instructions dans des fichiers numérotés ; une ligne et ses UPDATE ne sont jamais coupés entre deux fichiers. */
export class SqlFileWriter {
  readonly files: SqlFile[] = [];
  private seq = 0;
  private buf: string[] = [];
  private bytes = 0;
  private statements = 0;
  private rows = 0;
  private tables = new Set<string>();

  constructor(
    private readonly dir: string,
    private readonly maxFileBytes: number,
  ) {}

  async addGroup(statements: string[], rows: number, table: string): Promise<void> {
    if (statements.length === 0) return;
    let size = 0;
    for (const s of statements) size += utf8Length(s) + 1;
    if (this.statements > 0 && this.bytes + size > this.maxFileBytes) await this.rotate();
    for (const s of statements) this.buf.push(s);
    this.bytes += size;
    this.statements += statements.length;
    this.rows += rows;
    this.tables.add(table);
  }

  async finish(): Promise<SqlFile[]> {
    await this.rotate();
    return this.files;
  }

  private async rotate(): Promise<void> {
    if (this.statements === 0) return;
    this.seq++;
    const name = `${String(this.seq).padStart(4, '0')}.sql`;
    const content = `${this.buf.join('\n')}\n`;
    await writeFile(join(this.dir, name), content, 'utf8');
    this.files.push({
      name,
      sha256: createHash('sha256').update(content).digest('hex'),
      bytes: utf8Length(content),
      statements: this.statements,
      rows: this.rows,
      tables: [...this.tables].sort(),
    });
    this.buf = [];
    this.bytes = 0;
    this.statements = 0;
    this.rows = 0;
    this.tables = new Set();
  }
}
