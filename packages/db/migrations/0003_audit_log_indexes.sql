CREATE INDEX `audit_entity_id` ON `audit_log` (`entity_id`);--> statement-breakpoint
CREATE INDEX `audit_action` ON `audit_log` (`action`);