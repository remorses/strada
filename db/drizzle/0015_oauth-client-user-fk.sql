-- Better Auth oauthClient.userId has no onDelete. CASCADE fights token rows
-- that reference oauth_client with NO ACTION. Recreate the FK without CASCADE.
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `oauth_client_new` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL UNIQUE,
	`client_secret` text,
	`client_discovery_id` text,
	`disabled` integer DEFAULT false,
	`skip_consent` integer,
	`enable_end_session` integer,
	`subject_type` text,
	`scopes` text,
	`client_credentials_scopes` text,
	`user_id` text,
	`created_at` integer,
	`updated_at` integer,
	`name` text,
	`uri` text,
	`icon` text,
	`contacts` text,
	`tos` text,
	`policy` text,
	`software_id` text,
	`software_version` text,
	`software_statement` text,
	`redirect_uris` text NOT NULL,
	`post_logout_redirect_uris` text,
	`backchannel_logout_uri` text,
	`backchannel_logout_session_required` integer,
	`token_endpoint_auth_method` text,
	`application_type` text,
	`jwks` text,
	`jwks_uri` text,
	`grant_types` text,
	`response_types` text,
	`require_pkce` integer,
	`dpop_bound_access_tokens` integer DEFAULT false,
	`reference_id` text,
	`metadata` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `oauth_client_new` SELECT * FROM `oauth_client`;
--> statement-breakpoint
DROP TABLE `oauth_client`;
--> statement-breakpoint
ALTER TABLE `oauth_client_new` RENAME TO `oauth_client`;
--> statement-breakpoint
CREATE INDEX `oauth_client_user_id_idx` ON `oauth_client` (`user_id`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
