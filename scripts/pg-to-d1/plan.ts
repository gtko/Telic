import { type PgKind, pgKind } from './transform.ts';

export interface TargetColumn {
  name: string;
  type: string;
  notNull: boolean;
  hasDefault: boolean;
  /** Position dans la clé primaire, 1 à n ; 0 si hors clé. */
  pkPosition: number;
}

export interface TargetTable {
  name: string;
  columns: TargetColumn[];
  /** Colonne de cette table -> table référencée. */
  foreignKeys: { column: string; parent: string }[];
}

export interface SourceColumn {
  name: string;
  dataType: string;
  udt: string;
}

export interface SourceTable {
  name: string;
  columns: SourceColumn[];
  /** Clé primaire source, dans l'ordre de la clé. */
  pk: string[];
}

export interface TablePlan {
  name: string;
  /** Colonnes insérées, dans l'ordre de la cible. */
  columns: { name: string; kind: PgKind }[];
  /** Clé primaire cible (ordre de la clé). */
  pk: string[];
  /** Clé primaire source : pagination par clé. */
  sourcePk: { name: string; kind: PgKind; udt: string }[];
  /** Clés étrangères vers la même table : posées après insertion de toutes les lignes. */
  selfColumns: string[];
  /** Colonnes présentes dans la source et absentes de la cible (écartées, à relire dans le rapport). */
  droppedColumns: string[];
}

export interface Plan {
  /** Toutes les tables cibles, parents avant enfants. */
  order: string[];
  /** Tables présentes dans la source et dans la cible. */
  tables: Map<string, TablePlan>;
  /** Tables de la source absentes de la cible : ignorées, à relire dans le rapport. */
  ignoredSourceTables: string[];
  /** Tables de la cible absentes de la source : aucune ligne à copier. */
  absentFromSource: string[];
}

/** Tri topologique (Kahn) : une table vient après les tables qu'elle référence. Les auto-références sont ignorées. */
export function orderTables(tables: TargetTable[]): string[] {
  const names = new Set(tables.map((t) => t.name));
  const parentsOf = new Map<string, Set<string>>();
  for (const t of tables) {
    const parents = new Set<string>();
    for (const fk of t.foreignKeys) {
      if (fk.parent === t.name) continue;
      if (!names.has(fk.parent))
        throw new Error(`${t.name}.${fk.column} référence une table absente : ${fk.parent}`);
      parents.add(fk.parent);
    }
    parentsOf.set(t.name, parents);
  }
  const remaining = new Set(names);
  const order: string[] = [];
  let progress = true;
  while (progress && remaining.size > 0) {
    progress = false;
    for (const name of [...remaining].sort()) {
      const parents = parentsOf.get(name)!;
      if ([...parents].every((p) => !remaining.has(p))) {
        order.push(name);
        remaining.delete(name);
        progress = true;
      }
    }
  }
  if (remaining.size > 0)
    throw new Error(`cycle de clés étrangères entre tables : ${[...remaining].sort().join(', ')}`);
  return order;
}

/** Croise le schéma cible (D1) et la source (Postgres) : colonnes, types, clés, tables écartées. */
export function buildPlan(target: TargetTable[], source: SourceTable[]): Plan {
  const order = orderTables(target);
  const sourceByName = new Map(source.map((s) => [s.name, s]));
  const targetNames = new Set(target.map((t) => t.name));
  const tables = new Map<string, TablePlan>();

  for (const t of target) {
    const s = sourceByName.get(t.name);
    if (!s) continue;
    const sourceColumns = new Map(s.columns.map((c) => [c.name, c]));
    const targetColumnNames = new Set(t.columns.map((c) => c.name));
    const columns: TablePlan['columns'] = [];
    for (const c of t.columns) {
      const src = sourceColumns.get(c.name);
      if (!src) {
        if (c.notNull && !c.hasDefault) {
          throw new Error(
            `${t.name}.${c.name} : colonne NOT NULL sans défaut, absente de la source`,
          );
        }
        continue;
      }
      columns.push({ name: c.name, kind: pgKind(src.dataType, src.udt) });
    }
    const pk = t.columns
      .filter((c) => c.pkPosition > 0)
      .sort((a, b) => a.pkPosition - b.pkPosition)
      .map((c) => c.name);
    if (pk.length === 0) throw new Error(`${t.name} : clé primaire absente de la cible`);
    if (s.pk.length === 0) throw new Error(`${t.name} : table sans clé primaire dans la source`);
    const inserted = new Set(columns.map((c) => c.name));
    for (const p of pk) {
      if (!inserted.has(p)) throw new Error(`${t.name}.${p} : colonne de clé primaire non copiée`);
    }
    const sourcePk = s.pk.map((name) => {
      const src = sourceColumns.get(name);
      if (!src) throw new Error(`${t.name}.${name} : clé source absente des colonnes`);
      const kind = pgKind(src.dataType, src.udt);
      if (kind !== 'text' && kind !== 'int')
        throw new Error(`${t.name}.${name} : clé de pagination de type ${kind} non géré`);
      return { name, kind, udt: src.udt };
    });
    const selfColumns = t.foreignKeys
      .filter((fk) => fk.parent === t.name && inserted.has(fk.column))
      .map((fk) => fk.column);
    for (const col of selfColumns) {
      const meta = t.columns.find((c) => c.name === col)!;
      if (meta.notNull) throw new Error(`${t.name}.${col} : auto-référence NOT NULL non gérée`);
    }
    const droppedColumns = s.columns.map((c) => c.name).filter((n) => !targetColumnNames.has(n));
    tables.set(t.name, { name: t.name, columns, pk, sourcePk, selfColumns, droppedColumns });
  }

  return {
    order,
    tables,
    ignoredSourceTables: source
      .map((s) => s.name)
      .filter((n) => !targetNames.has(n))
      .sort(),
    absentFromSource: order.filter((n) => !sourceByName.has(n)),
  };
}
