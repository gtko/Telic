import { describe, expect, test } from 'bun:test';
import { convertSchemaSource } from './pg-to-sqlite.ts';

const pg = (body: string, imports = 'pgTable, text') =>
  `import { ${imports} } from 'drizzle-orm/pg-core';\n${body}\n`;

describe('pg-core -> sqlite-core rewrite', () => {
  test('renames pgTable and moves the import to sqlite-core', () => {
    const out = convertSchemaSource(
      pg(`export const a = pgTable('a', { id: text('id').primaryKey() });`),
    ).output;
    expect(out).toContain("import { sqliteTable, text } from 'drizzle-orm/sqlite-core';");
    expect(out).toContain("export const a = sqliteTable('a', { id: text('id').primaryKey() });");
    expect(out).not.toContain('pg-core');
  });

  test('serial primary key becomes integer with autoIncrement', () => {
    const out = convertSchemaSource(
      pg(`export const a = pgTable('a', { id: serial('id').primaryKey() });`, 'pgTable, serial'),
    ).output;
    expect(out).toContain("id: integer('id').primaryKey({ autoIncrement: true })");
    expect(out).toContain("import { sqliteTable, integer } from 'drizzle-orm/sqlite-core';");
  });

  test('bigserial with mode option drops the option and keeps autoIncrement', () => {
    const out = convertSchemaSource(
      pg(
        `export const a = pgTable('a', { id: bigserial('id', { mode: 'number' }).primaryKey() });`,
        'pgTable, bigserial',
      ),
    ).output;
    expect(out).toContain("id: integer('id').primaryKey({ autoIncrement: true })");
  });

  test('uuid with defaultRandom becomes text with a runtime $defaultFn', () => {
    const out = convertSchemaSource(
      pg(
        `export const a = pgTable('a', { id: uuid('id').primaryKey().defaultRandom() });`,
        'pgTable, uuid',
      ),
    ).output;
    expect(out).toContain("id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID())");
  });

  test('timestamp with defaultNow becomes timestamp_ms with a SQL default and adds the sql import', () => {
    const out = convertSchemaSource(
      pg(
        `export const a = pgTable('a', { c: timestamp('created_at', { withTimezone: true }).notNull().defaultNow() });`,
        'pgTable, timestamp',
      ),
    ).output;
    expect(out).toContain("import { sql } from 'drizzle-orm';");
    expect(out).toContain(
      "c: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(CAST(unixepoch('subsecond') * 1000 AS INTEGER))`)",
    );
  });

  test('jsonb becomes text in json mode and keeps $type', () => {
    const out = convertSchemaSource(
      pg(
        `export const a = pgTable('a', { h: jsonb('hotkeys').$type<Record<string, string>>() });`,
        'pgTable, jsonb',
      ),
    ).output;
    expect(out).toContain("h: text('hotkeys', { mode: 'json' }).$type<Record<string, string>>()");
    expect(out).toContain("import { sqliteTable, text } from 'drizzle-orm/sqlite-core';");
  });

  test('boolean, numeric, double precision, date and bigint map to sqlite types', () => {
    const out = convertSchemaSource(
      pg(
        `export const a = pgTable('a', {
  a: boolean('a').notNull().default(true),
  b: numeric('b'),
  c: doublePrecision('c').notNull(),
  d: date('d'),
  e: bigint('e', { mode: 'number' }).notNull(),
});`,
        'pgTable, boolean, numeric, doublePrecision, date, bigint',
      ),
    ).output;
    expect(out).toContain("a: integer('a', { mode: 'boolean' }).notNull().default(true),");
    expect(out).toContain("b: real('b'),");
    expect(out).toContain("c: real('c').notNull(),");
    expect(out).toContain("d: text('d'),");
    expect(out).toContain("e: integer('e').notNull(),");
  });

  test('text arrays become json columns typed as string arrays', () => {
    const out = convertSchemaSource(
      pg(
        `export const a = pgTable('a', {
  s: text('scopes').array(),
  r: text('redirect_uris').array().notNull(),
});`,
      ),
    ).output;
    expect(out).toContain("s: text('scopes', { mode: 'json' }).$type<string[]>(),");
    expect(out).toContain(
      "r: text('redirect_uris', { mode: 'json' }).$type<string[]>().notNull(),",
    );
  });

  test('AnyPgColumn becomes AnySQLiteColumn in code and import', () => {
    const out = convertSchemaSource(
      pg(
        `export const a = pgTable('a', { p: text('p').references((): AnyPgColumn => a.id) });`,
        'pgTable, text, type AnyPgColumn',
      ),
    ).output;
    expect(out).toContain(
      "import { sqliteTable, text, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';",
    );
    expect(out).toContain('(): AnySQLiteColumn => a.id');
  });

  test('pg functions inside sql fragments are mapped, with a review entry', () => {
    const result = convertSchemaSource(
      pg(
        `export const a = pgTable('a', { t: text('t') }, (t) => [
  index('i').on(t.t, sql\`lower(btrim(\${t.t}))\`),
  check('c', sql\`least(\${t.t}, \${t.t}) >= 0\`),
  check('d', sql\`greatest(\${t.t}, \${t.t}) >= 0\`),
]);`,
        'pgTable, text, index, check',
      ),
    );
    expect(result.output).toContain('sql`lower(trim(${t.t}))`');
    expect(result.output).toContain(
      'sql`CASE WHEN ${t.t} <= ${t.t} THEN ${t.t} ELSE ${t.t} END >= 0`',
    );
    expect(result.output).toContain(
      'sql`CASE WHEN ${t.t} >= ${t.t} THEN ${t.t} ELSE ${t.t} END >= 0`',
    );
    expect(result.review.some((r) => r.construct.includes('NULL semantics'))).toBe(true);
    expect(result.counts['sql btrim() -> trim()']).toBe(1);
    expect(result.counts['sql least(a, b) -> CASE']).toBe(1);
    expect(result.notCovered).toEqual([]);
  });

  test('least() with a non-placeholder argument is reported, not rewritten', () => {
    const result = convertSchemaSource(
      pg(
        `export const a = pgTable('a', { t: text('t') }, (t) => [check('c', sql\`least(\${t.t}, 0) >= 0\`)]);`,
        'pgTable, text, check',
      ),
    );
    expect(result.notCovered.some((f) => f.construct.includes('least()'))).toBe(true);
  });

  test('col.desc() in an index becomes desc(col) and merges into the drizzle-orm import', () => {
    const result = convertSchemaSource(
      `import { sql } from 'drizzle-orm';\n` +
        pg(
          `export const a = pgTable('a', { t: timestamp('t').notNull() }, (t) => [index('i').on(t.t.desc())]);`,
          'pgTable, timestamp, index',
        ),
    );
    expect(result.output).toContain("import { sql, desc } from 'drizzle-orm';");
    expect(result.output).toContain("index('i').on(desc(t.t))");
    expect(result.counts['desc() column -> desc(column)']).toBe(1);
  });

  test('desc() adds its own drizzle-orm import when the file has none', () => {
    const out = convertSchemaSource(
      pg(
        `export const a = pgTable('a', { t: text('t') }, (t) => [index('i').on(t.t.asc())]);`,
        'pgTable, text, index',
      ),
    ).output;
    expect(out).toContain("import { asc } from 'drizzle-orm';");
    expect(out).toContain("index('i').on(asc(t.t))");
  });

  test('keeps layout and comments', () => {
    const out = convertSchemaSource(
      pg(
        `export const a = pgTable('a', {
  // The provider's own id.
  externalId: text('external_id'),
});`,
      ),
    ).output;
    expect(out).toContain("  // The provider's own id.\n  externalId: text('external_id'),");
  });
});

describe('constructs with no sqlite equivalent are reported', () => {
  test('pgEnum import stays and is reported', () => {
    const result = convertSchemaSource(pg(`export const e = pgEnum('e', ['a']);`, 'pgEnum'));
    expect(result.output).toContain("import { pgEnum } from 'drizzle-orm/sqlite-core';");
    expect(result.notCovered.some((f) => f.construct.includes('pgEnum'))).toBe(true);
  });

  test('.using() on an index is reported and not rewritten', () => {
    const result = convertSchemaSource(
      pg(
        `export const a = pgTable('a', { t: text('t') }, (t) => [index('i').on(t.t).using('gin')]);`,
        'pgTable, text, index',
      ),
    );
    expect(result.output).toContain(".using('gin')");
    expect(result.notCovered.some((f) => f.construct.includes('.using()'))).toBe(true);
  });

  test('now() inside a sql fragment is reported', () => {
    const result = convertSchemaSource(
      pg(`export const a = pgTable('a', { t: text('t').default(sql\`now()\`) });`, 'pgTable, text'),
    );
    expect(result.notCovered.some((f) => f.construct.includes('now()'))).toBe(true);
  });

  test('serial without primaryKey is reported (no sequence in sqlite)', () => {
    const result = convertSchemaSource(
      pg(`export const a = pgTable('a', { n: serial('n') });`, 'pgTable, serial'),
    );
    expect(result.notCovered.some((f) => f.construct.includes('serial'))).toBe(true);
  });

  test('array() on a non-text column is reported', () => {
    const result = convertSchemaSource(
      pg(`export const a = pgTable('a', { n: integer('n').array() });`, 'pgTable, integer'),
    );
    expect(result.notCovered.some((f) => f.construct.includes('array()'))).toBe(true);
  });

  test('a file without pg-core imports is returned unchanged', () => {
    const src = "import { x } from 'y';\nexport const a = 1;\n";
    expect(convertSchemaSource(src).output).toBe(src);
  });
});
