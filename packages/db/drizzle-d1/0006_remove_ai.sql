PRAGMA defer_foreign_keys = true;--> statement-breakpoint
DROP TRIGGER IF EXISTS `agent_run_rev_i`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `agent_run_rev_u`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `agent_run_rev_d`;--> statement-breakpoint
UPDATE `issue` SET `delegate_user_id` = NULL WHERE `delegate_user_id` IS NOT NULL;--> statement-breakpoint
DROP TABLE `agent_chat_event`;--> statement-breakpoint
DROP TABLE `agent_chat_favorite`;--> statement-breakpoint
DROP TABLE `agent_chat_usage`;--> statement-breakpoint
DROP TABLE `agent_chat_message`;--> statement-breakpoint
DROP TABLE `agent_chat_thread`;--> statement-breakpoint
DROP TABLE `agent_field_trigger`;--> statement-breakpoint
DROP TABLE `agent_run_trace`;--> statement-breakpoint
DROP TABLE `agent_run`;--> statement-breakpoint
DROP TABLE `agent_schedule`;--> statement-breakpoint
DROP TABLE `agent_skill_link`;--> statement-breakpoint
DROP TABLE `agent_skill`;--> statement-breakpoint
DROP TABLE `agent_tool_link`;--> statement-breakpoint
DROP TABLE `agent_tool`;--> statement-breakpoint
DROP TABLE `ai_agent`;--> statement-breakpoint
DROP TABLE `issue_import`;--> statement-breakpoint
DROP TABLE `chat_attachment`;--> statement-breakpoint
DROP TABLE `integration_credential`;--> statement-breakpoint
DROP TABLE `model_price`;--> statement-breakpoint
DROP TABLE `ai_spans`;--> statement-breakpoint
ALTER TABLE `team` DROP COLUMN `default_agent_ids`;--> statement-breakpoint
ALTER TABLE `user_preference` DROP COLUMN `show_chat_by_default`;
