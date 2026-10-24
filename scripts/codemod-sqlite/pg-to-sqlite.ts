// Codemod: Drizzle pg-core schema -> sqlite-core schema (ODY-296, spike S3).
//
// Usage: bun scripts/codemod-sqlite/pg-to-sqlite.ts [--write] [--verbose] <file.ts>...
//
// Without --write it only prints the report. Edits are applied to the source text at the
// AST node ranges, so layout and comments are kept; run prettier on the result afterwards.
// Constructs with no sqlite equivalent are left untouched and listed in `notCovered`.
// Constructs that stay valid SQL but are not checked by the codemod (CHECK, partial
// index WHERE, raw sql`` fragments) are listed in `review`.
import { readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';

export interface Finding {
  line: number;
  construct: string;
}

export interface ConvertResult {
  output: string;
  counts: Record<string, number>;
  notCovered: Finding[];
  review: Finding[];
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

const NOW_MS_SQL = "sql`(CAST(unixepoch('subsecond') * 1000 AS INTEGER))`";
const MODE_MS = "{ mode: 'timestamp_ms' }";
const MODE_JSON = "{ mode: 'json' }";
const MODE_BOOL = "{ mode: 'boolean' }";

// pg-core export -> sqlite-core export. Names not listed here are kept and reported.
const IMPORT_MAP: Record<string, string> = {
  pgTable: 'sqliteTable',
  AnyPgColumn: 'AnySQLiteColumn',
  serial: 'integer',
  bigserial: 'integer',
  bigint: 'integer',
  integer: 'integer',
  timestamp: 'integer',
  boolean: 'integer',
  uuid: 'text',
  jsonb: 'text',
  date: 'text',
  text: 'text',
  doublePrecision: 'real',
  numeric: 'real',
  real: 'real',
  index: 'index',
  uniqueIndex: 'uniqueIndex',
  unique: 'unique',
  check: 'check',
  primaryKey: 'primaryKey',
  foreignKey: 'foreignKey',
};

// Column builders that get a rewrite. 'keep' builders need no change.
const BUILDER_KIND: Record<string, string> = {
  serial: 'serial',
  bigserial: 'serial',
  bigint: 'bigint',
  uuid: 'uuid',
  timestamp: 'timestamp',
  jsonb: 'jsonb',
  boolean: 'boolean',
  doublePrecision: 'real',
  numeric: 'real',
  date: 'date',
  text: 'text',
  integer: 'keep',
  real: 'keep',
};

// Column methods with no sqlite counterpart (reported, not rewritten).
const PG_ONLY_METHODS = new Set([
  'using',
  'nullsNotDistinct',
  'concurrently',
  'enableRLS',
  'generatedAlwaysAs',
  'generatedAlwaysAsIdentity',
  'identity',
  'pgPolicy',
]);

// Functions inside sql`` fragments that exist in pg but not in sqlite under the same name.
// The rewrite keeps the SQL valid; the NULL semantics are reported for review.
const SQL_FN_REWRITES: Array<[string, string, string]> = [
  ['\\bbtrim\\(', 'trim(', 'sql btrim() -> trim()'],
];

// pg least(a, b) / greatest(a, b) over two ${...} placeholders become a CASE expression.
// sqlite's two-argument min()/max() would work in a CHECK or WHERE, but drizzle-kit splits
// index column expressions on commas, so a comma-free form is the only one that serializes.
const SQL_LEAST_GREATEST: Array<[string, string, string]> = [
  ['least', '<=', 'sql least(a, b) -> CASE'],
  ['greatest', '>=', 'sql greatest(a, b) -> CASE'],
];

// sql`` fragments that cannot be translated: reported as not covered.
const SQL_UNSUPPORTED: Array<[RegExp, string]> = [
  [/\bnow\(\)/, 'sql now() (pg) has no sqlite equivalent'],
  [/::/, 'sql :: cast (pg syntax)'],
  [/\bgen_random_uuid\(/, 'sql gen_random_uuid() (pg)'],
  [/\bILIKE\b/i, 'sql ILIKE (pg)'],
  [/\bANY\s*\(/, 'sql ANY(array) (pg)'],
  [/\bto_tsvector\(|\btsvector\b/, 'sql tsvector (pg full-text)'],
  [/\bjsonb_\w+\(|->>|#>>/, 'sql jsonb operator or function (pg)'],
];

function emptyCounts(): Record<string, number> {
  return {};
}

export function convertSchemaSource(source: string, fileName = 'schema.ts'): ConvertResult {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edits: Edit[] = [];
  const counts = emptyCounts();
  const notCovered: Finding[] = [];
  const review: Finding[] = [];

  const bump = (rule: string) => {
    counts[rule] = (counts[rule] ?? 0) + 1;
  };
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const textOf = (node: ts.Node) => source.slice(node.getStart(sf), node.end);

  // Pass 0: what the file imports from drizzle-orm/pg-core, and from drizzle-orm.
  const pgNames = new Set<string>();
  let pgImport: ts.ImportDeclaration | undefined;
  let drizzleImport: ts.NamedImports | undefined;
  const drizzleNames = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const named = st.importClause?.namedBindings;
    const elements = named && ts.isNamedImports(named) ? named.elements : [];
    if (st.moduleSpecifier.text === 'drizzle-orm/pg-core') {
      pgImport = st;
      for (const el of elements) pgNames.add((el.propertyName ?? el.name).text);
    }
    if (st.moduleSpecifier.text === 'drizzle-orm' && named && ts.isNamedImports(named)) {
      drizzleImport ??= named;
      for (const el of elements) drizzleNames.add(el.name.text);
    }
  }
  if (!pgImport) {
    return { output: source, counts, notCovered, review };
  }
  const pgImportNode = pgImport;

  let needSql = false;
  const needFns = new Set<'asc' | 'desc'>();

  // Rewrite one column chain: root builder plus the methods chained on it.
  const handleColumn = (root: ts.CallExpression, builder: string) => {
    const kind = BUILDER_KIND[builder];
    const methods: ts.CallExpression[] = [];
    let cur: ts.Node = root;
    for (;;) {
      const access = cur.parent;
      if (!access || !ts.isPropertyAccessExpression(access) || access.expression !== cur) break;
      const call = access.parent;
      if (!call || !ts.isCallExpression(call) || call.expression !== access) break;
      methods.push(call);
      cur = call;
    }
    const methodName = (m: ts.CallExpression) =>
      ts.isPropertyAccessExpression(m.expression) ? m.expression.name.text : '';
    const hasArray = methods.some((m) => methodName(m) === 'array');
    const hasPk = methods.some((m) => methodName(m) === 'primaryKey' && m.arguments.length === 0);

    const arg0 = root.arguments[0] ? textOf(root.arguments[0]) : undefined;
    if (arg0 === undefined && kind !== 'keep') {
      notCovered.push({ line: lineOf(root), construct: `${builder}() sans nom de colonne` });
      return;
    }

    let rootText: string | undefined;
    let rule = '';
    switch (kind) {
      case 'keep':
        break;
      case 'serial':
        rootText = `integer(${arg0})`;
        rule = `${builder} -> integer`;
        if (!hasPk) {
          notCovered.push({
            line: lineOf(root),
            construct: `${builder}() sans primaryKey : la sequence pg n'est pas portee`,
          });
        }
        break;
      case 'bigint':
        rootText = `integer(${arg0})`;
        rule = 'bigint -> integer';
        break;
      case 'uuid':
        rootText = `text(${arg0})`;
        rule = 'uuid -> text';
        break;
      case 'timestamp':
        rootText = `integer(${arg0}, ${MODE_MS})`;
        rule = 'timestamp -> integer(timestamp_ms)';
        break;
      case 'jsonb':
        rootText = `text(${arg0}, ${MODE_JSON})`;
        rule = 'jsonb -> text(json)';
        break;
      case 'boolean':
        rootText = `integer(${arg0}, ${MODE_BOOL})`;
        rule = 'boolean -> integer(boolean)';
        break;
      case 'real':
        rootText = `real(${arg0})`;
        rule = `${builder} -> real`;
        break;
      case 'date':
        rootText = `text(${arg0})`;
        rule = 'date -> text';
        break;
      case 'text':
        if (hasArray) {
          if (root.arguments.length > 1) {
            notCovered.push({
              line: lineOf(root),
              construct: 'text(..., opts).array() non converti',
            });
          } else {
            rootText = `text(${arg0}, ${MODE_JSON})`;
            rule = 'text[] -> text(json)';
          }
        }
        break;
      default:
        break;
    }
    if (rootText !== undefined) {
      edits.push({ start: root.getStart(sf), end: root.end, text: rootText });
      bump(rule);
    }

    for (const m of methods) {
      const name = methodName(m);
      const nameStart = (m.expression as ts.PropertyAccessExpression).name.getStart(sf);
      const dot = source.lastIndexOf('.', nameStart);
      const replace = (text: string, rule: string) => {
        edits.push({ start: dot, end: m.end, text });
        bump(rule);
      };
      switch (name) {
        case 'array':
          if (kind === 'text' && m.arguments.length === 0) {
            replace('.$type<string[]>()', 'text[] -> $type<string[]>');
          } else {
            notCovered.push({ line: lineOf(m), construct: `array() sur ${builder}()` });
          }
          break;
        case 'defaultNow':
          if (kind === 'timestamp') {
            needSql = true;
            replace(`.default(${NOW_MS_SQL})`, 'defaultNow -> default(sql)');
          } else {
            notCovered.push({ line: lineOf(m), construct: `defaultNow() sur ${builder}()` });
          }
          break;
        case 'defaultRandom':
          if (kind === 'uuid') {
            replace('.$defaultFn(() => crypto.randomUUID())', 'defaultRandom -> $defaultFn');
          } else {
            notCovered.push({ line: lineOf(m), construct: `defaultRandom() sur ${builder}()` });
          }
          break;
        case 'primaryKey':
          if (kind === 'serial' && m.arguments.length === 0) {
            replace('.primaryKey({ autoIncrement: true })', 'serial primaryKey -> autoIncrement');
          }
          break;
        case 'default':
          if (kind === 'jsonb' || (kind === 'text' && hasArray)) {
            review.push({
              line: lineOf(m),
              construct: 'default() sur colonne json : valeur a verifier',
            });
          }
          break;
        default:
          break;
      }
    }
  };

  // Pass 1: walk the file once, collecting edits.
  const walk = (node: ts.Node): void => {
    if (
      node.pos >= pgImportNode.pos &&
      node.end <= pgImportNode.end &&
      node.kind !== ts.SyntaxKind.SourceFile
    ) {
      return;
    }
    if (ts.isIdentifier(node) && node.text === 'pgTable') {
      edits.push({ start: node.getStart(sf), end: node.end, text: 'sqliteTable' });
      bump('pgTable -> sqliteTable');
    } else if (ts.isIdentifier(node) && node.text === 'AnyPgColumn') {
      edits.push({ start: node.getStart(sf), end: node.end, text: 'AnySQLiteColumn' });
      bump('AnyPgColumn -> AnySQLiteColumn');
    }

    if (ts.isCallExpression(node)) {
      // pg index columns take `col.desc()`; sqlite takes the drizzle helper `desc(col)`.
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.arguments.length === 0 &&
        (node.expression.name.text === 'desc' || node.expression.name.text === 'asc')
      ) {
        const fn = node.expression.name.text;
        edits.push({
          start: node.getStart(sf),
          end: node.end,
          text: `${fn}(${textOf(node.expression.expression)})`,
        });
        needFns.add(fn);
        bump(`${fn}() column -> ${fn}(column)`);
      }
      if (ts.isIdentifier(node.expression) && pgNames.has(node.expression.text)) {
        const builder = node.expression.text;
        if (BUILDER_KIND[builder] !== undefined) {
          handleColumn(node, builder);
        } else if (builder === 'check') {
          review.push({
            line: lineOf(node),
            construct: 'check() : CHECK passe tel quel, a verifier',
          });
          bump('check (passe tel quel)');
        }
      }
      if (ts.isPropertyAccessExpression(node.expression)) {
        const name = node.expression.name.text;
        if (name === 'where') {
          review.push({
            line: lineOf(node),
            construct: '.where() : index partiel, passe tel quel',
          });
          bump('index partiel (passe tel quel)');
        } else if (PG_ONLY_METHODS.has(name)) {
          notCovered.push({ line: lineOf(node), construct: `.${name}() (pg only)` });
        }
      }
    }

    if (
      ts.isTaggedTemplateExpression(node) &&
      ts.isIdentifier(node.tag) &&
      node.tag.text === 'sql'
    ) {
      const raw = textOf(node);
      const line = lineOf(node);
      bump('sql`` (passe tel quel)');
      review.push({ line, construct: 'sql`` brut (CHECK, index, WHERE ou default)' });
      for (const [pattern, reason] of SQL_UNSUPPORTED) {
        if (pattern.test(raw)) notCovered.push({ line, construct: reason });
      }
      let rewritten = raw;
      for (const [fn, op, rule] of SQL_LEAST_GREATEST) {
        const re = new RegExp(
          `\\b${fn}\\(\\s*(\\$\\{[^}]+\\})\\s*,\\s*(\\$\\{[^}]+\\})\\s*\\)`,
          'g',
        );
        if (re.test(rewritten)) {
          rewritten = rewritten.replace(
            re,
            (_m, a: string, b: string) => `CASE WHEN ${a} ${op} ${b} THEN ${a} ELSE ${b} END`,
          );
          bump(rule);
          review.push({ line, construct: `${rule} : NULL semantics differ, a verifier` });
        }
        if (new RegExp(`\\b${fn}\\(`).test(rewritten)) {
          notCovered.push({ line, construct: `${fn}() with other than two placeholder arguments` });
        }
      }
      for (const [pattern, to, rule] of SQL_FN_REWRITES) {
        const re = new RegExp(pattern, 'g');
        if (re.test(rewritten)) {
          rewritten = rewritten.replace(new RegExp(pattern, 'g'), to);
          bump(rule);
        }
      }
      if (rewritten !== raw) {
        edits.push({ start: node.getStart(sf), end: node.end, text: rewritten });
      }
    }

    ts.forEachChild(node, walk);
  };
  walk(sf);

  // Pass 2: the import from pg-core becomes the import from sqlite-core.
  const names: string[] = [];
  const seen = new Set<string>();
  const clause = pgImportNode.importClause?.namedBindings;
  if (clause && ts.isNamedImports(clause)) {
    for (const el of clause.elements) {
      const original = (el.propertyName ?? el.name).text;
      const mapped = IMPORT_MAP[original];
      if (mapped === undefined) {
        notCovered.push({
          line: lineOf(el),
          construct: `import ${original} de pg-core : pas d'equivalent sqlite-core (non converti)`,
        });
      }
      const outName = mapped ?? original;
      if (!seen.has(outName)) {
        seen.add(outName);
        names.push(`${el.isTypeOnly ? 'type ' : ''}${outName}`);
      }
    }
  }
  const importLines = [`import { ${names.join(', ')} } from 'drizzle-orm/sqlite-core';`];

  // Helpers the rewrite emits from drizzle-orm: `sql` for SQL defaults, asc/desc for index columns.
  const wanted = [...(needSql ? ['sql'] : []), ...needFns].filter((n) => !drizzleNames.has(n));
  if (wanted.length > 0 && drizzleImport) {
    const existing = drizzleImport.elements.map((el) => el.getText(sf));
    const drizzleDecl = drizzleImport.parent.parent;
    edits.push({
      start: drizzleDecl.getStart(sf),
      end: drizzleDecl.end,
      text: `import { ${[...existing, ...wanted].join(', ')} } from 'drizzle-orm';`,
    });
  } else if (wanted.length > 0) {
    importLines.push(`import { ${wanted.join(', ')} } from 'drizzle-orm';`);
  }
  edits.push({
    start: pgImportNode.getStart(sf),
    end: pgImportNode.end,
    text: importLines.join('\n'),
  });

  // Apply edits from the end of the file, refusing overlapping ranges.
  edits.sort((a, b) => b.start - a.start);
  let output = source;
  let limit = Number.POSITIVE_INFINITY;
  for (const e of edits) {
    if (e.end > limit) throw new Error(`codemod: overlapping edits at offset ${e.start}`);
    output = output.slice(0, e.start) + e.text + output.slice(e.end);
    limit = e.start;
  }

  return { output, counts, notCovered, review };
}

function main(argv: string[]): void {
  const write = argv.includes('--write');
  const verbose = argv.includes('--verbose');
  const files = argv.filter((a) => !a.startsWith('--'));
  for (const file of files) {
    const result = convertSchemaSource(readFileSync(file, 'utf8'), file);
    console.log(`== ${file}`);
    for (const [rule, n] of Object.entries(result.counts))
      console.log(`  ${n.toString().padStart(4)}  ${rule}`);
    console.log(`  not covered: ${result.notCovered.length}, review: ${result.review.length}`);
    for (const f of result.notCovered)
      console.log(`  NOT COVERED ${file}:${f.line} ${f.construct}`);
    if (verbose)
      for (const f of result.review) console.log(`  review ${file}:${f.line} ${f.construct}`);
    if (write) writeFileSync(file, result.output);
  }
}

if (import.meta.main) main(process.argv.slice(2));
