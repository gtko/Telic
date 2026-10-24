#!/usr/bin/env bun
// Copie des données de production Postgres vers Cloudflare D1 (ODY-296, lot L8).
// Procédure de bascule : docs/migration-data-pg-to-d1.md.
//
//   bun scripts/pg-to-d1/main.ts run --dry-run          génère les SQL, n'écrit rien dans D1
//   bun scripts/pg-to-d1/main.ts run                    génère, applique (local par défaut), vérifie
//   bun scripts/pg-to-d1/main.ts validate               compare la cible au manifest
//
// L'URL Postgres se lit dans une variable d'environnement (PG_SOURCE_URL par défaut), jamais en
// argument ni dans les journaux. La lecture se fait en transaction READ ONLY.
import { parseArgs } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type D1Target, resolveWranglerBin } from './d1.ts';
import { apply, extract, run, type TableCheck, validate } from './pipeline.ts';
import { DEFAULT_MAX_STATEMENT_BYTES } from './sql.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

const USAGE = `usage : main.ts <extract|apply|validate|run> [options]

  --target local|remote        base cible (défaut : local)
  --database <binding>         binding D1 dans wrangler (défaut : DB)
  --config <fichier>           wrangler.jsonc (défaut : packages/db/wrangler.jsonc)
  --persist-to <dossier>       persistance de la base locale (local seulement)
  --work-dir <dossier>         dossier de travail (défaut : scripts/pg-to-d1/.work)
  --source-env <NOM>           variable contenant l'URL Postgres (défaut : PG_SOURCE_URL)
  --dry-run                    run : génère les fichiers SQL puis s'arrête
  --resume                     run : reprend un dossier de travail existant
  --max-file-bytes <n>         taille max d'un fichier SQL (défaut : 2097152)
  --max-statement-bytes <n>    taille max d'une instruction (défaut : ${DEFAULT_MAX_STATEMENT_BYTES})
  --sample-size <n>            lignes par table vérifiées par empreinte (défaut : 20)
  --page-size <n>              lignes lues par page (défaut : 1000)

  Écriture distante : --target remote ET PG_TO_D1_ALLOW_REMOTE=1. Hors de ce cadre, rien n'est envoyé à Cloudflare.`;

function integer(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new UsageError(`--${name} : entier positif attendu`);
  return n;
}

class UsageError extends Error {}

/** Libellé de la source sans identifiants : hôte, port et base seulement. */
function describeSource(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new UsageError('URL Postgres invalide (valeur non affichée)');
  }
  return `${u.hostname}:${u.port || '5432'}${u.pathname}`;
}

function printChecks(checks: TableCheck[]): void {
  const pad = (s: string | number, n: number) => String(s).padEnd(n);
  console.log(
    `${pad('table', 36)}${pad('lues', 9)}${pad('écartées', 10)}${pad('attendues', 10)}${pad('cible', 9)}${pad('empreintes', 12)}statut`,
  );
  for (const c of checks) {
    console.log(
      `${pad(c.name, 36)}${pad(c.sourceRows, 9)}${pad(c.skippedRows, 10)}${pad(c.expectedRows, 10)}${pad(
        Number.isNaN(c.targetRows) ? '?' : c.targetRows,
        9,
      )}${pad(`${c.samples - c.sampleMismatches}/${c.samples}`, 12)}${c.ok ? 'OK' : 'ÉCART'}`,
    );
  }
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      target: { type: 'string', default: 'local' },
      database: { type: 'string', default: 'DB' },
      config: { type: 'string' },
      'persist-to': { type: 'string' },
      'work-dir': { type: 'string' },
      'source-env': { type: 'string', default: 'PG_SOURCE_URL' },
      'dry-run': { type: 'boolean', default: false },
      resume: { type: 'boolean', default: false },
      'max-file-bytes': { type: 'string' },
      'max-statement-bytes': { type: 'string' },
      'sample-size': { type: 'string' },
      'page-size': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    console.log(USAGE);
    return command || values.help ? 0 : 2;
  }
  if (!['extract', 'apply', 'validate', 'run'].includes(command))
    throw new UsageError(`commande inconnue : ${command}`);
  if (values.target !== 'local' && values.target !== 'remote')
    throw new UsageError('--target : local ou remote');
  const remote = values.target === 'remote';
  if (remote && process.env.PG_TO_D1_ALLOW_REMOTE !== '1') {
    throw new UsageError(
      'écriture distante refusée : définir PG_TO_D1_ALLOW_REMOTE=1 (et --target remote)',
    );
  }
  const sourceEnv = values['source-env'];
  const target: D1Target = {
    remote,
    database: values.database,
    config: resolve(values.config ?? join(repoRoot, 'packages', 'db', 'wrangler.jsonc')),
    persistTo: values['persist-to'] ? resolve(values['persist-to']) : undefined,
    workDir: resolve(values['work-dir'] ?? join(here, '.work')),
    wranglerBin: resolveWranglerBin(repoRoot),
    hiddenEnv: [sourceEnv],
  };
  const needsSource = command === 'extract' || command === 'run';
  const sourceUrl = process.env[sourceEnv];
  if (needsSource && !sourceUrl) throw new UsageError(`${sourceEnv} absent de l'environnement`);
  const sourceLabel = sourceUrl ? describeSource(sourceUrl) : 'non fourni';
  const options = {
    workDir: target.workDir,
    target,
    maxFileBytes: integer(values['max-file-bytes'], 2 * 1024 * 1024, 'max-file-bytes'),
    maxStatementBytes: integer(
      values['max-statement-bytes'],
      DEFAULT_MAX_STATEMENT_BYTES,
      'max-statement-bytes',
    ),
    sampleSize: integer(values['sample-size'], 20, 'sample-size'),
    pageSize: integer(values['page-size'], 1000, 'page-size'),
    sourceLabel,
    log: (line: string) => console.log(line),
  };

  if (command === 'extract') {
    const m = await extract({ ...options, sourceUrl: sourceUrl! });
    console.log(`manifest : ${join(target.workDir, 'manifest.json')}`);
    console.log(
      `fichiers SQL : ${m.files.length} (${m.files.reduce((n, f) => n + f.rows, 0)} lignes)`,
    );
    console.log(`lignes écartées (> 2 Mo) : ${m.skipped.length}`);
    return 0;
  }
  if (command === 'apply') {
    await apply(options);
    return 0;
  }
  if (command === 'validate') {
    const v = await validate(options);
    printChecks(v.tables);
    console.log(v.ok ? 'VÉRIFICATION OK' : 'VÉRIFICATION EN ÉCHEC');
    return v.ok ? 0 : 1;
  }
  const r = await run({
    ...options,
    sourceUrl: sourceUrl ?? '',
    dryRun: values['dry-run'],
    resume: values.resume,
  });
  if (!r.validation) {
    console.log("génération terminée (--dry-run) : rien n'a été écrit dans la cible");
    return 0;
  }
  printChecks(r.validation.tables);
  console.log(r.validation.ok ? 'VÉRIFICATION OK' : 'VÉRIFICATION EN ÉCHEC');
  return r.validation.ok ? 0 : 1;
}

const isEntry =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      if (err instanceof UsageError) console.error(`${err.message}\n\n${USAGE}`);
      else console.error(`erreur : ${err instanceof Error ? err.message : String(err)}`);
      process.exit(err instanceof UsageError ? 2 : 1);
    });
}
