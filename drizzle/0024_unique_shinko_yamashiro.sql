ALTER TABLE `runs` ADD `archived_at` datetime(3);--> statement-breakpoint
CREATE INDEX `runs_owner_archived_created_idx` ON `runs` (`owner_user_id`,`archived_at`,`created_at`);