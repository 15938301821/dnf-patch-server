CREATE TABLE `browser_sessions` (
	`id` varchar(64) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`refresh_token_sha256` varchar(64) NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`revoked_at` datetime(3),
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `browser_sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `browser_sessions_user_uq` UNIQUE(`user_id`),
	CONSTRAINT `browser_sessions_refresh_sha256_uq` UNIQUE(`refresh_token_sha256`)
);
--> statement-breakpoint
ALTER TABLE `browser_sessions` ADD CONSTRAINT `browser_sessions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `browser_sessions_active_idx` ON `browser_sessions` (`revoked_at`,`expires_at`);