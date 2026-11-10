ALTER TABLE `lots` ADD `rerouted_to` text;--> statement-breakpoint
ALTER TABLE `lots` ADD `rerouted_version` integer;--> statement-breakpoint
ALTER TABLE `lots` ADD `rerouted_at` integer;--> statement-breakpoint
ALTER TABLE `notices` ADD `dismissed_reason` text;--> statement-breakpoint
ALTER TABLE `notices` ADD `dismissed_by` text;--> statement-breakpoint
ALTER TABLE `notices` ADD `dismissed_at` integer;