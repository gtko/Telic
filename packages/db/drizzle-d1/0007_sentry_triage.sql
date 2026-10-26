PRAGMA defer_foreign_keys = true;--> statement-breakpoint
-- project_column is rebuilt to add 'triage' to its CHECK. D1 cannot turn foreign keys off, so
-- the DROP runs the ON DELETE actions of its children: issue_status and issue_template get
-- column_id set to NULL. Those two columns are saved here and restored below. The rows of
-- issue (no action) count as unmatched until the parent rows are inserted again, which is
-- the last step that settles the count.
CREATE TABLE `__bk_project_column` AS SELECT * FROM `project_column`;--> statement-breakpoint
CREATE TABLE `__bk_project_column_seq` AS SELECT `seq` FROM `sqlite_sequence` WHERE `name` = 'project_column';--> statement-breakpoint
CREATE TABLE `__bk_issue_status` AS SELECT `id`, `column_id` FROM `issue_status` WHERE `column_id` IS NOT NULL;--> statement-breakpoint
CREATE TABLE `__bk_issue_template` AS SELECT `id`, `column_id` FROM `issue_template` WHERE `column_id` IS NOT NULL;--> statement-breakpoint
DROP TABLE `project_column`;--> statement-breakpoint
CREATE TABLE `project_column` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`name` text NOT NULL,
	`state_type` text DEFAULT 'unstarted' NOT NULL,
	`color` text DEFAULT '#6b7280' NOT NULL,
	`position` integer NOT NULL,
	`wip_limit` integer,
	`wip_mode` text DEFAULT 'soft' NOT NULL,
	`auto_assign_user_id` text,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`auto_assign_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "project_column_state_type_check" CHECK("project_column"."state_type" IN ('backlog', 'triage', 'unstarted', 'started', 'completed', 'canceled')),
	CONSTRAINT "project_column_wip_mode_check" CHECK("project_column"."wip_mode" IN ('soft', 'hard')),
	CONSTRAINT "project_column_wip_limit_check" CHECK("project_column"."wip_limit" IS NULL OR "project_column"."wip_limit" > 0)
);--> statement-breakpoint
-- The AUTOINCREMENT counter is carried over, so the id of a deleted column is not reused.
INSERT INTO `sqlite_sequence` (`name`, `seq`) SELECT 'project_column', `seq` FROM `__bk_project_column_seq`;--> statement-breakpoint
INSERT INTO `project_column` ("id", "project_id", "name", "state_type", "color", "position", "wip_limit", "wip_mode", "auto_assign_user_id", "created_at") SELECT "id", "project_id", "name", "state_type", "color", "position", "wip_limit", "wip_mode", "auto_assign_user_id", "created_at" FROM `__bk_project_column` ORDER BY `id`;--> statement-breakpoint
CREATE UNIQUE INDEX `project_column_project_id_position_unique` ON `project_column` (`project_id`,`position`);--> statement-breakpoint
UPDATE `issue_status` SET `column_id` = (SELECT `b`.`column_id` FROM `__bk_issue_status` AS `b` WHERE `b`.`id` = `issue_status`.`id`) WHERE `id` IN (SELECT `id` FROM `__bk_issue_status`);--> statement-breakpoint
UPDATE `issue_template` SET `column_id` = (SELECT `b`.`column_id` FROM `__bk_issue_template` AS `b` WHERE `b`.`id` = `issue_template`.`id`) WHERE `id` IN (SELECT `id` FROM `__bk_issue_template`);--> statement-breakpoint
DROP TABLE `__bk_project_column`;--> statement-breakpoint
DROP TABLE `__bk_project_column_seq`;--> statement-breakpoint
DROP TABLE `__bk_issue_status`;--> statement-breakpoint
DROP TABLE `__bk_issue_template`;--> statement-breakpoint
CREATE TABLE `sentry_issue` (
	`sentry_issue_id` text PRIMARY KEY NOT NULL,
	`issue_id` integer NOT NULL,
	`last_event_at` integer,
	FOREIGN KEY (`issue_id`) REFERENCES `issue`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sentry_issue_issue_idx` ON `sentry_issue` (`issue_id`);--> statement-breakpoint
CREATE TABLE `sentry_route` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sentry_project_slug` text NOT NULL,
	`project_id` integer NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sentry_route_sentry_project_slug_unique` ON `sentry_route` (`sentry_project_slug`);--> statement-breakpoint
CREATE INDEX `sentry_route_project_idx` ON `sentry_route` (`project_id`);
