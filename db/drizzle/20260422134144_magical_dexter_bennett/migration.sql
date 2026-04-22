CREATE TABLE `account` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`id_token` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_account_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `database` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`backend` text NOT NULL,
	`tinybird_endpoint` text,
	`tinybird_admin_token` text,
	`tinybird_read_token` text,
	`clickhouse_url` text,
	`clickhouse_database` text,
	`clickhouse_user` text,
	`clickhouse_password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_database_org_id_org_id_fk` FOREIGN KEY (`org_id`) REFERENCES `org`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `device_code` (
	`id` text PRIMARY KEY,
	`device_code` text NOT NULL UNIQUE,
	`user_code` text NOT NULL UNIQUE,
	`user_id` text,
	`expires_at` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`last_polled_at` integer,
	`polling_interval` integer,
	`client_id` text,
	`scope` text,
	CONSTRAINT `fk_device_code_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `org` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `org_member` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_org_member_org_id_org_id_fk` FOREIGN KEY (`org_id`) REFERENCES `org`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_org_member_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `project` (
	`id` text PRIMARY KEY,
	`slug` text NOT NULL,
	`org_id` text NOT NULL,
	`database_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_project_org_id_org_id_fk` FOREIGN KEY (`org_id`) REFERENCES `org`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_project_database_id_database_id_fk` FOREIGN KEY (`database_id`) REFERENCES `database`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `project_token` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`hashed_key` text NOT NULL,
	`scope` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_project_token_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_project_token_created_by_user_id_fk` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`token` text NOT NULL UNIQUE,
	`expires_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_session_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`email` text NOT NULL UNIQUE,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `account_user_id_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE INDEX `database_org_id_idx` ON `database` (`org_id`);--> statement-breakpoint
CREATE INDEX `device_code_user_id_idx` ON `device_code` (`user_id`);--> statement-breakpoint
CREATE INDEX `org_member_org_id_idx` ON `org_member` (`org_id`);--> statement-breakpoint
CREATE INDEX `org_member_user_id_idx` ON `org_member` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `org_member_org_id_user_id_unique` ON `org_member` (`org_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `project_org_id_idx` ON `project` (`org_id`);--> statement-breakpoint
CREATE INDEX `project_database_id_idx` ON `project` (`database_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_org_id_slug_unique` ON `project` (`org_id`,`slug`);--> statement-breakpoint
CREATE INDEX `project_token_project_id_idx` ON `project_token` (`project_id`);--> statement-breakpoint
CREATE INDEX `project_token_hashed_key_idx` ON `project_token` (`hashed_key`);--> statement-breakpoint
CREATE INDEX `session_user_id_idx` ON `session` (`user_id`);