-- SQLite (D1) port of the 30 Postgres triggers / 20 functions of legacy-pg/drizzle
-- (0070, 0098, 0113, 0118, 0125, 0126, 0129, 0142, 0152). Applied by `wrangler d1 migrations
-- apply` and by migrateD1 (drizzle journal entry 0001_triggers). HAND-MAINTAINED: drizzle-kit
-- never emits triggers, and when it rebuilds a table (DROP + CREATE + copy) the triggers of that
-- table disappear. Any migration that rebuilds a table listed here must re-create its triggers;
-- src/__tests__/triggers.test.ts counts and names them after a full migration to catch a loss.
--
-- What changed against Postgres
--   * SQLite triggers are per operation: a pg `AFTER INSERT OR UPDATE OR DELETE` trigger `x` is
--     three triggers `x_i`, `x_u`, `x_d` here (the test strips the suffix and compares with the
--     30 pg names).
--   * No functions: `bump_rev(scope, project)` is inlined as INSERT ... SELECT ... WHERE ...
--     ON CONFLICT (scope) DO UPDATE SET rev = rev + 1. A conditional bump puts its condition in WHERE.
--   * No lock-ordering rules (D1 serializes writers), so the "board, issue, initiative" and
--     "ids in order" comments of the pg version no longer constrain anything.
--   * `project_rev_cleanup` was a DEFERRABLE INITIALLY DEFERRED constraint trigger. SQLite has no
--     deferred triggers: it is a plain AFTER DELETE ON project (SQLite runs the FK cascades of the
--     parent row before its AFTER triggers, so every cascaded child delete has already fired), and
--     the bumps that fire on delete paths are guarded with EXISTS (project) so a cascade from a
--     deleted project does not re-create revision rows for it.
--   * BEFORE triggers cannot change NEW in SQLite: `project_document_owner_default` is an AFTER
--     INSERT that UPDATEs owner_user_id; the snapshot trigger copes with either firing order.
--   * `current_setting('app.document_rebalance' | 'app.document_checkpoint')` became rows of the
--     `trigger_flag` table (see its comment in schema/app.ts).
--   * Snapshot merge (10 minutes, same author) deletes the previous snapshot and inserts the new
--     one instead of updating it in place: the row keeps no stable id, nothing references it.
--   * RAISE(ABORT) replaces RAISE EXCEPTION ... ERRCODE 23514 in the two project validations.

-- rev_issue (0070, 0142): board + issue + initiative markers; a move between projects
-- bumps both boards and re-homes the issue scope
CREATE TRIGGER issue_rev_i AFTER INSERT ON issue FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'board:' || NEW.project_id, NEW.project_id, 1 WHERE 1
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'issue:' || NEW.id, NEW.project_id, 1 WHERE 1
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || NEW.initiative_id, NEW.project_id, 1 WHERE NEW.initiative_id IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER issue_rev_u AFTER UPDATE ON issue FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'board:' || NEW.project_id, NEW.project_id, 1 WHERE 1
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'board:' || OLD.project_id, OLD.project_id, 1 WHERE OLD.project_id <> NEW.project_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  UPDATE revision SET project_id = NEW.project_id
    WHERE scope = 'issue:' || NEW.id AND OLD.project_id <> NEW.project_id;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'issue:' || NEW.id, NEW.project_id, 1 WHERE 1
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || NEW.initiative_id, NEW.project_id, 1 WHERE NEW.initiative_id IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || OLD.initiative_id, NEW.project_id, 1 WHERE OLD.initiative_id IS NOT NULL AND OLD.initiative_id IS NOT NEW.initiative_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER issue_rev_d AFTER DELETE ON issue FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'board:' || OLD.project_id, OLD.project_id, 1 WHERE EXISTS (SELECT 1 FROM project WHERE id = OLD.project_id)
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  DELETE FROM revision WHERE scope = 'issue:' || OLD.id;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || OLD.initiative_id, OLD.project_id, 1 WHERE OLD.initiative_id IS NOT NULL AND EXISTS (SELECT 1 FROM project WHERE id = OLD.project_id)
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

-- rev_issue_child (0070, 0098, 0113): rows that belong to an issue; a child whose issue is
-- already gone (cascade) bumps nothing
CREATE TRIGGER issue_label_rev_i AFTER INSERT ON issue_label FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'board:' || s.project_id, s.project_id, 1 FROM issue s WHERE s.id = NEW.issue_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'issue:' || s.id, s.project_id, 1 FROM issue s WHERE s.id = NEW.issue_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || s.initiative_id, s.project_id, 1 FROM issue s WHERE s.id = NEW.issue_id AND s.initiative_id IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER issue_label_rev_u AFTER UPDATE ON issue_label FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'board:' || s.project_id, s.project_id, 1 FROM issue s WHERE s.id = NEW.issue_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'issue:' || s.id, s.project_id, 1 FROM issue s WHERE s.id = NEW.issue_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || s.initiative_id, s.project_id, 1 FROM issue s WHERE s.id = NEW.issue_id AND s.initiative_id IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER issue_label_rev_d AFTER DELETE ON issue_label FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'board:' || s.project_id, s.project_id, 1 FROM issue s WHERE s.id = OLD.issue_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'issue:' || s.id, s.project_id, 1 FROM issue s WHERE s.id = OLD.issue_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || s.initiative_id, s.project_id, 1 FROM issue s WHERE s.id = OLD.issue_id AND s.initiative_id IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER issue_link_rev_i AFTER INSERT ON issue_link FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'board:' || s.project_id, s.project_id, 1 FROM issue s WHERE s.id = NEW.source_issue_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'issue:' || s.id, s.project_id, 1 FROM issue s WHERE s.id = NEW.source_issue_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || s.initiative_id, s.project_id, 1 FROM issue s WHERE s.id = NEW.source_issue_id AND s.initiative_id IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER issue_link_rev_u AFTER UPDATE ON issue_link FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'board:' || s.project_id, s.project_id, 1 FROM issue s WHERE s.id = NEW.source_issue_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'issue:' || s.id, s.project_id, 1 FROM issue s WHERE s.id = NEW.source_issue_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || s.initiative_id, s.project_id, 1 FROM issue s WHERE s.id = NEW.source_issue_id AND s.initiative_id IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER issue_link_rev_d AFTER DELETE ON issue_link FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'board:' || s.project_id, s.project_id, 1 FROM issue s WHERE s.id = OLD.source_issue_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'issue:' || s.id, s.project_id, 1 FROM issue s WHERE s.id = OLD.source_issue_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || s.initiative_id, s.project_id, 1 FROM issue s WHERE s.id = OLD.source_issue_id AND s.initiative_id IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER issue_field_value_rev_i AFTER INSERT ON issue_field_value FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'board:' || s.project_id, s.project_id, 1 FROM issue s WHERE s.id = NEW.issue_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'issue:' || s.id, s.project_id, 1 FROM issue s WHERE s.id = NEW.issue_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || s.initiative_id, s.project_id, 1 FROM issue s WHERE s.id = NEW.issue_id AND s.initiative_id IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER issue_field_value_rev_u AFTER UPDATE ON issue_field_value FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'board:' || s.project_id, s.project_id, 1 FROM issue s WHERE s.id = NEW.issue_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'issue:' || s.id, s.project_id, 1 FROM issue s WHERE s.id = NEW.issue_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || s.initiative_id, s.project_id, 1 FROM issue s WHERE s.id = NEW.issue_id AND s.initiative_id IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER issue_field_value_rev_d AFTER DELETE ON issue_field_value FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'board:' || s.project_id, s.project_id, 1 FROM issue s WHERE s.id = OLD.issue_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'issue:' || s.id, s.project_id, 1 FROM issue s WHERE s.id = OLD.issue_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || s.initiative_id, s.project_id, 1 FROM issue s WHERE s.id = OLD.issue_id AND s.initiative_id IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER issue_field_option_rev_i AFTER INSERT ON issue_field_option FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'board:' || s.project_id, s.project_id, 1 FROM issue s WHERE s.id = NEW.issue_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'issue:' || s.id, s.project_id, 1 FROM issue s WHERE s.id = NEW.issue_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || s.initiative_id, s.project_id, 1 FROM issue s WHERE s.id = NEW.issue_id AND s.initiative_id IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER issue_field_option_rev_u AFTER UPDATE ON issue_field_option FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'board:' || s.project_id, s.project_id, 1 FROM issue s WHERE s.id = NEW.issue_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'issue:' || s.id, s.project_id, 1 FROM issue s WHERE s.id = NEW.issue_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || s.initiative_id, s.project_id, 1 FROM issue s WHERE s.id = NEW.issue_id AND s.initiative_id IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER issue_field_option_rev_d AFTER DELETE ON issue_field_option FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'board:' || s.project_id, s.project_id, 1 FROM issue s WHERE s.id = OLD.issue_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'issue:' || s.id, s.project_id, 1 FROM issue s WHERE s.id = OLD.issue_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || s.initiative_id, s.project_id, 1 FROM issue s WHERE s.id = OLD.issue_id AND s.initiative_id IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER issue_attachment_rev_i AFTER INSERT ON issue_attachment FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'issue:' || s.id, s.project_id, 1 FROM issue s WHERE s.id = NEW.issue_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || s.initiative_id, s.project_id, 1 FROM issue s WHERE s.id = NEW.issue_id AND s.initiative_id IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER issue_attachment_rev_u AFTER UPDATE ON issue_attachment FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'issue:' || s.id, s.project_id, 1 FROM issue s WHERE s.id = NEW.issue_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || s.initiative_id, s.project_id, 1 FROM issue s WHERE s.id = NEW.issue_id AND s.initiative_id IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER issue_attachment_rev_d AFTER DELETE ON issue_attachment FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'issue:' || s.id, s.project_id, 1 FROM issue s WHERE s.id = OLD.issue_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || s.initiative_id, s.project_id, 1 FROM issue s WHERE s.id = OLD.issue_id AND s.initiative_id IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER issue_checklist_rev_i AFTER INSERT ON issue_checklist FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'issue:' || s.id, s.project_id, 1 FROM issue s WHERE s.id = NEW.issue_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || s.initiative_id, s.project_id, 1 FROM issue s WHERE s.id = NEW.issue_id AND s.initiative_id IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER issue_checklist_rev_u AFTER UPDATE ON issue_checklist FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'issue:' || s.id, s.project_id, 1 FROM issue s WHERE s.id = NEW.issue_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || s.initiative_id, s.project_id, 1 FROM issue s WHERE s.id = NEW.issue_id AND s.initiative_id IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER issue_checklist_rev_d AFTER DELETE ON issue_checklist FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'issue:' || s.id, s.project_id, 1 FROM issue s WHERE s.id = OLD.issue_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || s.initiative_id, s.project_id, 1 FROM issue s WHERE s.id = OLD.issue_id AND s.initiative_id IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER issue_watcher_rev_i AFTER INSERT ON issue_watcher FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'issue:' || s.id, s.project_id, 1 FROM issue s WHERE s.id = NEW.issue_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || s.initiative_id, s.project_id, 1 FROM issue s WHERE s.id = NEW.issue_id AND s.initiative_id IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER issue_watcher_rev_u AFTER UPDATE ON issue_watcher FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'issue:' || s.id, s.project_id, 1 FROM issue s WHERE s.id = NEW.issue_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || s.initiative_id, s.project_id, 1 FROM issue s WHERE s.id = NEW.issue_id AND s.initiative_id IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER issue_watcher_rev_d AFTER DELETE ON issue_watcher FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'issue:' || s.id, s.project_id, 1 FROM issue s WHERE s.id = OLD.issue_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || s.initiative_id, s.project_id, 1 FROM issue s WHERE s.id = OLD.issue_id AND s.initiative_id IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER issue_cycle_rev_i AFTER INSERT ON issue_cycle FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'issue:' || s.id, s.project_id, 1 FROM issue s WHERE s.id = NEW.issue_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || s.initiative_id, s.project_id, 1 FROM issue s WHERE s.id = NEW.issue_id AND s.initiative_id IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER issue_cycle_rev_u AFTER UPDATE ON issue_cycle FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'issue:' || s.id, s.project_id, 1 FROM issue s WHERE s.id = NEW.issue_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || s.initiative_id, s.project_id, 1 FROM issue s WHERE s.id = NEW.issue_id AND s.initiative_id IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER issue_cycle_rev_d AFTER DELETE ON issue_cycle FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'issue:' || s.id, s.project_id, 1 FROM issue s WHERE s.id = OLD.issue_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || s.initiative_id, s.project_id, 1 FROM issue s WHERE s.id = OLD.issue_id AND s.initiative_id IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER issue_development_link_rev_i AFTER INSERT ON issue_development_link FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'issue:' || s.id, s.project_id, 1 FROM issue s WHERE s.id = NEW.issue_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || s.initiative_id, s.project_id, 1 FROM issue s WHERE s.id = NEW.issue_id AND s.initiative_id IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER issue_development_link_rev_u AFTER UPDATE ON issue_development_link FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'issue:' || s.id, s.project_id, 1 FROM issue s WHERE s.id = NEW.issue_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || s.initiative_id, s.project_id, 1 FROM issue s WHERE s.id = NEW.issue_id AND s.initiative_id IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER issue_development_link_rev_d AFTER DELETE ON issue_development_link FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'issue:' || s.id, s.project_id, 1 FROM issue s WHERE s.id = OLD.issue_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || s.initiative_id, s.project_id, 1 FROM issue s WHERE s.id = OLD.issue_id AND s.initiative_id IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

-- rev_checklist_item (0070): item -> checklist -> issue
CREATE TRIGGER issue_checklist_item_rev_i AFTER INSERT ON issue_checklist_item FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'issue:' || s.id, s.project_id, 1 FROM issue_checklist c JOIN issue s ON s.id = c.issue_id WHERE c.id = NEW.checklist_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || s.initiative_id, s.project_id, 1 FROM issue_checklist c JOIN issue s ON s.id = c.issue_id WHERE c.id = NEW.checklist_id AND s.initiative_id IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER issue_checklist_item_rev_u AFTER UPDATE ON issue_checklist_item FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'issue:' || s.id, s.project_id, 1 FROM issue_checklist c JOIN issue s ON s.id = c.issue_id WHERE c.id = NEW.checklist_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || s.initiative_id, s.project_id, 1 FROM issue_checklist c JOIN issue s ON s.id = c.issue_id WHERE c.id = NEW.checklist_id AND s.initiative_id IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER issue_checklist_item_rev_d AFTER DELETE ON issue_checklist_item FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'issue:' || s.id, s.project_id, 1 FROM issue_checklist c JOIN issue s ON s.id = c.issue_id WHERE c.id = OLD.checklist_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || s.initiative_id, s.project_id, 1 FROM issue_checklist c JOIN issue s ON s.id = c.issue_id WHERE c.id = OLD.checklist_id AND s.initiative_id IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

-- rev_issue_development_check (0113): check -> link -> issue
CREATE TRIGGER issue_development_check_rev_i AFTER INSERT ON issue_development_check FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'issue:' || s.id, s.project_id, 1 FROM issue_development_link l JOIN issue s ON s.id = l.issue_id WHERE l.id = NEW.development_link_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || s.initiative_id, s.project_id, 1 FROM issue_development_link l JOIN issue s ON s.id = l.issue_id WHERE l.id = NEW.development_link_id AND s.initiative_id IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER issue_development_check_rev_u AFTER UPDATE ON issue_development_check FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'issue:' || s.id, s.project_id, 1 FROM issue_development_link l JOIN issue s ON s.id = l.issue_id WHERE l.id = NEW.development_link_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || s.initiative_id, s.project_id, 1 FROM issue_development_link l JOIN issue s ON s.id = l.issue_id WHERE l.id = NEW.development_link_id AND s.initiative_id IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER issue_development_check_rev_d AFTER DELETE ON issue_development_check FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'issue:' || s.id, s.project_id, 1 FROM issue_development_link l JOIN issue s ON s.id = l.issue_id WHERE l.id = OLD.development_link_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || s.initiative_id, s.project_id, 1 FROM issue_development_link l JOIN issue s ON s.id = l.issue_id WHERE l.id = OLD.development_link_id AND s.initiative_id IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

-- rev_activity (0070): a timeline row belongs to an issue or, failing that, an initiative;
-- never moves the board
CREATE TRIGGER issue_activity_rev_i AFTER INSERT ON issue_activity FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'issue:' || s.id, s.project_id, 1 FROM issue s WHERE s.id = NEW.issue_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || s.initiative_id, s.project_id, 1 FROM issue s WHERE s.id = NEW.issue_id AND s.initiative_id IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || i.id, i.project_id, 1 FROM initiative i WHERE i.id = NEW.initiative_id AND NEW.issue_id IS NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER issue_activity_rev_u AFTER UPDATE ON issue_activity FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'issue:' || s.id, s.project_id, 1 FROM issue s WHERE s.id = NEW.issue_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || s.initiative_id, s.project_id, 1 FROM issue s WHERE s.id = NEW.issue_id AND s.initiative_id IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || i.id, i.project_id, 1 FROM initiative i WHERE i.id = NEW.initiative_id AND NEW.issue_id IS NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER issue_activity_rev_d AFTER DELETE ON issue_activity FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'issue:' || s.id, s.project_id, 1 FROM issue s WHERE s.id = OLD.issue_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || s.initiative_id, s.project_id, 1 FROM issue s WHERE s.id = OLD.issue_id AND s.initiative_id IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || i.id, i.project_id, 1 FROM initiative i WHERE i.id = OLD.initiative_id AND OLD.issue_id IS NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

-- rev_initiative (0070): each board issue carries its initiative name, so the board moves too
CREATE TRIGGER initiative_rev_i AFTER INSERT ON initiative FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'board:' || NEW.project_id, NEW.project_id, 1 WHERE 1
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || NEW.id, NEW.project_id, 1 WHERE 1
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER initiative_rev_u AFTER UPDATE ON initiative FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'board:' || NEW.project_id, NEW.project_id, 1 WHERE 1
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || NEW.id, NEW.project_id, 1 WHERE 1
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER initiative_rev_d AFTER DELETE ON initiative FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'board:' || OLD.project_id, OLD.project_id, 1 WHERE EXISTS (SELECT 1 FROM project WHERE id = OLD.project_id)
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  DELETE FROM revision WHERE scope = 'initiative:' || OLD.id;
END;
--> statement-breakpoint

-- rev_initiative_child (0070, 0125)
CREATE TRIGGER initiative_label_rev_i AFTER INSERT ON initiative_label FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'board:' || i.project_id, i.project_id, 1 FROM initiative i WHERE i.id = NEW.initiative_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || i.id, i.project_id, 1 FROM initiative i WHERE i.id = NEW.initiative_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER initiative_label_rev_u AFTER UPDATE ON initiative_label FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'board:' || i.project_id, i.project_id, 1 FROM initiative i WHERE i.id = NEW.initiative_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || i.id, i.project_id, 1 FROM initiative i WHERE i.id = NEW.initiative_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER initiative_label_rev_d AFTER DELETE ON initiative_label FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'board:' || i.project_id, i.project_id, 1 FROM initiative i WHERE i.id = OLD.initiative_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || i.id, i.project_id, 1 FROM initiative i WHERE i.id = OLD.initiative_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER initiative_attachment_rev_i AFTER INSERT ON initiative_attachment FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'board:' || i.project_id, i.project_id, 1 FROM initiative i WHERE i.id = NEW.initiative_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || i.id, i.project_id, 1 FROM initiative i WHERE i.id = NEW.initiative_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER initiative_attachment_rev_u AFTER UPDATE ON initiative_attachment FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'board:' || i.project_id, i.project_id, 1 FROM initiative i WHERE i.id = NEW.initiative_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || i.id, i.project_id, 1 FROM initiative i WHERE i.id = NEW.initiative_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER initiative_attachment_rev_d AFTER DELETE ON initiative_attachment FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'board:' || i.project_id, i.project_id, 1 FROM initiative i WHERE i.id = OLD.initiative_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || i.id, i.project_id, 1 FROM initiative i WHERE i.id = OLD.initiative_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

-- rev_cycle (0070)
CREATE TRIGGER cycle_rev_i AFTER INSERT ON cycle FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'board:' || NEW.project_id, NEW.project_id, 1 WHERE 1
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER cycle_rev_u AFTER UPDATE ON cycle FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'board:' || NEW.project_id, NEW.project_id, 1 WHERE 1
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER cycle_rev_d AFTER DELETE ON cycle FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'board:' || OLD.project_id, OLD.project_id, 1 WHERE EXISTS (SELECT 1 FROM project WHERE id = OLD.project_id)
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

-- rev_inbox (0070): a user's notifications in one project
CREATE TRIGGER notification_rev_i AFTER INSERT ON notification FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'inbox:' || NEW.project_id || ':' || NEW.user_id, NEW.project_id, 1 WHERE 1
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER notification_rev_u AFTER UPDATE ON notification FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'inbox:' || NEW.project_id || ':' || NEW.user_id, NEW.project_id, 1 WHERE 1
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER notification_rev_d AFTER DELETE ON notification FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'inbox:' || OLD.project_id || ':' || OLD.user_id, OLD.project_id, 1 WHERE EXISTS (SELECT 1 FROM project WHERE id = OLD.project_id)
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

-- rev_agent_run (0152): the runner queue marker, skipped for a project on its way out
CREATE TRIGGER agent_run_rev_i AFTER INSERT ON agent_run FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'runner-queue:' || NEW.project_id, NEW.project_id, 1 WHERE EXISTS (SELECT 1 FROM project WHERE id = NEW.project_id)
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER agent_run_rev_u AFTER UPDATE ON agent_run FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'runner-queue:' || NEW.project_id, NEW.project_id, 1 WHERE EXISTS (SELECT 1 FROM project WHERE id = NEW.project_id)
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER agent_run_rev_d AFTER DELETE ON agent_run FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'runner-queue:' || OLD.project_id, OLD.project_id, 1 WHERE EXISTS (SELECT 1 FROM project WHERE id = OLD.project_id)
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

-- rev_project_cleanup (0070): revision rows of a deleted project (was deferred to commit)
CREATE TRIGGER project_rev_cleanup_d AFTER DELETE ON project FOR EACH ROW
BEGIN
  DELETE FROM revision WHERE project_id = OLD.id;
END;
--> statement-breakpoint

-- rev_document (0118): documents:<project>, silent while the document_rebalance flag is set
CREATE TRIGGER project_document_rev_i AFTER INSERT ON project_document FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'documents:' || NEW.project_id, NEW.project_id, 1 WHERE NOT EXISTS (SELECT 1 FROM trigger_flag WHERE name = 'document_rebalance')
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER project_document_rev_u AFTER UPDATE ON project_document FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'documents:' || NEW.project_id, NEW.project_id, 1 WHERE NOT EXISTS (SELECT 1 FROM trigger_flag WHERE name = 'document_rebalance')
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER project_document_rev_d AFTER DELETE ON project_document FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'documents:' || OLD.project_id, OLD.project_id, 1 WHERE NOT EXISTS (SELECT 1 FROM trigger_flag WHERE name = 'document_rebalance') AND EXISTS (SELECT 1 FROM project WHERE id = OLD.project_id)
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

-- rev_document_child (0118, 0129): assets, preferences, comments
CREATE TRIGGER document_asset_rev_i AFTER INSERT ON document_asset FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'documents:' || d.project_id, d.project_id, 1 FROM project_document d WHERE d.id = NEW.document_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER document_asset_rev_u AFTER UPDATE ON document_asset FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'documents:' || d.project_id, d.project_id, 1 FROM project_document d WHERE d.id = NEW.document_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER document_asset_rev_d AFTER DELETE ON document_asset FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'documents:' || d.project_id, d.project_id, 1 FROM project_document d WHERE d.id = OLD.document_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER project_document_preference_rev_i AFTER INSERT ON project_document_preference FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'documents:' || d.project_id, d.project_id, 1 FROM project_document d WHERE d.id = NEW.document_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER project_document_preference_rev_u AFTER UPDATE ON project_document_preference FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'documents:' || d.project_id, d.project_id, 1 FROM project_document d WHERE d.id = NEW.document_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER project_document_preference_rev_d AFTER DELETE ON project_document_preference FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'documents:' || d.project_id, d.project_id, 1 FROM project_document d WHERE d.id = OLD.document_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER document_comment_rev_i AFTER INSERT ON document_comment FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'documents:' || d.project_id, d.project_id, 1 FROM project_document d WHERE d.id = NEW.document_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER document_comment_rev_u AFTER UPDATE ON document_comment FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'documents:' || d.project_id, d.project_id, 1 FROM project_document d WHERE d.id = NEW.document_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER document_comment_rev_d AFTER DELETE ON document_comment FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'documents:' || d.project_id, d.project_id, 1 FROM project_document d WHERE d.id = OLD.document_id
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

-- project_document_issue_rev (0118) / project_document_initiative_rev (0126): link rows move
-- the documents list and the linked entity
CREATE TRIGGER project_document_issue_rev_i AFTER INSERT ON project_document_issue FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'documents:' || p, p, 1 FROM (SELECT COALESCE((SELECT project_id FROM project_document WHERE id = NEW.document_id), (SELECT project_id FROM issue WHERE id = NEW.issue_id)) AS p) WHERE p IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'issue:' || NEW.issue_id, p, 1 FROM (SELECT COALESCE((SELECT project_id FROM project_document WHERE id = NEW.document_id), (SELECT project_id FROM issue WHERE id = NEW.issue_id)) AS p) WHERE p IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER project_document_issue_rev_d AFTER DELETE ON project_document_issue FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'documents:' || p, p, 1 FROM (SELECT COALESCE((SELECT project_id FROM project_document WHERE id = OLD.document_id), (SELECT project_id FROM issue WHERE id = OLD.issue_id)) AS p) WHERE p IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'issue:' || OLD.issue_id, p, 1 FROM (SELECT COALESCE((SELECT project_id FROM project_document WHERE id = OLD.document_id), (SELECT project_id FROM issue WHERE id = OLD.issue_id)) AS p) WHERE p IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER project_document_initiative_rev_i AFTER INSERT ON project_document_initiative FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'documents:' || p, p, 1 FROM (SELECT COALESCE((SELECT project_id FROM project_document WHERE id = NEW.document_id), (SELECT project_id FROM initiative WHERE id = NEW.initiative_id)) AS p) WHERE p IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || NEW.initiative_id, p, 1 FROM (SELECT COALESCE((SELECT project_id FROM project_document WHERE id = NEW.document_id), (SELECT project_id FROM initiative WHERE id = NEW.initiative_id)) AS p) WHERE p IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

CREATE TRIGGER project_document_initiative_rev_d AFTER DELETE ON project_document_initiative FOR EACH ROW
BEGIN
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'documents:' || p, p, 1 FROM (SELECT COALESCE((SELECT project_id FROM project_document WHERE id = OLD.document_id), (SELECT project_id FROM initiative WHERE id = OLD.initiative_id)) AS p) WHERE p IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
  INSERT INTO revision (scope, project_id, rev)
    SELECT 'initiative:' || OLD.initiative_id, p, 1 FROM (SELECT COALESCE((SELECT project_id FROM project_document WHERE id = OLD.document_id), (SELECT project_id FROM initiative WHERE id = OLD.initiative_id)) AS p) WHERE p IS NOT NULL
    ON CONFLICT (scope) DO UPDATE SET rev = rev + 1;
END;
--> statement-breakpoint

-- project_document_*_validate_project (0118, 0126): a link stays inside one project
CREATE TRIGGER project_document_issue_validate_project_i BEFORE INSERT ON project_document_issue FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'A document and work item link must stay inside one project')
    WHERE NOT EXISTS (
      SELECT 1 FROM project_document d JOIN issue o ON o.project_id = d.project_id
      WHERE d.id = NEW.document_id AND o.id = NEW.issue_id
    );
END;
--> statement-breakpoint

CREATE TRIGGER project_document_issue_validate_project_u BEFORE UPDATE ON project_document_issue FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'A document and work item link must stay inside one project')
    WHERE NOT EXISTS (
      SELECT 1 FROM project_document d JOIN issue o ON o.project_id = d.project_id
      WHERE d.id = NEW.document_id AND o.id = NEW.issue_id
    );
END;
--> statement-breakpoint

CREATE TRIGGER project_document_initiative_validate_project_i BEFORE INSERT ON project_document_initiative FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'A document and initiative link must stay inside one project')
    WHERE NOT EXISTS (
      SELECT 1 FROM project_document d JOIN initiative o ON o.project_id = d.project_id
      WHERE d.id = NEW.document_id AND o.id = NEW.initiative_id
    );
END;
--> statement-breakpoint

CREATE TRIGGER project_document_initiative_validate_project_u BEFORE UPDATE ON project_document_initiative FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'A document and initiative link must stay inside one project')
    WHERE NOT EXISTS (
      SELECT 1 FROM project_document d JOIN initiative o ON o.project_id = d.project_id
      WHERE d.id = NEW.document_id AND o.id = NEW.initiative_id
    );
END;
--> statement-breakpoint

-- default_project_document_owner (0118): the creator owns a new page unless an owner was given
CREATE TRIGGER project_document_owner_default_i AFTER INSERT ON project_document FOR EACH ROW
  WHEN NEW.owner_user_id IS NULL AND NEW.created_by_user_id IS NOT NULL
BEGIN
  UPDATE project_document SET owner_user_id = NEW.created_by_user_id WHERE id = NEW.id;
END;
--> statement-breakpoint

-- capture_project_document_revision (0118): snapshot per persisted version, newest 20 kept
CREATE TRIGGER project_document_revision_capture_i AFTER INSERT ON project_document FOR EACH ROW
BEGIN
  INSERT INTO project_document_revision (document_id, version, parent_id, title, content, content_json, icon, metadata, full_width, is_private, is_locked, archived_at, position, owner_user_id, created_by_user_id, created_at)
    SELECT NEW.id, NEW.version, NEW.parent_id, NEW.title, NEW.content, NEW.content_json, NEW.icon, NEW.metadata, NEW.full_width, NEW.is_private, NEW.is_locked, NEW.archived_at, NEW.position, COALESCE(NEW.owner_user_id, NEW.created_by_user_id), COALESCE(NEW.updated_by_user_id, NEW.created_by_user_id), NEW.updated_at WHERE NOT EXISTS (SELECT 1 FROM trigger_flag WHERE name = 'document_rebalance')
    ON CONFLICT (document_id, version) DO UPDATE SET
      parent_id = excluded.parent_id,
      title = excluded.title,
      content = excluded.content,
      content_json = excluded.content_json,
      icon = excluded.icon,
      metadata = excluded.metadata,
      full_width = excluded.full_width,
      is_private = excluded.is_private,
      is_locked = excluded.is_locked,
      archived_at = excluded.archived_at,
      position = excluded.position,
      owner_user_id = excluded.owner_user_id,
      created_by_user_id = excluded.created_by_user_id,
      created_at = excluded.created_at;
  DELETE FROM project_document_revision WHERE NOT EXISTS (SELECT 1 FROM trigger_flag WHERE name = 'document_rebalance') AND id IN (
    SELECT id FROM project_document_revision WHERE document_id = NEW.id
    ORDER BY version DESC LIMIT -1 OFFSET 20
  );
END;
--> statement-breakpoint

CREATE TRIGGER project_document_revision_capture_u AFTER UPDATE ON project_document FOR EACH ROW
BEGIN
  DELETE FROM project_document_revision WHERE id IN (
    SELECT p.id FROM
      (SELECT * FROM project_document_revision WHERE document_id = NEW.id ORDER BY version DESC LIMIT 1) AS p
      JOIN (SELECT * FROM project_document_revision WHERE document_id = NEW.id ORDER BY version DESC LIMIT 1 OFFSET 1) AS q
    WHERE NOT EXISTS (SELECT 1 FROM trigger_flag WHERE name = 'document_rebalance') AND NOT (NEW.version IS OLD.version AND NEW.parent_id IS OLD.parent_id AND NEW.title IS OLD.title AND NEW.content IS OLD.content AND NEW.content_json IS OLD.content_json AND NEW.icon IS OLD.icon AND NEW.metadata IS OLD.metadata AND NEW.full_width IS OLD.full_width AND NEW.is_private IS OLD.is_private AND NEW.is_locked IS OLD.is_locked AND NEW.archived_at IS OLD.archived_at AND NEW.position IS OLD.position AND NEW.owner_user_id IS OLD.owner_user_id)
      AND OLD.parent_id IS NEW.parent_id AND OLD.icon IS NEW.icon AND OLD.metadata IS NEW.metadata AND OLD.full_width IS NEW.full_width AND OLD.is_private IS NEW.is_private AND OLD.is_locked IS NEW.is_locked AND OLD.archived_at IS NEW.archived_at AND OLD.position IS NEW.position AND OLD.owner_user_id IS NEW.owner_user_id AND (OLD.title IS NOT NEW.title OR OLD.content IS NOT NEW.content OR OLD.content_json IS NOT NEW.content_json)
      AND p.parent_id IS q.parent_id AND p.icon IS q.icon AND p.metadata IS q.metadata AND p.full_width IS q.full_width AND p.is_private IS q.is_private AND p.is_locked IS q.is_locked AND p.archived_at IS q.archived_at AND p.position IS q.position AND p.owner_user_id IS q.owner_user_id AND (p.title IS NOT q.title OR p.content IS NOT q.content OR p.content_json IS NOT q.content_json)
      AND NOT EXISTS (SELECT 1 FROM trigger_flag WHERE name = 'document_checkpoint')
      AND p.created_by_user_id IS COALESCE(NEW.updated_by_user_id, NEW.created_by_user_id)
      AND p.created_at BETWEEN NEW.updated_at - 600000 AND NEW.updated_at
  );
  INSERT INTO project_document_revision (document_id, version, parent_id, title, content, content_json, icon, metadata, full_width, is_private, is_locked, archived_at, position, owner_user_id, created_by_user_id, created_at)
    SELECT NEW.id, NEW.version, NEW.parent_id, NEW.title, NEW.content, NEW.content_json, NEW.icon, NEW.metadata, NEW.full_width, NEW.is_private, NEW.is_locked, NEW.archived_at, NEW.position, NEW.owner_user_id, COALESCE(NEW.updated_by_user_id, NEW.created_by_user_id), NEW.updated_at WHERE NOT EXISTS (SELECT 1 FROM trigger_flag WHERE name = 'document_rebalance') AND NOT (NEW.version IS OLD.version AND NEW.parent_id IS OLD.parent_id AND NEW.title IS OLD.title AND NEW.content IS OLD.content AND NEW.content_json IS OLD.content_json AND NEW.icon IS OLD.icon AND NEW.metadata IS OLD.metadata AND NEW.full_width IS OLD.full_width AND NEW.is_private IS OLD.is_private AND NEW.is_locked IS OLD.is_locked AND NEW.archived_at IS OLD.archived_at AND NEW.position IS OLD.position AND NEW.owner_user_id IS OLD.owner_user_id)
    ON CONFLICT (document_id, version) DO UPDATE SET
      parent_id = excluded.parent_id,
      title = excluded.title,
      content = excluded.content,
      content_json = excluded.content_json,
      icon = excluded.icon,
      metadata = excluded.metadata,
      full_width = excluded.full_width,
      is_private = excluded.is_private,
      is_locked = excluded.is_locked,
      archived_at = excluded.archived_at,
      position = excluded.position,
      owner_user_id = excluded.owner_user_id,
      created_by_user_id = excluded.created_by_user_id,
      created_at = excluded.created_at;
  DELETE FROM project_document_revision WHERE NOT EXISTS (SELECT 1 FROM trigger_flag WHERE name = 'document_rebalance') AND NOT (NEW.version IS OLD.version AND NEW.parent_id IS OLD.parent_id AND NEW.title IS OLD.title AND NEW.content IS OLD.content AND NEW.content_json IS OLD.content_json AND NEW.icon IS OLD.icon AND NEW.metadata IS OLD.metadata AND NEW.full_width IS OLD.full_width AND NEW.is_private IS OLD.is_private AND NEW.is_locked IS OLD.is_locked AND NEW.archived_at IS OLD.archived_at AND NEW.position IS OLD.position AND NEW.owner_user_id IS OLD.owner_user_id) AND id IN (
    SELECT id FROM project_document_revision WHERE document_id = NEW.id
    ORDER BY version DESC LIMIT -1 OFFSET 20
  );
END;
