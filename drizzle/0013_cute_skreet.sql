CREATE TABLE `shared_fx_stage_evidences` (
	`id` varchar(64) NOT NULL,
	`run_id` varchar(64) NOT NULL,
	`job_id` varchar(64) NOT NULL,
	`worker_id` varchar(64) NOT NULL,
	`lease_id` varchar(64) NOT NULL,
	`attempt` int unsigned NOT NULL,
	`stage` varchar(32) NOT NULL,
	`artifact_id` varchar(64) NOT NULL,
	`artifact_sha256` varchar(64) NOT NULL,
	`upload_id` varchar(64) NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `shared_fx_stage_evidences_id` PRIMARY KEY(`id`),
	CONSTRAINT `shared_fx_stage_evidences_stage_uq` UNIQUE(`job_id`,`attempt`,`stage`),
	CONSTRAINT `shared_fx_stage_evidences_stage_ck` CHECK(`shared_fx_stage_evidences`.`stage` in ('inventory', 'material', 'aseprite', 'runtime', 'npk', 'independent-validation'))
);
--> statement-breakpoint
DROP INDEX `manual_reviews_run_idx` ON `manual_reviews`;--> statement-breakpoint
ALTER TABLE `manual_reviews` ADD CONSTRAINT `manual_reviews_run_uq` UNIQUE(`run_id`);--> statement-breakpoint
ALTER TABLE `artifact_upload_sessions` ADD CONSTRAINT `artifact_upload_sessions_evidence_binding_uq` UNIQUE(`id`,`run_id`,`job_id`,`worker_id`,`lease_id`,`attempt`,`artifact_id`);--> statement-breakpoint
ALTER TABLE `shared_fx_stage_evidences` ADD CONSTRAINT `shared_fx_stage_evidences_run_id_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shared_fx_stage_evidences` ADD CONSTRAINT `shared_fx_stage_evidences_worker_id_workers_id_fk` FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shared_fx_stage_evidences` ADD CONSTRAINT `shared_fx_stage_evidences_job_run_fk` FOREIGN KEY (`run_id`,`job_id`) REFERENCES `jobs`(`run_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shared_fx_stage_evidences` ADD CONSTRAINT `shared_fx_stage_evidences_attempt_lease_fk` FOREIGN KEY (`job_id`,`attempt`,`worker_id`,`lease_id`) REFERENCES `job_attempts`(`job_id`,`attempt`,`worker_id`,`lease_id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shared_fx_stage_evidences` ADD CONSTRAINT `shared_fx_stage_evidences_artifact_run_fk` FOREIGN KEY (`run_id`,`artifact_id`) REFERENCES `artifacts`(`run_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shared_fx_stage_evidences` ADD CONSTRAINT `shared_fx_stage_evidences_upload_binding_fk` FOREIGN KEY (`upload_id`,`run_id`,`job_id`,`worker_id`,`lease_id`,`attempt`,`artifact_id`) REFERENCES `artifact_upload_sessions`(`id`,`run_id`,`job_id`,`worker_id`,`lease_id`,`attempt`,`artifact_id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `shared_fx_stage_evidences_job_attempt_idx` ON `shared_fx_stage_evidences` (`job_id`,`attempt`);--> statement-breakpoint
ALTER TABLE `manual_reviews` ADD CONSTRAINT `manual_reviews_status_ck` CHECK (`manual_reviews`.`status` in ('pending', 'approved', 'rejected'));