CREATE TABLE `cover_history` (
	`day` text NOT NULL,
	`site_id` text NOT NULL,
	`drug_id` text NOT NULL,
	`cover` real NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`drug_id`) REFERENCES `drugs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cover_history_key` ON `cover_history` (`day`,`site_id`,`drug_id`);--> statement-breakpoint
ALTER TABLE `lots` ADD `precedent_note` text;--> statement-breakpoint
ALTER TABLE `lots` ADD `precedent_sources_json` text;