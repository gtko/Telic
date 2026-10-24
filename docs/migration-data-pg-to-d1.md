# Migration des données Postgres vers D1 (ODY-296, lot L8)

Procédure de bascule des données de production de Postgres vers Cloudflare D1. Le script
est `scripts/pg-to-d1/main.ts`. Le schéma cible est celui de `packages/db/drizzle-d1/` (baseline
`0000_*.sql`, 103 tables), le mapping des types est décrit dans `packages/db/PORTING_NOTES.md`.

Ce document décrit ce que fait le script et ce qu'il ne fait pas. Les décisions encore ouvertes
sont listées en fin de document, avant toute bascule.

## Principes

- La source n'est jamais modifiée. La lecture se fait dans une seule transaction
  `REPEATABLE READ READ ONLY` : toutes les tables proviennent du même instantané, et Postgres
  refuse toute écriture pendant la lecture.
- L'URL Postgres vient de la variable d'environnement `PG_SOURCE_URL` (ou `--source-env`). Elle
  n'apparaît ni en argument, ni dans les journaux, ni dans les fichiers produits.
- Les écritures passent par `wrangler d1 execute --file`. Le script n'écrit en distant que si
  `--target remote` **et** `PG_TO_D1_ALLOW_REMOTE=1` sont tous deux donnés.
- Chaque fichier SQL a une empreinte SHA-256 dans le manifest, vérifiée avant application.
- Les instructions sont rejouables : une ligne déjà présente est ignorée (`NOT EXISTS` sur la
  clé primaire), un morceau de gros texte n'est ajouté que si la longueur attendue correspond, et
  les clés étrangères vers la même table sont fixées par UPDATE après insertion. Rejouer un fichier
  déjà appliqué ne duplique rien.

## Étapes du script

| Étape | Commande | Effet |
| --- | --- | --- |
| Extraction | `extract` | Lit la source, transforme, écrit `sql/NNNN.sql`, `manifest.json`, `blobs/` |
| Application | `apply` | Applique les fichiers dans l'ordre, un point de reprise (`checkpoint.json`) après chacun |
| Vérification | `validate` | Compare le nombre de lignes et l'empreinte d'un échantillon à la cible, écrit `report.json` |
| Tout | `run` | Enchaîne extraction, application et vérification. `--dry-run` s'arrête après l'extraction |

Le dossier de travail (`--work-dir`, par défaut `scripts/pg-to-d1/.work/`, ignoré par git)
contient tout l'état. `run --resume` reprend un dossier existant ; sans `--resume`, un dossier non
vide est refusé.

### Mapping

| Postgres | D1 | Remarque |
| --- | --- | --- |
| `timestamp` / `timestamptz` | `integer` (epoch ms) | Ramené à la milliseconde inférieure. Un `timestamp` sans fuseau est lu comme UTC |
| `date` | `text` ISO `YYYY-MM-DD` | |
| `jsonb` / `json` | `text` JSON | Réécrit en forme compacte : l'ordre des clés suit `jsonb` (tri interne Postgres) |
| `text[]` | `text` JSON tableau | Éléments `NULL` conservés en `null` |
| `uuid`, `text`, `varchar` | `text` | |
| `boolean` | `integer` 0/1 | |
| `integer`, `bigint`, `serial` | `integer` | Refusé au-delà de 2^53 |
| `numeric`, `double precision` | `real` | `numeric` perd sa précision décimale exacte |

Un type Postgres non prévu fait échouer l'extraction, sauf s'il concerne une colonne absente de la
cible : celle-ci est écartée et listée dans le rapport (`droppedColumns`). Les tables absentes de
la cible sont listées dans `ignoredSourceTables`.

### Limites D1 et leur traitement

- 100 valeurs liées par requête : le script regroupe au plus `100 / nombre de colonnes` lignes par
  INSERT (les valeurs sont écrites en littéraux, la borne reste celle de D1).
- Taille d'une instruction : `--max-statement-bytes` (défaut 100 000). Une ligne plus grande
  est découpée : son gros texte est inséré vide, puis complété par des UPDATE de 32 Ko.
  **Valeur à valider contre D1 distant** avant la bascule.
- 2 Mo par ligne : une ligne plus grande n'est **pas écrite**. Elle est listée dans
  `manifest.json` (`skipped`), et ses gros textes (au-delà de 100 Ko) sont écrits dans
  `blobs/` pour un dépôt éventuel dans R2. La validation attend donc `sourceRows - skippedRows`.
- Auto-références (`issue.parent_id`, `project_document.parent_id`, etc., 5 colonnes) : insérées
  à `NULL`, puis fixées par UPDATE une fois toutes les lignes présentes.
- Une ligne écartée qui est parente d'une autre ligne fait échouer l'application (clé étrangère).
  C'est voulu : la décision de traitement appartient à l'équipe, pas au script.

## Procédure de bascule

Les durées dépendent du volume. Les étapes 1 à 3 se font sur une copie, avant la fenêtre.

### 0. Préparer (hors fenêtre)

1. Vérifier que `packages/db/drizzle-d1` est appliqué sur la base D1 cible
   (`wrangler d1 migrations apply DB --remote`), et seulement là.
2. Répéter la procédure complète sur une base D1 de test, avec une copie récente de la production
   (`--target local` puis, si validé, une base D1 de préproduction). Noter les durées.
3. Vérifier les limites D1 sur la base distante (taille d'instruction, durée par fichier) et
   ajuster `--max-statement-bytes` et `--max-file-bytes` si nécessaire.

### 1. Geler les écritures

1. Mettre l'application en maintenance (plus aucune écriture dans Postgres). Les lectures peuvent
   continuer.
2. Noter l'heure du gel : elle sert de référence pour le retour arrière.

### 2. Extraire

```bash
export PG_SOURCE_URL='postgres://<lecture seule>@<hôte>/<base>?sslmode=require'
bun scripts/pg-to-d1/main.ts extract --work-dir /chemin/durable/pg-to-d1
```

Le manifest indique le nombre de fichiers, de lignes et de lignes écartées. Lire le
`manifest.json` (`ignoredSourceTables`, `absentFromSource`, `droppedColumns`, `skipped`) et valider
chaque élément avant d'aller plus loin.

### 3. Appliquer sur D1

```bash
export PG_TO_D1_ALLOW_REMOTE=1
bun scripts/pg-to-d1/main.ts apply --target remote --database DB --work-dir /chemin/durable/pg-to-d1
```

- Refusé si la cible contient déjà des lignes (premier passage). C'est le garde-fou contre un
  second import sur une base déjà remplie.
- En cas d'interruption : relancer la même commande. Les fichiers marqués `done` sont sautés, le
  fichier interrompu est rejoué (sans doublon).

### 4. Vérifier

```bash
bun scripts/pg-to-d1/main.ts validate --target remote --database DB --work-dir /chemin/durable/pg-to-d1
```

La vérification passe si, pour chaque table, le nombre de lignes cible égale `expectedRows` et si
les lignes de l'échantillon (20 par table, tirées au hasard de façon déterministe) ont la même
empreinte que dans la source. Le détail est dans `report.json`. Un écart arrête la bascule.

Vérifications complémentaires à faire à la main avant de rouvrir :

- l'application lit les données sur D1 (une page par domaine, un compte connu) ;
- les rattachements (`issue.parent_id`, membres d'équipe) sont cohérents ;
- les lignes écartées sont traitées (voir la section « Points ouverts »).

### 5. Rouvrir, ou revenir en arrière

- **Retour arrière avant ouverture** : Postgres n'a pas été modifié. Relancer l'ancienne version de
  l'application sur Postgres et lever la maintenance. Les écritures faites sur D1 pendant le test
  sont perdues, c'est pourquoi la fenêtre ne s'ouvre qu'après l'étape 4.
- **Retour arrière après ouverture** : les écritures faites sur D1 ne sont pas recopiées vers
  Postgres par ce script. Le retour arrière n'est sûr qu'avant la première écriture utilisateur.
  Au-delà, c'est une décision de reprise, pas une procédure.
- Une fois l'application stable sur D1, Time Travel de D1 couvre les restaurations de la base
  distante.

## Points ouverts (à trancher avant la bascule)

1. **Lignes au-delà de 2 Mo** : aucune décision sur le format du pointeur R2 ni sur l'accès
   applicatif. Le script ne fait qu'écrire `blobs/` et lister les lignes.
2. **Déclencheurs de révision** (`docs/dev/revision-engine.md`) : les triggers Postgres ne sont
   pas dans la baseline D1. Les compteurs `revision` sont copiés tels quels, mais ne bougent plus
   après la bascule tant que les triggers D1 ne sont pas écrits (lot dédié).
3. **Précision `numeric`** : perdue en `real`. Acceptable si aucun calcul monétaire ne repose dessus
   (à confirmer par le domaine).
4. **Fuseau des `timestamp` sans fuseau** : lus comme UTC. Vérifier que l'application les écrivait
   en UTC.
5. **Données de seed** : elles sont dans la base Postgres (migrations 0046, 0119, 0155, etc.) et
   partent avec la copie. Une installation neuve sans copie n'a pas ces seeds : étape à prévoir.
6. **Limites D1 distantes** : `--max-statement-bytes` (100 000 par défaut) et le comportement de
   `wrangler d1 execute --file --remote` sur un fichier de plusieurs dizaines de Mo ne sont pas
   vérifiés sur la base distante.
7. **Débit** : le regroupement par 100 valeurs liées donne peu de lignes par instruction pour les
   tables larges. Mesurer sur la préproduction avant de fixer une durée de fenêtre.

## Tests

`bun test scripts/pg-to-d1` exécute :

- les tests unitaires (mapping des types, littéraux SQL, découpage des gros textes, regroupement,
  ordre des tables, croisement des schémas) ;
- une copie complète d'un jeu de données de test : Postgres en mémoire (PGlite, joué sur le
  protocole réseau, donc lu par le vrai client `postgres`) vers une D1 locale (wrangler `--local`).
  Il vérifie les comptes, l'écart attendu d'une ligne de 2 Mo, les conversions, l'auto-référence,
  le gros texte découpé, la reprise sans doublon, le refus sur cible non vide et la détection d'une
  ligne retirée ;
- l'ordre des tables sur le schéma réel de `packages/db` (103 tables, sans cycle).

Ces tests ne lisent pas la base de production et n'écrivent jamais en distant.
