CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_userId_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `apikey` (
	`id` text PRIMARY KEY NOT NULL,
	`config_id` text DEFAULT 'default' NOT NULL,
	`name` text,
	`start` text,
	`reference_id` text NOT NULL,
	`prefix` text,
	`key` text NOT NULL,
	`refill_interval` integer,
	`refill_amount` integer,
	`last_refill_at` integer,
	`enabled` integer DEFAULT true,
	`rate_limit_enabled` integer DEFAULT true,
	`rate_limit_time_window` integer DEFAULT 1000,
	`rate_limit_max` integer DEFAULT 100,
	`request_count` integer DEFAULT 0,
	`remaining` integer,
	`last_request` integer,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`permissions` text,
	`metadata` text
);
--> statement-breakpoint
CREATE INDEX `apikey_configId_idx` ON `apikey` (`config_id`);--> statement-breakpoint
CREATE INDEX `apikey_referenceId_idx` ON `apikey` (`reference_id`);--> statement-breakpoint
CREATE INDEX `apikey_key_idx` ON `apikey` (`key`);--> statement-breakpoint
CREATE TABLE `jwks` (
	`id` text PRIMARY KEY NOT NULL,
	`public_key` text NOT NULL,
	`private_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`alg` text,
	`crv` text
);
--> statement-breakpoint
CREATE TABLE `oauth_access_token` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`client_id` text NOT NULL,
	`session_id` text,
	`user_id` text,
	`reference_id` text,
	`authorization_code_id` text,
	`resources` text,
	`requested_user_info_claims` text,
	`refresh_id` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`revoked` integer,
	`confirmation` text,
	`scopes` text NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_client`(`client_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`refresh_id`) REFERENCES `oauth_refresh_token`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_access_token_token_unique` ON `oauth_access_token` (`token`);--> statement-breakpoint
CREATE INDEX `oauthAccessToken_clientId_idx` ON `oauth_access_token` (`client_id`);--> statement-breakpoint
CREATE INDEX `oauthAccessToken_sessionId_idx` ON `oauth_access_token` (`session_id`);--> statement-breakpoint
CREATE INDEX `oauthAccessToken_userId_idx` ON `oauth_access_token` (`user_id`);--> statement-breakpoint
CREATE INDEX `oauthAccessToken_authorizationCodeId_idx` ON `oauth_access_token` (`authorization_code_id`);--> statement-breakpoint
CREATE INDEX `oauthAccessToken_refreshId_idx` ON `oauth_access_token` (`refresh_id`);--> statement-breakpoint
CREATE TABLE `oauth_client` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`client_secret` text,
	`client_discovery_id` text,
	`disabled` integer DEFAULT false,
	`skip_consent` integer,
	`enable_end_session` integer,
	`subject_type` text,
	`scopes` text,
	`client_credentials_scopes` text DEFAULT '[]',
	`user_id` text,
	`created_at` integer,
	`updated_at` integer,
	`name` text,
	`uri` text,
	`icon` text,
	`contacts` text,
	`tos` text,
	`policy` text,
	`software_id` text,
	`software_version` text,
	`software_statement` text,
	`redirect_uris` text NOT NULL,
	`post_logout_redirect_uris` text,
	`backchannel_logout_uri` text,
	`backchannel_logout_session_required` integer,
	`token_endpoint_auth_method` text,
	`application_type` text,
	`jwks` text,
	`jwks_uri` text,
	`grant_types` text,
	`response_types` text,
	`require_pkce` integer,
	`dpop_bound_access_tokens` integer DEFAULT false,
	`reference_id` text,
	`metadata` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_client_client_id_unique` ON `oauth_client` (`client_id`);--> statement-breakpoint
CREATE INDEX `oauthClient_userId_idx` ON `oauth_client` (`user_id`);--> statement-breakpoint
CREATE TABLE `oauth_client_assertion` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_client_resource` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`resource_id` text NOT NULL,
	`metadata` text,
	`created_at` integer,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_client`(`client_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resource_id`) REFERENCES `oauth_resource`(`identifier`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauthClientResource_clientId_resourceId_uidx` ON `oauth_client_resource` (`client_id`,`resource_id`);--> statement-breakpoint
CREATE INDEX `oauthClientResource_clientId_idx` ON `oauth_client_resource` (`client_id`);--> statement-breakpoint
CREATE INDEX `oauthClientResource_resourceId_idx` ON `oauth_client_resource` (`resource_id`);--> statement-breakpoint
CREATE TABLE `oauth_consent` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text,
	`reference_id` text,
	`resources` text,
	`requested_user_info_claims` text,
	`scopes` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_client`(`client_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `oauthConsent_clientId_idx` ON `oauth_consent` (`client_id`);--> statement-breakpoint
CREATE INDEX `oauthConsent_userId_idx` ON `oauth_consent` (`user_id`);--> statement-breakpoint
CREATE TABLE `oauth_refresh_token` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`client_id` text NOT NULL,
	`session_id` text,
	`user_id` text NOT NULL,
	`reference_id` text,
	`authorization_code_id` text,
	`resources` text,
	`requested_user_info_claims` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`revoked` integer,
	`rotated_at` integer,
	`rotation_replay_response` text,
	`rotation_replay_expires_at` integer,
	`auth_time` integer,
	`confirmation` text,
	`scopes` text NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_client`(`client_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_refresh_token_token_unique` ON `oauth_refresh_token` (`token`);--> statement-breakpoint
CREATE INDEX `oauthRefreshToken_clientId_idx` ON `oauth_refresh_token` (`client_id`);--> statement-breakpoint
CREATE INDEX `oauthRefreshToken_sessionId_idx` ON `oauth_refresh_token` (`session_id`);--> statement-breakpoint
CREATE INDEX `oauthRefreshToken_userId_idx` ON `oauth_refresh_token` (`user_id`);--> statement-breakpoint
CREATE INDEX `oauthRefreshToken_authorizationCodeId_idx` ON `oauth_refresh_token` (`authorization_code_id`);--> statement-breakpoint
CREATE TABLE `oauth_resource` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`name` text NOT NULL,
	`access_token_ttl` integer,
	`refresh_token_ttl` integer,
	`signing_algorithm` text,
	`signing_key_id` text,
	`allowed_scopes` text,
	`custom_claims` text,
	`dpop_bound_access_tokens_required` integer DEFAULT false,
	`disabled` integer DEFAULT false,
	`created_at` integer,
	`updated_at` integer,
	`policy_version` integer DEFAULT 1,
	`metadata` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_resource_identifier_unique` ON `oauth_resource` (`identifier`);--> statement-breakpoint
CREATE TABLE `passkey` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`public_key` text NOT NULL,
	`user_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`counter` integer NOT NULL,
	`device_type` text NOT NULL,
	`backed_up` integer NOT NULL,
	`transports` text,
	`created_at` integer,
	`aaguid` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `passkey_userId_idx` ON `passkey` (`user_id`);--> statement-breakpoint
CREATE INDEX `passkey_credentialID_idx` ON `passkey` (`credential_id`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_userId_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`username` text,
	`display_username` text,
	`role` text DEFAULT 'user',
	`active` integer DEFAULT true
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_username_unique` ON `user` (`username`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
CREATE TABLE `agent_chat_event` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` integer NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `agent_chat_message`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_chat_event_message_idx` ON `agent_chat_event` (`message_id`,`id`);--> statement-breakpoint
CREATE TABLE `agent_chat_favorite` (
	`user_id` text NOT NULL,
	`agent_id` integer NOT NULL,
	`thread_id` text NOT NULL,
	PRIMARY KEY(`user_id`, `thread_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `ai_agent`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `agent_chat_message` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`thread_id` text NOT NULL,
	`agent_id` integer NOT NULL,
	`role` text NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	`last_error` text,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `agent_chat_thread`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `ai_agent`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "agent_chat_message_role_check" CHECK("agent_chat_message"."role" IN ('user', 'assistant')),
	CONSTRAINT "agent_chat_message_status_check" CHECK("agent_chat_message"."status" IN ('pending', 'streaming', 'success', 'failed', 'canceled'))
);
--> statement-breakpoint
CREATE INDEX `agent_chat_message_thread_idx` ON `agent_chat_message` (`thread_id`,`id`);--> statement-breakpoint
CREATE INDEX `agent_chat_message_due_idx` ON `agent_chat_message` (`agent_id`,`next_attempt_at`) WHERE "agent_chat_message"."status" IN ('pending', 'streaming');--> statement-breakpoint
CREATE TABLE `agent_chat_thread` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`title` text,
	`cli_session_id` text,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `ai_agent`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_chat_thread_agent_user_idx` ON `agent_chat_thread` (`agent_id`,`user_id`,"updated_at" desc);--> statement-breakpoint
CREATE TABLE `agent_chat_usage` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`agent_id` integer NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `ai_agent`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_chat_usage_agent_idx` ON `agent_chat_usage` (`agent_id`);--> statement-breakpoint
CREATE TABLE `agent_field_trigger` (
	`agent_id` integer NOT NULL,
	`field_id` integer NOT NULL,
	`delay_sec` integer DEFAULT 120 NOT NULL,
	PRIMARY KEY(`agent_id`, `field_id`),
	FOREIGN KEY (`agent_id`) REFERENCES `ai_agent`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`field_id`) REFERENCES `custom_field`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "agent_field_trigger_delay_check" CHECK("agent_field_trigger"."delay_sec" >= 0 AND "agent_field_trigger"."delay_sec" <= 86400)
);
--> statement-breakpoint
CREATE INDEX `agent_field_trigger_field_idx` ON `agent_field_trigger` (`field_id`);--> statement-breakpoint
CREATE TABLE `agent_run` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent_id` integer NOT NULL,
	`project_id` integer NOT NULL,
	`issue_id` integer,
	`schedule_id` integer,
	`trigger` text DEFAULT 'delegation' NOT NULL,
	`scheduled_for` integer,
	`source_activity_id` integer,
	`prompt` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	`last_error` text,
	`output` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`started_at` integer,
	`execution_started_at` integer,
	`finished_at` integer,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `ai_agent`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`issue_id`) REFERENCES `issue`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`schedule_id`) REFERENCES `agent_schedule`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_activity_id`) REFERENCES `issue_activity`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "agent_run_status_check" CHECK("agent_run"."status" IN ('pending', 'success', 'failed', 'canceled')),
	CONSTRAINT "agent_run_trigger_check" CHECK("agent_run"."trigger" IN ('mention', 'delegation', 'field', 'schedule', 'manual', 'status', 'event'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_run_schedule_fire_uq` ON `agent_run` (`schedule_id`,`scheduled_for`);--> statement-breakpoint
CREATE INDEX `agent_run_due_idx` ON `agent_run` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `agent_run_schedule_idx` ON `agent_run` (`schedule_id`);--> statement-breakpoint
CREATE INDEX `agent_run_project_idx` ON `agent_run` (`project_id`);--> statement-breakpoint
CREATE TABLE `agent_run_trace` (
	`run_id` integer NOT NULL,
	`attempt` integer NOT NULL,
	`session_id` text,
	`events` text DEFAULT '[]' NOT NULL,
	`next_offset` integer DEFAULT 0 NOT NULL,
	`truncated` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	PRIMARY KEY(`run_id`, `attempt`),
	FOREIGN KEY (`run_id`) REFERENCES `agent_run`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `agent_schedule` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent_id` integer NOT NULL,
	`project_id` integer NOT NULL,
	`name` text NOT NULL,
	`prompt` text NOT NULL,
	`type` text DEFAULT 'cron' NOT NULL,
	`cron` text,
	`timezone` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`next_run_at` integer,
	`column_id` integer,
	`delay_sec` integer DEFAULT 0 NOT NULL,
	`options` text DEFAULT '{}' NOT NULL,
	`last_run_at` integer,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `ai_agent`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`column_id`) REFERENCES `project_column`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "agent_schedule_status_check" CHECK("agent_schedule"."status" IN ('active', 'paused')),
	CONSTRAINT "agent_schedule_type_check" CHECK(("agent_schedule"."type" = 'cron' AND "agent_schedule"."cron" IS NOT NULL AND "agent_schedule"."next_run_at" IS NOT NULL AND "agent_schedule"."column_id" IS NULL)
        OR ("agent_schedule"."type" = 'status' AND "agent_schedule"."column_id" IS NOT NULL AND "agent_schedule"."cron" IS NULL AND "agent_schedule"."next_run_at" IS NULL)
        OR ("agent_schedule"."type" NOT IN ('cron', 'status') AND "agent_schedule"."cron" IS NULL AND "agent_schedule"."next_run_at" IS NULL AND "agent_schedule"."column_id" IS NULL)),
	CONSTRAINT "agent_schedule_delay_check" CHECK("agent_schedule"."delay_sec" >= 0 AND "agent_schedule"."delay_sec" <= 86400)
);
--> statement-breakpoint
CREATE INDEX `agent_schedule_due_idx` ON `agent_schedule` (`status`,`next_run_at`);--> statement-breakpoint
CREATE INDEX `agent_schedule_agent_idx` ON `agent_schedule` (`agent_id`);--> statement-breakpoint
CREATE INDEX `agent_schedule_project_idx` ON `agent_schedule` (`project_id`);--> statement-breakpoint
CREATE INDEX `agent_schedule_column_idx` ON `agent_schedule` (`column_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_schedule_project_id_agent_id_name_unique` ON `agent_schedule` (`project_id`,`agent_id`,`name`);--> statement-breakpoint
CREATE TABLE `agent_skill` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`team_id` integer NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`source` text NOT NULL,
	`source_url` text,
	`s3_prefix` text NOT NULL,
	`files` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `team`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "agent_skill_source_check" CHECK("agent_skill"."source" IN ('upload', 'inline', 'github'))
);
--> statement-breakpoint
CREATE INDEX `agent_skill_team_idx` ON `agent_skill` (`team_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_skill_team_id_name_unique` ON `agent_skill` (`team_id`,`name`);--> statement-breakpoint
CREATE TABLE `agent_skill_link` (
	`agent_id` integer NOT NULL,
	`skill_id` integer NOT NULL,
	PRIMARY KEY(`agent_id`, `skill_id`),
	FOREIGN KEY (`agent_id`) REFERENCES `ai_agent`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`skill_id`) REFERENCES `agent_skill`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_skill_link_skill_idx` ON `agent_skill_link` (`skill_id`);--> statement-breakpoint
CREATE TABLE `agent_tool` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`team_id` integer NOT NULL,
	`tool_key` text NOT NULL,
	`credential_id` integer NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `team`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`credential_id`) REFERENCES `integration_credential`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_tool_team_idx` ON `agent_tool` (`team_id`);--> statement-breakpoint
CREATE INDEX `agent_tool_credential_idx` ON `agent_tool` (`credential_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_tool_team_id_tool_key_credential_id_unique` ON `agent_tool` (`team_id`,`tool_key`,`credential_id`);--> statement-breakpoint
CREATE TABLE `agent_tool_link` (
	`agent_id` integer NOT NULL,
	`agent_tool_id` integer NOT NULL,
	PRIMARY KEY(`agent_id`, `agent_tool_id`),
	FOREIGN KEY (`agent_id`) REFERENCES `ai_agent`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_tool_id`) REFERENCES `agent_tool`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_tool_link_tool_idx` ON `agent_tool_link` (`agent_tool_id`);--> statement-breakpoint
CREATE TABLE `ai_agent` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`team_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`username` text NOT NULL,
	`kind` text NOT NULL,
	`model_credential_id` integer,
	`model` text,
	`instructions` text,
	`tools` text DEFAULT '[]' NOT NULL,
	`temperature` real,
	`reasoning_effort` text,
	`max_steps` integer,
	`run_timeout_sec` integer,
	`trigger_on_mention` integer DEFAULT true NOT NULL,
	`trigger_on_assign` integer DEFAULT false NOT NULL,
	`delegation_delay_sec` integer DEFAULT 120 NOT NULL,
	`api_key_ciphertext` text,
	`api_key_iv` text,
	`api_key_auth_tag` text,
	`memory_enabled` integer DEFAULT false NOT NULL,
	`memory_last_messages` integer,
	`owner_user_id` text,
	`runner_scope` text DEFAULT 'team' NOT NULL,
	`last_seen_at` integer,
	`invocation_url` text,
	`invocation_secret_ciphertext` text,
	`invocation_secret_iv` text,
	`invocation_secret_auth_tag` text,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `team`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`model_credential_id`) REFERENCES `integration_credential`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ai_agent_kind_check" CHECK("ai_agent"."kind" IN ('external', 'internal')),
	CONSTRAINT "ai_agent_runner_scope_check" CHECK("ai_agent"."runner_scope" IN ('owner', 'team')),
	CONSTRAINT "ai_agent_reasoning_effort_check" CHECK("ai_agent"."reasoning_effort" IN ('low', 'medium', 'high')),
	CONSTRAINT "ai_agent_delegation_delay_check" CHECK("ai_agent"."delegation_delay_sec" >= 0 AND "ai_agent"."delegation_delay_sec" <= 86400)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_agent_team_username_uq` ON `ai_agent` (`team_id`,lower("username"));--> statement-breakpoint
CREATE INDEX `ai_agent_team_idx` ON `ai_agent` (`team_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ai_agent_user_id_unique` ON `ai_agent` (`user_id`);--> statement-breakpoint
CREATE TABLE `app_secret` (
	`key` text PRIMARY KEY NOT NULL,
	`ciphertext` text NOT NULL,
	`iv` text NOT NULL,
	`auth_tag` text NOT NULL,
	`redacted` text NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `app_setting` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `chat_attachment` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`public_id` text NOT NULL,
	`project_id` integer NOT NULL,
	`uploaded_by_user_id` text,
	`s3_key` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`uploaded_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_attachment_public_id_unique` ON `chat_attachment` (`public_id`);--> statement-breakpoint
CREATE INDEX `chat_attachment_project_idx` ON `chat_attachment` (`project_id`);--> statement-breakpoint
CREATE TABLE `custom_field` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`issue_type_id` integer,
	`name` text NOT NULL,
	`field_type` text NOT NULL,
	`member_scope` text,
	`show_in_body` integer DEFAULT false NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`issue_type_id`) REFERENCES `issue_type`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "custom_field_field_type_check" CHECK("custom_field"."field_type" IN ('text', 'markdown', 'url', 'number', 'boolean', 'date', 'datetime', 'datetime_range', 'select', 'multi_select', 'member')),
	CONSTRAINT "custom_field_member_scope_check" CHECK(("custom_field"."field_type" = 'member') = ("custom_field"."member_scope" IS NOT NULL) AND ("custom_field"."member_scope" IS NULL OR "custom_field"."member_scope" IN ('all', 'humans', 'agents')))
);
--> statement-breakpoint
CREATE TABLE `custom_field_option` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`field_id` integer NOT NULL,
	`value` text NOT NULL,
	`color` text DEFAULT '#6b7280' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`field_id`) REFERENCES `custom_field`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `custom_field_option_field_id_value_unique` ON `custom_field_option` (`field_id`,`value`);--> statement-breakpoint
CREATE TABLE `cycle` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`name` text NOT NULL,
	`goal` text DEFAULT '' NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`completed_at` integer,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "cycle_dates_check" CHECK("cycle"."end_date" >= "cycle"."start_date")
);
--> statement-breakpoint
CREATE INDEX `cycle_project_idx` ON `cycle` (`project_id`,`start_date`);--> statement-breakpoint
CREATE TABLE `document_asset` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`public_id` text NOT NULL,
	`document_id` integer NOT NULL,
	`uploaded_by_user_id` text,
	`s3_key` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `project_document`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`uploaded_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_asset_public_id_unique` ON `document_asset` (`public_id`);--> statement-breakpoint
CREATE INDEX `document_asset_document_idx` ON `document_asset` (`document_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `document_collaboration` (
	`document_id` integer PRIMARY KEY NOT NULL,
	`epoch` text NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`content_json` text NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `project_document`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `document_comment` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` integer NOT NULL,
	`parent_id` text,
	`author_id` text,
	`body` text NOT NULL,
	`quote` text DEFAULT '' NOT NULL,
	`selection_from` integer,
	`selection_to` integer,
	`orphaned` integer DEFAULT false NOT NULL,
	`resolved_at` integer,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `project_document`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_id`) REFERENCES `document_comment`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `document_comment_document_idx` ON `document_comment` (`document_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `document_step` (
	`document_id` integer NOT NULL,
	`version` integer NOT NULL,
	`client_id` text NOT NULL,
	`step` text NOT NULL,
	PRIMARY KEY(`document_id`, `version`),
	FOREIGN KEY (`document_id`) REFERENCES `project_document`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `git_managed_repository` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`connection_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`full_name` text NOT NULL,
	`web_url` text NOT NULL,
	`webhook_external_id` text NOT NULL,
	`status` text DEFAULT 'connected' NOT NULL,
	`last_error` text,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `git_provider_connection`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `git_managed_repository_project_connection_idx` ON `git_managed_repository` (`project_id`,`connection_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `git_managed_repository_project_connection_external_unique` ON `git_managed_repository` (`project_id`,`connection_id`,`external_id`);--> statement-breakpoint
CREATE TABLE `git_provider_connection` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`team_id` integer NOT NULL,
	`provider` text NOT NULL,
	`base_url` text NOT NULL,
	`account_login` text NOT NULL,
	`ciphertext` text NOT NULL,
	`iv` text NOT NULL,
	`auth_tag` text NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `team`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `git_provider_connection_team_idx` ON `git_provider_connection` (`team_id`);--> statement-breakpoint
CREATE TABLE `import_job` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`created_by_user_id` text NOT NULL,
	`source` text NOT NULL,
	`phase` text DEFAULT 'discover' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`cursor` text DEFAULT '{}' NOT NULL,
	`credential_ciphertext` text,
	`credential_iv` text,
	`credential_auth_tag` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	`last_error` text,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "import_job_source_check" CHECK("import_job"."source" IN ('plane', 'linear')),
	CONSTRAINT "import_job_phase_check" CHECK("import_job"."phase" IN ('discover', 'create', 'link', 'rewrite', 'attachments', 'done')),
	CONSTRAINT "import_job_status_check" CHECK("import_job"."status" IN ('pending', 'running', 'paused', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `import_job_project_idx` ON `import_job` (`project_id`);--> statement-breakpoint
CREATE INDEX `import_job_due_idx` ON `import_job` (`next_attempt_at`) WHERE "import_job"."status" = 'pending';--> statement-breakpoint
CREATE TABLE `import_record` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`import_job_id` integer NOT NULL,
	`source_entity_type` text NOT NULL,
	`source_id` text NOT NULL,
	`source_display_id` text,
	`local_entity_type` text,
	`local_id` integer,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`import_job_id`) REFERENCES `import_job`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "import_record_source_entity_type_check" CHECK("import_record"."source_entity_type" IN ('issue', 'comment', 'label', 'state', 'cycle', 'attachment')),
	CONSTRAINT "import_record_local_entity_type_check" CHECK("import_record"."local_entity_type" IS NULL OR "import_record"."local_entity_type" IN ('issue', 'comment', 'label', 'state', 'cycle', 'attachment'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_record_job_source_uq` ON `import_record` (`import_job_id`,`source_entity_type`,`source_id`);--> statement-breakpoint
CREATE INDEX `import_record_job_local_idx` ON `import_record` (`import_job_id`,`local_entity_type`,`local_id`);--> statement-breakpoint
CREATE INDEX `import_record_job_display_idx` ON `import_record` (`import_job_id`,`source_entity_type`,`source_display_id`);--> statement-breakpoint
CREATE TABLE `initiative` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'planned' NOT NULL,
	`owner_user_id` text,
	`priority` text,
	`start_date` text,
	`target_date` text,
	`position` real DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "initiative_status_check" CHECK("initiative"."status" IN ('proposed', 'planned', 'active', 'completed', 'canceled'))
);
--> statement-breakpoint
CREATE INDEX `initiative_project_idx` ON `initiative` (`project_id`,`position`);--> statement-breakpoint
CREATE TABLE `initiative_attachment` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`public_id` text NOT NULL,
	`initiative_id` integer NOT NULL,
	`s3_key` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`initiative_id`) REFERENCES `initiative`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `initiative_attachment_public_id_unique` ON `initiative_attachment` (`public_id`);--> statement-breakpoint
CREATE INDEX `initiative_attachment_initiative_idx` ON `initiative_attachment` (`initiative_id`);--> statement-breakpoint
CREATE TABLE `initiative_label` (
	`initiative_id` integer NOT NULL,
	`label_id` integer NOT NULL,
	PRIMARY KEY(`initiative_id`, `label_id`),
	FOREIGN KEY (`initiative_id`) REFERENCES `initiative`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`label_id`) REFERENCES `label`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `integration_credential` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`team_id` integer NOT NULL,
	`integration_key` text NOT NULL,
	`label` text,
	`ciphertext` text NOT NULL,
	`iv` text NOT NULL,
	`auth_tag` text NOT NULL,
	`redacted` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `team`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `integration_credential_team_idx` ON `integration_credential` (`team_id`);--> statement-breakpoint
CREATE TABLE `issue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`sequence_number` integer NOT NULL,
	`type_id` integer,
	`initiative_id` integer,
	`cycle_id` integer,
	`column_id` integer NOT NULL,
	`parent_id` integer,
	`assignee_user_id` text,
	`delegate_user_id` text,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`priority` text,
	`estimate_points` real,
	`estimate_minutes` integer,
	`start_date` text,
	`due_date` text,
	`position` real DEFAULT 0 NOT NULL,
	`archived_at` integer,
	`share_token` text,
	`share_extended` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`type_id`) REFERENCES `issue_type`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`initiative_id`) REFERENCES `initiative`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`cycle_id`) REFERENCES `cycle`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`column_id`) REFERENCES `project_column`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_id`) REFERENCES `issue`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`assignee_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`delegate_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "issue_estimate_points_check" CHECK("issue"."estimate_points" >= 0),
	CONSTRAINT "issue_estimate_minutes_check" CHECK("issue"."estimate_minutes" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issue_share_token_unique` ON `issue` (`share_token`);--> statement-breakpoint
CREATE INDEX `issue_project_active_idx` ON `issue` (`project_id`,`column_id`) WHERE "issue"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX `issue_project_title_idx` ON `issue` (`project_id`,lower(trim("title")));--> statement-breakpoint
CREATE INDEX `issue_parent_idx` ON `issue` (`parent_id`) WHERE "issue"."parent_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `issue_cycle_idx` ON `issue` (`cycle_id`) WHERE "issue"."cycle_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `issue_project_id_sequence_number_unique` ON `issue` (`project_id`,`sequence_number`);--> statement-breakpoint
CREATE TABLE `issue_activity` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`issue_id` integer,
	`initiative_id` integer,
	`kind` text NOT NULL,
	`reply_to_id` integer,
	`actor_user_id` text,
	`actor_name` text,
	`body` text,
	`action` text,
	`payload` text DEFAULT '{}' NOT NULL,
	`edited_at` integer,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issue`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`initiative_id`) REFERENCES `initiative`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reply_to_id`) REFERENCES `issue_activity`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "issue_activity_kind_check" CHECK("issue_activity"."kind" IN ('comment', 'activity')),
	CONSTRAINT "issue_activity_owner_check" CHECK(("issue_activity"."issue_id" IS NOT NULL) <> ("issue_activity"."initiative_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `issue_activity_issue_idx` ON `issue_activity` (`issue_id`,"created_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX `issue_activity_reply_idx` ON `issue_activity` (`reply_to_id`);--> statement-breakpoint
CREATE INDEX `issue_activity_initiative_idx` ON `issue_activity` (`initiative_id`,"created_at" desc,"id" desc);--> statement-breakpoint
CREATE TABLE `issue_attachment` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`public_id` text NOT NULL,
	`issue_id` integer NOT NULL,
	`s3_key` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issue`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issue_attachment_public_id_unique` ON `issue_attachment` (`public_id`);--> statement-breakpoint
CREATE INDEX `issue_attachment_issue_idx` ON `issue_attachment` (`issue_id`);--> statement-breakpoint
CREATE TABLE `issue_checklist` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`issue_id` integer NOT NULL,
	`title` text NOT NULL,
	`position` real DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issue`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `issue_checklist_issue_idx` ON `issue_checklist` (`issue_id`,`position`);--> statement-breakpoint
CREATE TABLE `issue_checklist_item` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`checklist_id` integer NOT NULL,
	`content` text NOT NULL,
	`done` integer DEFAULT false NOT NULL,
	`position` real DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`checklist_id`) REFERENCES `issue_checklist`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `issue_checklist_item_checklist_idx` ON `issue_checklist_item` (`checklist_id`,`position`);--> statement-breakpoint
CREATE TABLE `issue_cycle` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`issue_id` integer NOT NULL,
	`cycle_id` integer NOT NULL,
	`entered_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	`left_at` integer,
	FOREIGN KEY (`issue_id`) REFERENCES `issue`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`cycle_id`) REFERENCES `cycle`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `issue_cycle_issue_idx` ON `issue_cycle` (`issue_id`,`entered_at`);--> statement-breakpoint
CREATE INDEX `issue_cycle_cycle_idx` ON `issue_cycle` (`cycle_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `issue_cycle_open_idx` ON `issue_cycle` (`issue_id`,`cycle_id`) WHERE "issue_cycle"."left_at" IS NULL;--> statement-breakpoint
CREATE TABLE `issue_development_check` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`development_link_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`app_id` text NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`url` text,
	`head_sha` text NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`development_link_id`) REFERENCES `issue_development_link`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `issue_development_check_link_sha_idx` ON `issue_development_check` (`development_link_id`,`head_sha`);--> statement-breakpoint
CREATE UNIQUE INDEX `issue_development_check_development_link_id_app_id_name_unique` ON `issue_development_check` (`development_link_id`,`app_id`,`name`);--> statement-breakpoint
CREATE TABLE `issue_development_link` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`issue_id` integer NOT NULL,
	`provider` text NOT NULL,
	`repository` text NOT NULL,
	`kind` text DEFAULT 'pull_request' NOT NULL,
	`external_key` text NOT NULL,
	`number` integer,
	`title` text NOT NULL,
	`url` text,
	`state` text NOT NULL,
	`draft` integer DEFAULT false NOT NULL,
	`source_branch` text,
	`target_branch` text NOT NULL,
	`head_sha` text,
	`pipeline_status` text,
	`pipeline_url` text,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issue`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `issue_development_link_issue_idx` ON `issue_development_link` (`issue_id`,"updated_at" desc);--> statement-breakpoint
CREATE INDEX `issue_development_link_pr_idx` ON `issue_development_link` (`provider`,`repository`,`number`);--> statement-breakpoint
CREATE INDEX `issue_development_link_sha_idx` ON `issue_development_link` (`provider`,`repository`,`head_sha`);--> statement-breakpoint
CREATE UNIQUE INDEX `issue_development_link_issue_id_provider_repository_external_key_unique` ON `issue_development_link` (`issue_id`,`provider`,`repository`,`external_key`);--> statement-breakpoint
CREATE TABLE `issue_field_option` (
	`issue_id` integer NOT NULL,
	`field_id` integer NOT NULL,
	`option_id` integer NOT NULL,
	PRIMARY KEY(`issue_id`, `field_id`, `option_id`),
	FOREIGN KEY (`issue_id`) REFERENCES `issue`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`field_id`) REFERENCES `custom_field`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`option_id`) REFERENCES `custom_field_option`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `issue_field_value` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`issue_id` integer NOT NULL,
	`field_id` integer NOT NULL,
	`value_text` text,
	`value_number` real,
	`value_bool` integer,
	`value_date` text,
	`value_datetime` integer,
	`value_datetime_end` integer,
	`value_user_id` text,
	FOREIGN KEY (`issue_id`) REFERENCES `issue`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`field_id`) REFERENCES `custom_field`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`value_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issue_field_value_issue_id_field_id_unique` ON `issue_field_value` (`issue_id`,`field_id`);--> statement-breakpoint
CREATE TABLE `issue_import` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`public_id` text NOT NULL,
	`project_id` integer NOT NULL,
	`attachment_id` integer NOT NULL,
	`status` text DEFAULT 'mapped' NOT NULL,
	`mapping` text,
	`error_text` text,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attachment_id`) REFERENCES `chat_attachment`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issue_import_public_id_unique` ON `issue_import` (`public_id`);--> statement-breakpoint
CREATE INDEX `issue_import_project_idx` ON `issue_import` (`project_id`);--> statement-breakpoint
CREATE TABLE `issue_key_alias` (
	`project_id` integer NOT NULL,
	`sequence_number` integer NOT NULL,
	`issue_id` integer NOT NULL,
	PRIMARY KEY(`project_id`, `sequence_number`),
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`issue_id`) REFERENCES `issue`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `issue_key_alias_issue_idx` ON `issue_key_alias` (`issue_id`);--> statement-breakpoint
CREATE TABLE `issue_label` (
	`issue_id` integer NOT NULL,
	`label_id` integer NOT NULL,
	PRIMARY KEY(`issue_id`, `label_id`),
	FOREIGN KEY (`issue_id`) REFERENCES `issue`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`label_id`) REFERENCES `label`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `issue_link` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_issue_id` integer NOT NULL,
	`target_issue_id` integer NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`source_issue_id`) REFERENCES `issue`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_issue_id`) REFERENCES `issue`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "issue_link_kind_check" CHECK("issue_link"."kind" IN ('blocks', 'relates', 'duplicates')),
	CONSTRAINT "issue_link_self_check" CHECK("issue_link"."source_issue_id" <> "issue_link"."target_issue_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issue_link_pair_kind_idx` ON `issue_link` (CASE WHEN "source_issue_id" <= "target_issue_id" THEN "source_issue_id" ELSE "target_issue_id" END,CASE WHEN "source_issue_id" >= "target_issue_id" THEN "source_issue_id" ELSE "target_issue_id" END,`kind`);--> statement-breakpoint
CREATE INDEX `issue_link_source_idx` ON `issue_link` (`source_issue_id`);--> statement-breakpoint
CREATE INDEX `issue_link_target_idx` ON `issue_link` (`target_issue_id`);--> statement-breakpoint
CREATE TABLE `issue_status` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`issue_id` integer NOT NULL,
	`column_id` integer,
	`column_name` text,
	`state_type` text,
	`entered_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	`left_at` integer,
	FOREIGN KEY (`issue_id`) REFERENCES `issue`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`column_id`) REFERENCES `project_column`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `issue_status_issue_idx` ON `issue_status` (`issue_id`,`entered_at`);--> statement-breakpoint
CREATE INDEX `issue_status_column_idx` ON `issue_status` (`column_id`) WHERE "issue_status"."column_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `issue_status_open_idx` ON `issue_status` (`issue_id`) WHERE "issue_status"."left_at" IS NULL;--> statement-breakpoint
CREATE TABLE `issue_template` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`title_template` text DEFAULT '' NOT NULL,
	`description_template` text DEFAULT '' NOT NULL,
	`type_id` integer,
	`column_id` integer,
	`priority` text,
	`assignee_user_id` text,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`type_id`) REFERENCES `issue_type`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`column_id`) REFERENCES `project_column`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`assignee_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issue_template_project_id_name_unique` ON `issue_template` (`project_id`,`name`);--> statement-breakpoint
CREATE TABLE `issue_template_label` (
	`template_id` integer NOT NULL,
	`label_id` integer NOT NULL,
	PRIMARY KEY(`template_id`, `label_id`),
	FOREIGN KEY (`template_id`) REFERENCES `issue_template`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`label_id`) REFERENCES `label`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `issue_type` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`name` text NOT NULL,
	`icon` text DEFAULT '' NOT NULL,
	`color` text DEFAULT '#6b7280' NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issue_type_project_id_name_unique` ON `issue_type` (`project_id`,`name`);--> statement-breakpoint
CREATE TABLE `issue_watcher` (
	`issue_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`subscribed` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	PRIMARY KEY(`issue_id`, `user_id`),
	FOREIGN KEY (`issue_id`) REFERENCES `issue`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `issue_worklog` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`issue_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`minutes` integer NOT NULL,
	`spent_on` text NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issue`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "issue_worklog_minutes_check" CHECK("issue_worklog"."minutes" > 0)
);
--> statement-breakpoint
CREATE INDEX `issue_worklog_issue_idx` ON `issue_worklog` (`issue_id`,"spent_on" desc);--> statement-breakpoint
CREATE TABLE `label` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`group_id` integer,
	`name` text NOT NULL,
	`color` text DEFAULT '#6b7280' NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`) REFERENCES `label_group`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `label_project_id_name_unique` ON `label` (`project_id`,`name`);--> statement-breakpoint
CREATE TABLE `label_group` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT '#6b7280' NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `label_group_project_id_name_unique` ON `label_group` (`project_id`,`name`);--> statement-breakpoint
CREATE TABLE `model_price` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`input` real NOT NULL,
	`output` real NOT NULL,
	`cache_read` real,
	`cache_write` real,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "model_price_rates_check" CHECK("model_price"."input" >= 0 AND "model_price"."output" >= 0 AND coalesce("model_price"."cache_read", 0) >= 0 AND coalesce("model_price"."cache_write", 0) >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_price_workspace_id_provider_model_unique` ON `model_price` (`workspace_id`,`provider`,`model`);--> statement-breakpoint
CREATE TABLE `note_board` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`owner_user_id` text,
	`created_by_user_id` text,
	`name` text NOT NULL,
	`canvas` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `note_board_project_idx` ON `note_board` (`project_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `note_board_member` (
	`board_id` integer NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`board_id`, `user_id`),
	FOREIGN KEY (`board_id`) REFERENCES `note_board`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `note_board_member_user_idx` ON `note_board_member` (`user_id`);--> statement-breakpoint
CREATE TABLE `notification` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`project_id` integer NOT NULL,
	`issue_id` integer NOT NULL,
	`source_activity_id` integer,
	`type` text NOT NULL,
	`actor_user_id` text,
	`actor_name` text,
	`read_at` integer,
	`snoozed_until` integer,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`issue_id`) REFERENCES `issue`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_activity_id`) REFERENCES `issue_activity`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`actor_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "notification_type_check" CHECK("notification"."type" IN ('assigned', 'mentioned', 'commented', 'state_changed'))
);
--> statement-breakpoint
CREATE INDEX `notification_user_idx` ON `notification` (`user_id`,"created_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX `notification_user_unread_idx` ON `notification` (`user_id`,"id" desc) WHERE "notification"."read_at" IS NULL;--> statement-breakpoint
CREATE TABLE `notification_delivery` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`channel` text NOT NULL,
	`recipient` text,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	`last_error` text,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "notification_delivery_channel_check" CHECK("notification_delivery"."channel" IN ('email', 'telegram'))
);
--> statement-breakpoint
CREATE INDEX `notification_delivery_due_idx` ON `notification_delivery` (`next_attempt_at`) WHERE "notification_delivery"."status" = 'pending';--> statement-breakpoint
CREATE TABLE `project` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`team_id` integer NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`next_sequence` integer DEFAULT 1 NOT NULL,
	`mcp_enabled` integer DEFAULT false NOT NULL,
	`initiatives_enabled` integer DEFAULT true NOT NULL,
	`dashboards_enabled` integer DEFAULT true NOT NULL,
	`documents_enabled` integer DEFAULT true NOT NULL,
	`notes_enabled` integer DEFAULT true NOT NULL,
	`cycles_enabled` integer DEFAULT true NOT NULL,
	`subtasks_enabled` integer DEFAULT true NOT NULL,
	`checklists_enabled` integer DEFAULT true NOT NULL,
	`issue_stats_enabled` integer DEFAULT true NOT NULL,
	`points_estimate_enabled` integer DEFAULT false NOT NULL,
	`time_estimate_enabled` integer DEFAULT false NOT NULL,
	`time_logging_enabled` integer DEFAULT false NOT NULL,
	`archived_at` integer,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `team`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_team_key_uq` ON `project` (`team_id`,`key`);--> statement-breakpoint
CREATE TABLE `project_action` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`name` text NOT NULL,
	`icon` text DEFAULT '' NOT NULL,
	`condition` text DEFAULT '{}' NOT NULL,
	`effect` text DEFAULT '{}' NOT NULL,
	`position` real DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `project_action_project_idx` ON `project_action` (`project_id`,`position`);--> statement-breakpoint
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
	CONSTRAINT "project_column_state_type_check" CHECK("project_column"."state_type" IN ('backlog', 'unstarted', 'started', 'completed', 'canceled')),
	CONSTRAINT "project_column_wip_mode_check" CHECK("project_column"."wip_mode" IN ('soft', 'hard')),
	CONSTRAINT "project_column_wip_limit_check" CHECK("project_column"."wip_limit" IS NULL OR "project_column"."wip_limit" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_column_project_id_position_unique` ON `project_column` (`project_id`,`position`);--> statement-breakpoint
CREATE TABLE `project_dashboard` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`name` text NOT NULL,
	`icon` text,
	`layout` text DEFAULT '[]' NOT NULL,
	`position` real DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `project_dashboard_project_idx` ON `project_dashboard` (`project_id`,`position`);--> statement-breakpoint
CREATE TABLE `project_document` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`parent_id` integer,
	`title` text DEFAULT '' NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`content_json` text,
	`icon` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	`full_width` integer DEFAULT false NOT NULL,
	`is_private` integer DEFAULT false NOT NULL,
	`is_locked` integer DEFAULT false NOT NULL,
	`archived_at` integer,
	`archived_by_ancestor_id` integer,
	`position` real DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`owner_user_id` text,
	`created_by_user_id` text,
	`updated_by_user_id` text,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_id`) REFERENCES `project_document`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`archived_by_ancestor_id`) REFERENCES `project_document`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`updated_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "project_document_version_check" CHECK("project_document"."version" > 0)
);
--> statement-breakpoint
CREATE INDEX `project_document_project_tree_idx` ON `project_document` (`project_id`,`parent_id`,`position`,`id`);--> statement-breakpoint
CREATE INDEX `project_document_owner_idx` ON `project_document` (`owner_user_id`);--> statement-breakpoint
CREATE INDEX `project_document_project_archive_idx` ON `project_document` (`project_id`,`archived_at`);--> statement-breakpoint
CREATE TABLE `project_document_initiative` (
	`document_id` integer NOT NULL,
	`initiative_id` integer NOT NULL,
	`created_by_user_id` text,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	PRIMARY KEY(`document_id`, `initiative_id`),
	FOREIGN KEY (`document_id`) REFERENCES `project_document`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`initiative_id`) REFERENCES `initiative`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `project_document_initiative_initiative_idx` ON `project_document_initiative` (`initiative_id`,`document_id`);--> statement-breakpoint
CREATE TABLE `project_document_issue` (
	`document_id` integer NOT NULL,
	`issue_id` integer NOT NULL,
	`created_by_user_id` text,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	PRIMARY KEY(`document_id`, `issue_id`),
	FOREIGN KEY (`document_id`) REFERENCES `project_document`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`issue_id`) REFERENCES `issue`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `project_document_issue_issue_idx` ON `project_document_issue` (`issue_id`,`document_id`);--> statement-breakpoint
CREATE TABLE `project_document_preference` (
	`document_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`is_favorite` integer DEFAULT false NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	PRIMARY KEY(`document_id`, `user_id`),
	FOREIGN KEY (`document_id`) REFERENCES `project_document`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `project_document_preference_user_idx` ON `project_document_preference` (`user_id`);--> statement-breakpoint
CREATE TABLE `project_document_revision` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_id` integer NOT NULL,
	`version` integer NOT NULL,
	`parent_id` integer,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`content_json` text,
	`icon` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	`full_width` integer DEFAULT false NOT NULL,
	`is_private` integer DEFAULT false NOT NULL,
	`is_locked` integer DEFAULT false NOT NULL,
	`archived_at` integer,
	`position` real NOT NULL,
	`owner_user_id` text,
	`created_by_user_id` text,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `project_document`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `project_document_revision_document_idx` ON `project_document_revision` (`document_id`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_document_revision_document_version_unique` ON `project_document_revision` (`document_id`,`version`);--> statement-breakpoint
CREATE TABLE `project_member` (
	`project_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`role_id` integer,
	`description` text DEFAULT '' NOT NULL,
	`source` text DEFAULT 'invite' NOT NULL,
	`is_favorite` integer DEFAULT false NOT NULL,
	`is_hidden` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	PRIMARY KEY(`project_id`, `user_id`),
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`role_id`) REFERENCES `team_role`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "project_member_role_check" CHECK("project_member"."role" IN ('owner', 'member')),
	CONSTRAINT "project_member_source_check" CHECK("project_member"."source" IN ('invite', 'scim'))
);
--> statement-breakpoint
CREATE INDEX `project_member_user_idx` ON `project_member` (`user_id`);--> statement-breakpoint
CREATE TABLE `project_setting` (
	`project_id` integer NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	PRIMARY KEY(`project_id`, `key`),
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `project_view` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`name` text NOT NULL,
	`icon` text,
	`filters` text DEFAULT '{}' NOT NULL,
	`display` text DEFAULT '{}' NOT NULL,
	`position` real DEFAULT 0 NOT NULL,
	`share_token` text,
	`share_extended` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_view_share_token_unique` ON `project_view` (`share_token`);--> statement-breakpoint
CREATE INDEX `project_view_project_idx` ON `project_view` (`project_id`,`position`);--> statement-breakpoint
CREATE TABLE `project_view_favorite` (
	`view_id` integer NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`view_id`, `user_id`),
	FOREIGN KEY (`view_id`) REFERENCES `project_view`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `revision` (
	`scope` text PRIMARY KEY NOT NULL,
	`project_id` integer NOT NULL,
	`rev` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `revision_project_idx` ON `revision` (`project_id`);--> statement-breakpoint
CREATE TABLE `team` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`name` text NOT NULL,
	`slug` text,
	`mcp_enabled` integer DEFAULT true NOT NULL,
	`default_agent_ids` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `team_slug_unique` ON `team` (`slug`);--> statement-breakpoint
CREATE INDEX `team_workspace_idx` ON `team` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `team_invite` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token` text NOT NULL,
	`team_id` integer NOT NULL,
	`project_id` integer,
	`email` text NOT NULL,
	`team_role` text DEFAULT 'member' NOT NULL,
	`project_role` text,
	`role_id` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`invited_by_user_id` text,
	`accepted_by_user_id` text,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	`responded_at` integer,
	FOREIGN KEY (`team_id`) REFERENCES `team`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`role_id`) REFERENCES `team_role`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`invited_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`accepted_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "team_invite_team_role_check" CHECK("team_invite"."team_role" IN ('owner', 'manager', 'member')),
	CONSTRAINT "team_invite_project_role_check" CHECK(("team_invite"."project_id" IS NULL AND "team_invite"."project_role" IS NULL)
        OR ("team_invite"."project_id" IS NOT NULL AND "team_invite"."project_role" IN ('owner', 'member'))),
	CONSTRAINT "team_invite_status_check" CHECK("team_invite"."status" IN ('pending', 'accepted', 'rejected'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `team_invite_token_unique` ON `team_invite` (`token`);--> statement-breakpoint
CREATE UNIQUE INDEX `team_invite_team_pending_uq` ON `team_invite` (`team_id`,`email`) WHERE "team_invite"."status" = 'pending' AND "team_invite"."project_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `team_invite_project_pending_uq` ON `team_invite` (`project_id`,`email`) WHERE "team_invite"."status" = 'pending' AND "team_invite"."project_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `team_invite_team_idx` ON `team_invite` (`team_id`);--> statement-breakpoint
CREATE INDEX `team_invite_project_idx` ON `team_invite` (`project_id`);--> statement-breakpoint
CREATE TABLE `team_member` (
	`team_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`source` text DEFAULT 'invite' NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	PRIMARY KEY(`team_id`, `user_id`),
	FOREIGN KEY (`team_id`) REFERENCES `team`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "team_member_role_check" CHECK("team_member"."role" IN ('owner', 'manager', 'member', 'agent')),
	CONSTRAINT "team_member_source_check" CHECK("team_member"."source" IN ('invite', 'scim'))
);
--> statement-breakpoint
CREATE INDEX `team_member_user_idx` ON `team_member` (`user_id`);--> statement-breakpoint
CREATE TABLE `team_notification_setting` (
	`team_id` integer PRIMARY KEY NOT NULL,
	`ciphertext` text NOT NULL,
	`iv` text NOT NULL,
	`auth_tag` text NOT NULL,
	`redacted` text DEFAULT '{}' NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `team`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `team_role` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`team_id` integer NOT NULL,
	`name` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`permissions` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `team`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `team_role_default_uq` ON `team_role` (`team_id`) WHERE "team_role"."is_default";--> statement-breakpoint
CREATE INDEX `team_role_team_idx` ON `team_role` (`team_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `team_role_team_id_name_unique` ON `team_role` (`team_id`,`name`);--> statement-breakpoint
CREATE TABLE `trigger_flag` (
	`name` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_notification_preference` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`project_id` integer NOT NULL,
	`email_events` text DEFAULT '{}' NOT NULL,
	`telegram_events` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_notification_pref_user_project_unique` ON `user_notification_preference` (`user_id`,`project_id`);--> statement-breakpoint
CREATE TABLE `user_preference` (
	`user_id` text PRIMARY KEY NOT NULL,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`locale` text DEFAULT 'en' NOT NULL,
	`theme` text DEFAULT 'system' NOT NULL,
	`issue_open_mode` text DEFAULT 'panel' NOT NULL,
	`start_page` text DEFAULT 'work-items' NOT NULL,
	`show_chat_by_default` integer DEFAULT false NOT NULL,
	`issue_stats_open` integer DEFAULT true NOT NULL,
	`issue_stats_view` text DEFAULT 'compact' NOT NULL,
	`issue_activity_view` text DEFAULT 'flat' NOT NULL,
	`auto_watch` integer DEFAULT true NOT NULL,
	`hotkeys` text,
	`last_project_id` integer,
	`seen_version` text,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`last_project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "user_preference_theme_check" CHECK("user_preference"."theme" IN ('light', 'dark', 'system')),
	CONSTRAINT "user_preference_issue_open_mode_check" CHECK("user_preference"."issue_open_mode" IN ('panel', 'page')),
	CONSTRAINT "user_preference_start_page_check" CHECK("user_preference"."start_page" IN ('inbox', 'dashboard', 'work-items', 'initiatives')),
	CONSTRAINT "user_preference_issue_stats_view_check" CHECK("user_preference"."issue_stats_view" IN ('compact', 'timeline')),
	CONSTRAINT "user_preference_issue_activity_view_check" CHECK("user_preference"."issue_activity_view" IN ('flat', 'grouped'))
);
--> statement-breakpoint
CREATE TABLE `user_telegram_account` (
	`user_id` text PRIMARY KEY NOT NULL,
	`chat_id` text,
	`username` text,
	`first_name` text,
	`link_code` text,
	`link_code_expires_at` integer,
	`linked_at` integer,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_telegram_account_chat_id_unique` ON `user_telegram_account` (`chat_id`) WHERE "user_telegram_account"."chat_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `user_telegram_account_link_code_unique` ON `user_telegram_account` (`link_code`) WHERE "user_telegram_account"."link_code" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `webhook` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`url` text NOT NULL,
	`secret` text NOT NULL,
	`events` text DEFAULT '[]' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `webhook_project_idx` ON `webhook` (`project_id`);--> statement-breakpoint
CREATE TABLE `webhook_delivery` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`webhook_id` integer NOT NULL,
	`event_id` text NOT NULL,
	`event_type` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	`last_error` text,
	`response_status` integer,
	`response_body` text,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`webhook_id`) REFERENCES `webhook`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `webhook_delivery_due_idx` ON `webhook_delivery` (`next_attempt_at`) WHERE "webhook_delivery"."status" = 'pending';--> statement-breakpoint
CREATE INDEX `webhook_delivery_webhook_idx` ON `webhook_delivery` (`webhook_id`);--> statement-breakpoint
CREATE TABLE `workspace` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`team_creation` text DEFAULT 'owner' NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	CONSTRAINT "workspace_team_creation_check" CHECK("workspace"."team_creation" IN ('owner', 'managers', 'members'))
);
--> statement-breakpoint
CREATE TABLE `workspace_manager` (
	`workspace_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'admin' NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	PRIMARY KEY(`workspace_id`, `user_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "workspace_manager_role_check" CHECK("workspace_manager"."role" IN ('owner', 'admin'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_manager_owner_uq` ON `workspace_manager` (`workspace_id`) WHERE "workspace_manager"."role" = 'owner';--> statement-breakpoint
CREATE INDEX `workspace_manager_user_idx` ON `workspace_manager` (`user_id`);--> statement-breakpoint
CREATE TABLE `scim_group` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` integer,
	`display_name` text NOT NULL,
	`external_id` text,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_group_instance_display_name_uq` ON `scim_group` (`display_name`) WHERE "scim_group"."workspace_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `scim_group_workspace_id_display_name_unique` ON `scim_group` (`workspace_id`,`display_name`);--> statement-breakpoint
CREATE TABLE `scim_group_mapping` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`group_id` text NOT NULL,
	`project_id` integer NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`role_id` integer,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `scim_group`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`role_id`) REFERENCES `team_role`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "scim_group_mapping_role_check" CHECK("scim_group_mapping"."role" IN ('owner', 'member'))
);
--> statement-breakpoint
CREATE INDEX `scim_group_mapping_project_idx` ON `scim_group_mapping` (`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `scim_group_mapping_group_id_project_id_unique` ON `scim_group_mapping` (`group_id`,`project_id`);--> statement-breakpoint
CREATE TABLE `scim_group_member` (
	`group_id` text NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`group_id`, `user_id`),
	FOREIGN KEY (`group_id`) REFERENCES `scim_group`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `scim_group_member_user_idx` ON `scim_group_member` (`user_id`);--> statement-breakpoint
CREATE TABLE `scim_user` (
	`workspace_id` integer,
	`user_id` text NOT NULL,
	`external_id` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_user_instance_user_uq` ON `scim_user` (`user_id`) WHERE "scim_user"."workspace_id" IS NULL;--> statement-breakpoint
CREATE INDEX `scim_user_user_idx` ON `scim_user` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `scim_user_workspace_id_user_id_unique` ON `scim_user` (`workspace_id`,`user_id`);