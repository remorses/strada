-- Keep all raw telemetry unless a project sets a custom TTL.
-- 0012 added NOT NULL defaults. Drop and re-add as nullable with no default.
ALTER TABLE `project` DROP COLUMN `traces_retention_days`;--> statement-breakpoint
ALTER TABLE `project` DROP COLUMN `logs_retention_days`;--> statement-breakpoint
ALTER TABLE `project` DROP COLUMN `errors_retention_days`;--> statement-breakpoint
ALTER TABLE `project` DROP COLUMN `metrics_retention_days`;--> statement-breakpoint
ALTER TABLE `project` ADD COLUMN `traces_retention_days` integer CHECK (`traces_retention_days` IS NULL OR `traces_retention_days` BETWEEN 1 AND 365);--> statement-breakpoint
ALTER TABLE `project` ADD COLUMN `logs_retention_days` integer CHECK (`logs_retention_days` IS NULL OR `logs_retention_days` BETWEEN 1 AND 365);--> statement-breakpoint
ALTER TABLE `project` ADD COLUMN `errors_retention_days` integer CHECK (`errors_retention_days` IS NULL OR `errors_retention_days` BETWEEN 1 AND 365);--> statement-breakpoint
ALTER TABLE `project` ADD COLUMN `metrics_retention_days` integer CHECK (`metrics_retention_days` IS NULL OR `metrics_retention_days` BETWEEN 1 AND 365);
