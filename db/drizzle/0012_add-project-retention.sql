-- Per-project Tinybird TTL. Custom values are applied as ENGINE_TTL DELETE WHERE
-- rules during database upgrade. Range is 1..365 because tables partition by day.
-- Column CHECKs live on ADD COLUMN because SQLite cannot ALTER ADD TABLE CONSTRAINT.
ALTER TABLE `project` ADD COLUMN `traces_retention_days` integer DEFAULT 14 NOT NULL CHECK (`traces_retention_days` BETWEEN 1 AND 365);--> statement-breakpoint
ALTER TABLE `project` ADD COLUMN `logs_retention_days` integer DEFAULT 30 NOT NULL CHECK (`logs_retention_days` BETWEEN 1 AND 365);--> statement-breakpoint
ALTER TABLE `project` ADD COLUMN `errors_retention_days` integer DEFAULT 90 NOT NULL CHECK (`errors_retention_days` BETWEEN 1 AND 365);--> statement-breakpoint
ALTER TABLE `project` ADD COLUMN `metrics_retention_days` integer DEFAULT 90 NOT NULL CHECK (`metrics_retention_days` BETWEEN 1 AND 365);
