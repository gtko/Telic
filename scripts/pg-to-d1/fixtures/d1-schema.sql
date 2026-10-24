-- Schéma cible de test (dialecte SQLite / D1). audit_empty n'existe pas dans la source.
CREATE TABLE team (
  id integer PRIMARY KEY NOT NULL,
  name text NOT NULL,
  created_at integer NOT NULL,
  settings text NOT NULL,
  is_active integer NOT NULL,
  tags text,
  starts_on text,
  score real,
  ref text NOT NULL
);

CREATE TABLE app_user (
  id text PRIMARY KEY NOT NULL,
  email text NOT NULL,
  created_at integer NOT NULL,
  roles text NOT NULL,
  big_counter integer NOT NULL,
  ratio real
);

CREATE TABLE team_member (
  team_id integer NOT NULL REFERENCES team(id),
  user_id text NOT NULL REFERENCES app_user(id),
  joined_on text NOT NULL,
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE issue (
  id integer PRIMARY KEY NOT NULL,
  team_id integer NOT NULL REFERENCES team(id),
  parent_id integer REFERENCES issue(id),
  title text NOT NULL,
  body text NOT NULL,
  estimate real,
  done integer NOT NULL,
  meta text
);

CREATE TABLE doc (
  id text PRIMARY KEY NOT NULL,
  body text NOT NULL
);

CREATE TABLE audit_empty (
  id integer PRIMARY KEY NOT NULL
);
