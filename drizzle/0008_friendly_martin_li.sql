DROP INDEX `jobs_claim_idx` ON `jobs`;--> statement-breakpoint
ALTER TABLE `jobs` ADD `dispatch_ready_at` datetime(3) DEFAULT CURRENT_TIMESTAMP(3);--> statement-breakpoint
CREATE INDEX `jobs_claim_idx` ON `jobs` (`status`,`kind`,`dispatch_ready_at`,`lease_expires_at`);