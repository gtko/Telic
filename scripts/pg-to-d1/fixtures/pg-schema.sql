-- Schéma source de test (dialecte Postgres). Couvre les types mappés, une auto-référence,
-- une clé composite, une colonne écartée (tsvector, bytea) et une table absente de la cible.
CREATE TABLE team (
  id integer PRIMARY KEY,
  name text NOT NULL,
  created_at timestamp with time zone NOT NULL,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL,
  tags text[],
  starts_on date,
  score numeric(10,2),
  ref uuid NOT NULL,
  legacy_blob bytea,
  search_vector tsvector
);

CREATE TABLE app_user (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  created_at timestamp NOT NULL,
  roles text[] NOT NULL,
  big_counter bigint NOT NULL,
  ratio double precision
);

CREATE TABLE team_member (
  team_id integer NOT NULL REFERENCES team(id),
  user_id uuid NOT NULL REFERENCES app_user(id),
  joined_on date NOT NULL,
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE issue (
  id bigint PRIMARY KEY,
  team_id integer NOT NULL REFERENCES team(id),
  parent_id bigint REFERENCES issue(id),
  title text NOT NULL,
  body text NOT NULL,
  estimate numeric,
  done boolean NOT NULL,
  meta jsonb
);

CREATE TABLE doc (
  id text PRIMARY KEY,
  body text NOT NULL
);

CREATE TABLE pg_only_audit (
  id serial PRIMARY KEY,
  note text
);
