CREATE TABLE `project_tree` (
	`project_id` integer PRIMARY KEY NOT NULL,
	`rev` integer DEFAULT 0 NOT NULL,
	`last_tx` text,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
