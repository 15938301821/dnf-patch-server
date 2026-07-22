CREATE TABLE `artifact_upload_sessions` (
	`id` varchar(64) NOT NULL,
	`run_id` varchar(64) NOT NULL,
	`job_id` varchar(64) NOT NULL,
	`worker_id` varchar(64) NOT NULL,
	`lease_id` varchar(64) NOT NULL,
	`attempt` int unsigned NOT NULL,
	`object_key` varchar(500) NOT NULL,
	`logical_name` varchar(200) NOT NULL,
	`media_type` varchar(120) NOT NULL,
	`expected_byte_length` int unsigned NOT NULL,
	`expected_sha256` varchar(64) NOT NULL,
	`provenance` json NOT NULL,
	`status` varchar(32) NOT NULL,
	`artifact_id` varchar(64),
	`error_code` varchar(80),
	`expires_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`finalized_at` datetime(3),
	`object_deleted_at` datetime(3),
	CONSTRAINT `artifact_upload_sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `artifact_upload_sessions_object_key_uq` UNIQUE(`object_key`),
	CONSTRAINT `artifact_upload_sessions_artifact_uq` UNIQUE(`artifact_id`),
	CONSTRAINT `artifact_upload_sessions_status_ck` CHECK(`artifact_upload_sessions`.`status` in ('authorized', 'finalized', 'rejected')),
	CONSTRAINT `artifact_upload_sessions_state_ck` CHECK((`artifact_upload_sessions`.`status` = 'authorized' and `artifact_upload_sessions`.`artifact_id` is null and `artifact_upload_sessions`.`error_code` is null and `artifact_upload_sessions`.`finalized_at` is null and `artifact_upload_sessions`.`object_deleted_at` is null) or (`artifact_upload_sessions`.`status` = 'finalized' and `artifact_upload_sessions`.`artifact_id` is not null and `artifact_upload_sessions`.`error_code` is null and `artifact_upload_sessions`.`finalized_at` is not null and `artifact_upload_sessions`.`object_deleted_at` is null) or (`artifact_upload_sessions`.`status` = 'rejected' and `artifact_upload_sessions`.`artifact_id` is null and `artifact_upload_sessions`.`error_code` is not null and `artifact_upload_sessions`.`finalized_at` is null)),
	CONSTRAINT `artifact_upload_sessions_expiry_ck` CHECK(`artifact_upload_sessions`.`expires_at` > `artifact_upload_sessions`.`created_at`),
	CONSTRAINT `artifact_upload_sessions_object_key_ck` CHECK(`artifact_upload_sessions`.`object_key` like 'artifacts/%')
);
--> statement-breakpoint
ALTER TABLE `job_attempts` ADD CONSTRAINT `job_attempts_lease_evidence_uq` UNIQUE(`job_id`,`attempt`,`worker_id`,`lease_id`);--> statement-breakpoint
ALTER TABLE `artifact_upload_sessions` ADD CONSTRAINT `artifact_upload_sessions_run_id_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `artifact_upload_sessions` ADD CONSTRAINT `artifact_upload_sessions_worker_id_workers_id_fk` FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `artifact_upload_sessions` ADD CONSTRAINT `artifact_upload_sessions_job_run_fk` FOREIGN KEY (`run_id`,`job_id`) REFERENCES `jobs`(`run_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `artifact_upload_sessions` ADD CONSTRAINT `artifact_upload_sessions_attempt_lease_fk` FOREIGN KEY (`job_id`,`attempt`,`worker_id`,`lease_id`) REFERENCES `job_attempts`(`job_id`,`attempt`,`worker_id`,`lease_id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `artifact_upload_sessions` ADD CONSTRAINT `artifact_upload_sessions_artifact_run_fk` FOREIGN KEY (`run_id`,`artifact_id`) REFERENCES `artifacts`(`run_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `artifact_upload_sessions_run_status_idx` ON `artifact_upload_sessions` (`run_id`,`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `artifact_upload_sessions_orphan_idx` ON `artifact_upload_sessions` (`object_deleted_at`,`status`,`expires_at`);