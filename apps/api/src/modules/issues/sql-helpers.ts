import { sql, type SQL } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

// `column IN (ids)` for a list of any length. D1 binds at most 100 parameters per
// statement, so a long `inArray(column, ids)` fails; this binds ONE parameter, a JSON
// array that SQLite unrolls with json_each. Meant for lists of integer ids (issue ids,
// column ids...) of unbounded size, such as the issues of a board.
export function inIds(column: AnySQLiteColumn, ids: readonly number[]): SQL {
  return sql`${column} IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`;
}

// Escapes LIKE metacharacters so a user's text is matched literally. SQLite has no
// default escape character, so every pattern built with this goes through `likeText`,
// which declares `\` as the escape.
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// Case-insensitive match (`ilike` on Postgres). SQLite's LIKE ignores case for ASCII
// letters only. `pattern` carries its own `%` wildcards and is escaped with `escapeLike`.
export function likeText(column: SQL | AnySQLiteColumn, pattern: string): SQL {
  return sql`${column} LIKE ${pattern} ESCAPE '\\'`;
}
