ALTER TABLE `professions` DROP INDEX `professions_slug_uq`;--> statement-breakpoint
ALTER TABLE `professions` DROP INDEX `professions_canonical_name_uq`;--> statement-breakpoint
ALTER TABLE `professions` ADD `owner_user_id` varchar(64);--> statement-breakpoint
ALTER TABLE `professions` ADD CONSTRAINT `professions_owner_slug_uq` UNIQUE(`owner_user_id`,`slug`);--> statement-breakpoint
ALTER TABLE `professions` ADD CONSTRAINT `professions_owner_canonical_name_uq` UNIQUE(`owner_user_id`,`canonical_name`);--> statement-breakpoint
ALTER TABLE `professions` ADD CONSTRAINT `professions_owner_user_id_users_id_fk` FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `professions_owner_user_idx` ON `professions` (`owner_user_id`);