CREATE TABLE `ai_spans` (
	`trace_id` text NOT NULL,
	`span_id` text NOT NULL,
	`parent_span_id` text,
	`name` text NOT NULL,
	`span_type` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`error` text,
	`team_id` integer,
	`agent_id` integer,
	`project_id` integer,
	`run_id` integer,
	`issue_id` integer,
	`schedule_id` integer,
	`user_id` text,
	`trigger` text,
	`metadata` text,
	`provider` text,
	`model` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`cache_read` integer,
	`cache_write` integer,
	`attributes` text,
	`input_json` text,
	`output_json` text,
	`input_ref` text,
	`output_ref` text,
	`input_bytes` integer,
	`output_bytes` integer,
	PRIMARY KEY(`trace_id`, `span_id`)
);
--> statement-breakpoint
CREATE INDEX `ai_spans_agent_root` ON `ai_spans` (`agent_id`,"started_at" DESC) WHERE "ai_spans"."parent_span_id" IS NULL;--> statement-breakpoint
CREATE INDEX `ai_spans_team_root` ON `ai_spans` (`team_id`,`started_at`) WHERE "ai_spans"."parent_span_id" IS NULL;--> statement-breakpoint
CREATE INDEX `ai_spans_run_root` ON `ai_spans` (`run_id`,"started_at" DESC) WHERE "ai_spans"."parent_span_id" IS NULL;--> statement-breakpoint
CREATE INDEX `ai_spans_issue_root` ON `ai_spans` (`issue_id`,"started_at" DESC) WHERE "ai_spans"."parent_span_id" IS NULL;--> statement-breakpoint
CREATE INDEX `ai_spans_type_trace` ON `ai_spans` (`span_type`,`trace_id`);--> statement-breakpoint
CREATE INDEX `ai_spans_started` ON `ai_spans` (`started_at`) WHERE "ai_spans"."parent_span_id" IS NULL;--> statement-breakpoint
CREATE INDEX `ai_spans_trace` ON `ai_spans` (`trace_id`,`started_at`);