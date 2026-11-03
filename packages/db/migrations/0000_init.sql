CREATE TABLE `allocations` (
	`id` text PRIMARY KEY NOT NULL,
	`lot_id` text NOT NULL,
	`site_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`kind` text NOT NULL,
	`actor` text NOT NULL,
	`commit_key` text NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`lot_id`) REFERENCES `lots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `allocations_lot` ON `allocations` (`lot_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `allocations_commit_site` ON `allocations` (`commit_key`,`site_id`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text NOT NULL,
	`action` text NOT NULL,
	`actor` text NOT NULL,
	`payload_json` text NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_entity` ON `audit_log` (`entity`,`entity_id`);--> statement-breakpoint
CREATE INDEX `audit_at` ON `audit_log` (`at`);--> statement-breakpoint
CREATE TABLE `dead_letters` (
	`id` text PRIMARY KEY NOT NULL,
	`queue` text NOT NULL,
	`body_json` text NOT NULL,
	`attempts` integer NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `drugs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`ndc` text,
	`drug_class` text NOT NULL,
	`tier` integer NOT NULL,
	`unit` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `lots` (
	`id` text PRIMARY KEY NOT NULL,
	`notice_id` text NOT NULL,
	`drug_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`remaining` integer NOT NULL,
	`eta` text,
	`status` text NOT NULL,
	`action` text NOT NULL,
	`rule_id` text,
	`policy_version` integer,
	`hard_floor` text,
	`proposal_json` text NOT NULL,
	`explanation` text NOT NULL,
	`substitute_id` text,
	`substitute_status` text,
	`finalizes_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`notice_id`) REFERENCES `notices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`drug_id`) REFERENCES `drugs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`substitute_id`) REFERENCES `drugs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `lots_notice` ON `lots` (`notice_id`);--> statement-breakpoint
CREATE INDEX `lots_status` ON `lots` (`status`);--> statement-breakpoint
CREATE TABLE `notices` (
	`id` text PRIMARY KEY NOT NULL,
	`r2_key` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`status` text NOT NULL,
	`wholesaler` text,
	`notice_ref` text,
	`confidence` real,
	`error` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `policy_versions` (
	`version` integer PRIMARY KEY NOT NULL,
	`rules_json` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sites` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`region` text NOT NULL,
	`acuity` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `stock` (
	`site_id` text NOT NULL,
	`drug_id` text NOT NULL,
	`on_hand` integer NOT NULL,
	`inbound` integer DEFAULT 0 NOT NULL,
	`daily_demand` real NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`drug_id`) REFERENCES `drugs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stock_site_drug` ON `stock` (`site_id`,`drug_id`);--> statement-breakpoint
CREATE TABLE `substitutes` (
	`drug_id` text NOT NULL,
	`substitute_id` text NOT NULL,
	`note` text NOT NULL,
	FOREIGN KEY (`drug_id`) REFERENCES `drugs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`substitute_id`) REFERENCES `drugs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `substitutes_pair` ON `substitutes` (`drug_id`,`substitute_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`email` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL
);
