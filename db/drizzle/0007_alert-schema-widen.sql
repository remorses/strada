-- Widen alert schema for multi-type rules (error_threshold, health_check),
-- org-scoped destinations with many-to-many junction, and new channel types
-- (slack). No backwards compat: drops and recreates tables.

DROP TABLE IF EXISTS `alert_destination`;
--> statement-breakpoint
DROP TABLE IF EXISTS `alert_rule`;
--> statement-breakpoint
CREATE TABLE `alert_rule` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`type` text DEFAULT 'error_threshold' NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`cooldown_minutes` integer DEFAULT 60 NOT NULL,
	`last_alerted_at` integer,
	`error_threshold` integer,
	`error_window_minutes` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `org`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `alert_rule_org_id_idx` ON `alert_rule` (`org_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `alert_rule_org_id_type_name_unique` ON `alert_rule` (`org_id`, `type`, `name`);
--> statement-breakpoint
CREATE TABLE `alert_destination` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`channel` text NOT NULL,
	`destination` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `org`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `alert_destination_org_id_idx` ON `alert_destination` (`org_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `alert_destination_unique` ON `alert_destination` (`org_id`, `channel`, `destination`);
--> statement-breakpoint
CREATE TABLE `alert_rule_destination` (
	`rule_id` text NOT NULL,
	`destination_id` text NOT NULL,
	FOREIGN KEY (`rule_id`) REFERENCES `alert_rule`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`destination_id`) REFERENCES `alert_destination`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alert_rule_destination_unique` ON `alert_rule_destination` (`rule_id`, `destination_id`);
--> statement-breakpoint
CREATE INDEX `alert_rule_destination_rule_id_idx` ON `alert_rule_destination` (`rule_id`);
--> statement-breakpoint
CREATE INDEX `alert_rule_destination_destination_id_idx` ON `alert_rule_destination` (`destination_id`);
