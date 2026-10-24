import postgres from 'postgres';
import { quoteIdent } from './sql.ts';
import type { SourceColumn, SourceTable } from './plan.ts';

export interface SelectColumn {
  name: string;
  expr: string;
}

export interface PgKeyColumn {
  name: string;
  udt: string;
}

const UDT = /^[a-z_][a-z0-9_]*$/i;

/**
 * Ouvre une seule transaction en lecture seule, isolation REPEATABLE READ : toutes les tables
 * sont lues dans le même instantané, et Postgres refuse toute écriture pendant la lecture.
 * L'URL vient de l'environnement (jamais de la ligne de commande) et n'est jamais affichée.
 */
export async function withPgSnapshot<T>(
  url: string,
  fn: (reader: PgReader) => Promise<T>,
): Promise<T> {
  const sql = postgres(url, { max: 1, idle_timeout: 60, connect_timeout: 15, onnotice: () => {} });
  try {
    const result = await sql.begin('isolation level repeatable read read only', async (tx) =>
      fn(new PgReader(tx)),
    );
    return result as T;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export class PgReader {
  constructor(private readonly tx: postgres.TransactionSql) {}

  /** Tables de base du schéma public, avec leurs colonnes et leur clé primaire. */
  async tables(): Promise<SourceTable[]> {
    const columns = await this.tx<
      { table_name: string; column_name: string; data_type: string; udt_name: string }[]
    >`
      SELECT c.table_name, c.column_name, c.data_type, c.udt_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
      ORDER BY c.table_name, c.ordinal_position`;
    const keys = await this.tx<{ table_name: string; column_name: string }[]>`
      SELECT kcu.table_name, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_schema = tc.constraint_schema
       AND kcu.constraint_name = tc.constraint_name
       AND kcu.table_name = tc.table_name
      WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'
      ORDER BY kcu.table_name, kcu.ordinal_position`;
    const byName = new Map<string, SourceTable>();
    for (const c of columns) {
      let t = byName.get(c.table_name);
      if (!t) {
        t = { name: c.table_name, columns: [], pk: [] };
        byName.set(c.table_name, t);
      }
      const col: SourceColumn = { name: c.column_name, dataType: c.data_type, udt: c.udt_name };
      t.columns.push(col);
    }
    for (const k of keys) byName.get(k.table_name)?.pk.push(k.column_name);
    return [...byName.values()];
  }

  async count(table: string): Promise<number> {
    const rows = await this.tx.unsafe<{ n: string }[]>(
      `SELECT count(*)::text AS n FROM ${quoteIdent(table)}`,
    );
    return Number(rows[0]!.n);
  }

  /** Lignes de la table, par pages ordonnées sur la clé primaire (pas de OFFSET). */
  async *rows(
    table: string,
    select: SelectColumn[],
    key: PgKeyColumn[],
    pageSize: number,
  ): AsyncGenerator<Record<string, unknown>> {
    for (const k of key) if (!UDT.test(k.udt)) throw new Error(`type de clé refusé : ${k.udt}`);
    if (!Number.isSafeInteger(pageSize) || pageSize < 1)
      throw new Error(`taille de page invalide : ${pageSize}`);
    const cols = select.map((s) => `${s.expr} AS ${quoteIdent(s.name)}`).join(', ');
    const from = quoteIdent(table);
    // Qualifiées : sans préfixe, ORDER BY "id" désignerait l'alias ::text de la liste SELECT
    // et trierait les entiers comme du texte, ce qui casse la pagination par clé.
    const keys = key.map((k) => `${from}.${quoteIdent(k.name)}`).join(', ');
    let after: unknown[] | null = null;
    for (;;) {
      const params: unknown[] = [];
      let where = '';
      if (after) {
        where =
          key.length === 1
            ? `WHERE ${keys} > $1::${key[0]!.udt}`
            : `WHERE (${keys}) > (${key.map((k, i) => `$${i + 1}::${k.udt}`).join(', ')})`;
        params.push(...after);
      }
      const page = await this.tx.unsafe<Record<string, unknown>[]>(
        `SELECT ${cols} FROM ${from} ${where} ORDER BY ${keys} LIMIT ${pageSize}`,
        params as never[],
      );
      for (const row of page) yield row;
      if (page.length < pageSize) return;
      const last = page[page.length - 1]!;
      after = key.map((k) => last[k.name]);
    }
  }
}
