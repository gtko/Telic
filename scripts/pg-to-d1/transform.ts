// Mapping des types Postgres vers D1 (SQLite), selon packages/db/PORTING_NOTES.md :
// timestamp -> epoch ms, date -> texte ISO, jsonb et tableaux -> texte JSON, uuid -> texte,
// numeric -> real, booléens -> 0/1. La requête Postgres rend déjà chaque valeur sous une forme
// simple (voir selectExpr) ; ce module la valide et la normalise avant l'écriture.

export type PgKind = 'ts' | 'date' | 'json' | 'array' | 'bool' | 'int' | 'real' | 'text';

export type D1Value = number | string | null;

/** Limite D1 : 2 Mo par ligne. Au-delà, la ligne n'est pas écrite (rapport + blobs). */
export const MAX_ROW_BYTES = 2_000_000;

/** Type de conversion pour une colonne Postgres. Lève une erreur pour tout type non prévu. */
export function pgKind(dataType: string, udtName: string): PgKind {
  const type = dataType.toLowerCase();
  if (type === 'array' || udtName.startsWith('_')) return 'array';
  switch (type) {
    case 'timestamp with time zone':
    case 'timestamp without time zone':
      return 'ts';
    case 'date':
      return 'date';
    case 'json':
    case 'jsonb':
      return 'json';
    case 'boolean':
      return 'bool';
    case 'smallint':
    case 'integer':
    case 'bigint':
      return 'int';
    case 'double precision':
    case 'real':
    case 'numeric':
      return 'real';
    case 'text':
    case 'character varying':
    case 'character':
    case 'uuid':
      return 'text';
  }
  throw new Error(`type Postgres non géré : ${dataType} (${udtName})`);
}

/**
 * Expression SELECT qui rend la colonne sous la forme que toD1Value attend.
 * `column` est un identifiant déjà validé (quoteIdent) : seule la forme entre guillemets est utilisée.
 */
export function selectExpr(kind: PgKind, column: string): string {
  const c = `"${column}"`;
  switch (kind) {
    case 'ts':
      // epoch exact (numeric en PG 14+), ramené à la milliseconde inférieure
      return `(FLOOR(EXTRACT(EPOCH FROM ${c}) * 1000))::bigint::text`;
    case 'date':
      return `to_char(${c}, 'YYYY-MM-DD')`;
    case 'json':
      return `${c}::text`;
    case 'array':
      return `array_to_json(${c})::text`;
    case 'bool':
      return `(CASE WHEN ${c} THEN 1 WHEN NOT ${c} THEN 0 END)`;
    case 'int':
      return `${c}::text`;
    case 'real':
      return `${c}::double precision`;
    case 'text':
      return `${c}::text`;
  }
}

/** Convertit une valeur rendue par la requête Postgres en valeur D1. `where` nomme la colonne pour les erreurs. */
export function toD1Value(kind: PgKind, raw: unknown, where: string): D1Value {
  if (raw === null || raw === undefined) return null;
  switch (kind) {
    case 'ts':
    case 'int':
      return safeInteger(raw, where);
    case 'bool':
      if (raw === 0 || raw === 1) return raw;
      throw new Error(`${where} : booléen attendu 0/1, reçu ${String(raw)}`);
    case 'date':
      if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
      throw new Error(`${where} : date ISO attendue, reçu ${String(raw)}`);
    case 'json':
    case 'array':
      return canonicalJson(raw, where);
    case 'real': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (Number.isFinite(n)) return n;
      throw new Error(`${where} : réel fini attendu, reçu ${String(raw)}`);
    }
    case 'text':
      if (typeof raw !== 'string') throw new Error(`${where} : texte attendu`);
      if (raw.includes('\u0000')) throw new Error(`${where} : caractère NUL refusé`);
      return raw;
  }
}

function safeInteger(raw: unknown, where: string): number {
  const n =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && /^-?\d+$/.test(raw)
        ? Number(raw)
        : NaN;
  if (Number.isSafeInteger(n)) return n;
  throw new Error(`${where} : entier sûr attendu (|n| < 2^53), reçu ${String(raw)}`);
}

/** Forme compacte et stable du JSON (celle qu'écrit JSON.stringify côté application). */
function canonicalJson(raw: unknown, where: string): string {
  if (typeof raw !== 'string') return JSON.stringify(raw);
  try {
    return JSON.stringify(JSON.parse(raw));
  } catch {
    throw new Error(`${where} : JSON invalide`);
  }
}

/** Taille UTF-8 d'une chaîne, sans allocation. */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** Taille de la valeur dans la ligne D1 (octets). Les nombres comptent 8 octets. */
export function valueBytes(v: D1Value): number {
  if (v === null) return 0;
  return typeof v === 'number' ? 8 : utf8Length(v);
}
