CREATE TABLE `issue` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`fingerprint_hash` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`assignee_member_id` text,
	`resolved_at` integer,
	`resolved_by_member_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_issue_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_issue_assignee_member_id_org_member_id_fk` FOREIGN KEY (`assignee_member_id`) REFERENCES `org_member`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_issue_resolved_by_member_id_org_member_id_fk` FOREIGN KEY (`resolved_by_member_id`) REFERENCES `org_member`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issue_project_fingerprint_unique` ON `issue` (`project_id`,`fingerprint_hash`);--> statement-breakpoint
CREATE INDEX `issue_project_id_idx` ON `issue` (`project_id`);--> statement-breakpoint
CREATE INDEX `issue_assignee_member_id_idx` ON `issue` (`assignee_member_id`);