CREATE TABLE `style_package_attempt_evidences` (
	`id` varchar(64) NOT NULL,
	`run_id` varchar(64) NOT NULL,
	`style_package_id` varchar(64) NOT NULL,
	`job_id` varchar(64) NOT NULL,
	`worker_id` varchar(64) NOT NULL,
	`lease_id` varchar(64) NOT NULL,
	`attempt` int unsigned NOT NULL,
	`status` varchar(32) NOT NULL,
	`package_context_sha256` varchar(64) NOT NULL,
	`package_profile_sha256` varchar(64) NOT NULL,
	`package_artifact_id` varchar(64),
	`package_sha256` varchar(64),
	`package_upload_id` varchar(64),
	`manifest_artifact_id` varchar(64),
	`manifest_sha256` varchar(64),
	`manifest_upload_id` varchar(64),
	`validation_artifact_id` varchar(64),
	`validation_sha256` varchar(64),
	`validation_upload_id` varchar(64),
	`safety` json NOT NULL,
	`error_code` varchar(80),
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`finished_at` datetime(3),
	CONSTRAINT `style_package_attempt_evidences_id` PRIMARY KEY(`id`),
	CONSTRAINT `style_package_attempt_evidences_attempt_uq` UNIQUE(`job_id`,`attempt`),
	CONSTRAINT `style_package_attempt_evidences_status_ck` CHECK(`style_package_attempt_evidences`.`status` in ('building', 'passed', 'failed', 'blocked')),
	CONSTRAINT `style_package_attempt_evidences_passed_ck` CHECK(`style_package_attempt_evidences`.`status` <> 'passed' or (`style_package_attempt_evidences`.`package_artifact_id` is not null and `style_package_attempt_evidences`.`package_sha256` is not null and `style_package_attempt_evidences`.`package_upload_id` is not null and `style_package_attempt_evidences`.`manifest_artifact_id` is not null and `style_package_attempt_evidences`.`manifest_sha256` is not null and `style_package_attempt_evidences`.`manifest_upload_id` is not null and `style_package_attempt_evidences`.`validation_artifact_id` is not null and `style_package_attempt_evidences`.`validation_sha256` is not null and `style_package_attempt_evidences`.`validation_upload_id` is not null and `style_package_attempt_evidences`.`error_code` is null and `style_package_attempt_evidences`.`finished_at` is not null)),
	CONSTRAINT `style_package_attempt_evidences_terminal_error_ck` CHECK(`style_package_attempt_evidences`.`status` not in ('failed', 'blocked') or (`style_package_attempt_evidences`.`error_code` is not null and `style_package_attempt_evidences`.`finished_at` is not null)),
	CONSTRAINT `style_package_attempt_evidences_non_passed_ck` CHECK(`style_package_attempt_evidences`.`status` = 'passed' or (`style_package_attempt_evidences`.`package_artifact_id` is null and `style_package_attempt_evidences`.`package_sha256` is null and `style_package_attempt_evidences`.`package_upload_id` is null and `style_package_attempt_evidences`.`manifest_artifact_id` is null and `style_package_attempt_evidences`.`manifest_sha256` is null and `style_package_attempt_evidences`.`manifest_upload_id` is null and `style_package_attempt_evidences`.`validation_artifact_id` is null and `style_package_attempt_evidences`.`validation_sha256` is null and `style_package_attempt_evidences`.`validation_upload_id` is null))
);
--> statement-breakpoint
ALTER TABLE `style_package_attempt_evidences` ADD CONSTRAINT `spae_run_fk` FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `style_package_attempt_evidences` ADD CONSTRAINT `spae_package_fk` FOREIGN KEY (`style_package_id`) REFERENCES `style_packages`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `style_package_attempt_evidences` ADD CONSTRAINT `spae_worker_fk` FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `style_package_attempt_evidences` ADD CONSTRAINT `style_package_attempt_evidences_job_run_fk` FOREIGN KEY (`run_id`,`job_id`) REFERENCES `jobs`(`run_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `style_package_attempt_evidences` ADD CONSTRAINT `style_package_attempt_evidences_attempt_lease_fk` FOREIGN KEY (`job_id`,`attempt`,`worker_id`,`lease_id`) REFERENCES `job_attempts`(`job_id`,`attempt`,`worker_id`,`lease_id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `style_package_attempt_evidences` ADD CONSTRAINT `style_package_attempt_evidences_package_artifact_fk` FOREIGN KEY (`run_id`,`package_artifact_id`) REFERENCES `artifacts`(`run_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `style_package_attempt_evidences` ADD CONSTRAINT `style_package_attempt_evidences_manifest_artifact_fk` FOREIGN KEY (`run_id`,`manifest_artifact_id`) REFERENCES `artifacts`(`run_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `style_package_attempt_evidences` ADD CONSTRAINT `style_package_attempt_evidences_validation_artifact_fk` FOREIGN KEY (`run_id`,`validation_artifact_id`) REFERENCES `artifacts`(`run_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `style_package_attempt_evidences` ADD CONSTRAINT `style_package_attempt_evidences_package_upload_fk` FOREIGN KEY (`package_upload_id`,`run_id`,`job_id`,`worker_id`,`lease_id`,`attempt`,`package_artifact_id`) REFERENCES `artifact_upload_sessions`(`id`,`run_id`,`job_id`,`worker_id`,`lease_id`,`attempt`,`artifact_id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `style_package_attempt_evidences` ADD CONSTRAINT `style_package_attempt_evidences_manifest_upload_fk` FOREIGN KEY (`manifest_upload_id`,`run_id`,`job_id`,`worker_id`,`lease_id`,`attempt`,`manifest_artifact_id`) REFERENCES `artifact_upload_sessions`(`id`,`run_id`,`job_id`,`worker_id`,`lease_id`,`attempt`,`artifact_id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `style_package_attempt_evidences` ADD CONSTRAINT `style_package_attempt_evidences_validation_upload_fk` FOREIGN KEY (`validation_upload_id`,`run_id`,`job_id`,`worker_id`,`lease_id`,`attempt`,`validation_artifact_id`) REFERENCES `artifact_upload_sessions`(`id`,`run_id`,`job_id`,`worker_id`,`lease_id`,`attempt`,`artifact_id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `style_package_attempt_evidences_package_idx` ON `style_package_attempt_evidences` (`style_package_id`);