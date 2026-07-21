CREATE TABLE `user_model_configurations` (
	`id` varchar(64) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`role` varchar(32) NOT NULL,
	`endpoint` varchar(500) NOT NULL,
	`model` varchar(120) NOT NULL,
	`credential_ciphertext` text NOT NULL,
	`credential_nonce` varchar(32) NOT NULL,
	`credential_tag` varchar(32) NOT NULL,
	`credential_key_version` varchar(32) NOT NULL,
	`version` int unsigned NOT NULL DEFAULT 1,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `user_model_configurations_id` PRIMARY KEY(`id`),
	CONSTRAINT `user_model_configurations_user_role_uq` UNIQUE(`user_id`,`role`),
	CONSTRAINT `user_model_configurations_role_ck` CHECK(`user_model_configurations`.`role` in ('orchestrator', 'spriteProcessor', 'referenceGenerator'))
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` varchar(64) NOT NULL,
	`username` varchar(64) NOT NULL,
	`normalized_username` varchar(64) NOT NULL,
	`display_name` varchar(160) NOT NULL,
	`password_scheme` varchar(32) NOT NULL,
	`password_salt` varchar(64) NOT NULL,
	`password_hash` varchar(128) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_normalized_username_uq` UNIQUE(`normalized_username`)
);
--> statement-breakpoint
ALTER TABLE `model_calls` ADD `model_configuration_version` int unsigned;--> statement-breakpoint
ALTER TABLE `runs` ADD `owner_user_id` varchar(64);--> statement-breakpoint
ALTER TABLE `user_model_configurations` ADD CONSTRAINT `user_model_configurations_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `runs` ADD CONSTRAINT `runs_owner_user_id_users_id_fk` FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `runs_owner_user_idx` ON `runs` (`owner_user_id`);