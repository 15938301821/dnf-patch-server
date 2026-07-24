CREATE TABLE `profession_skill_model_executions` (
	`id` varchar(64) NOT NULL,
	`run_id` varchar(64) NOT NULL,
	`job_id` varchar(64) NOT NULL,
	`worker_id` varchar(64) NOT NULL,
	`lease_id` varchar(64) NOT NULL,
	`attempt` int unsigned NOT NULL,
	`skill_id` varchar(64) NOT NULL,
	`stage` varchar(32) NOT NULL,
	`prompt_sha256` varchar(64) NOT NULL,
	`model_call_id` varchar(64),
	`image_attempt_id` varchar(64),
	`output_artifact_id` varchar(64),
	`output_sha256` varchar(64),
	`output_byte_length` int unsigned,
	`status` varchar(32) NOT NULL,
	`error_code` varchar(80),
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`finished_at` datetime(3),
	CONSTRAINT `profession_skill_model_executions_id` PRIMARY KEY(`id`),
	CONSTRAINT `profession_skill_model_executions_step_uq` UNIQUE(`job_id`,`attempt`,`skill_id`,`stage`),
	CONSTRAINT `profession_skill_model_executions_stage_ck` CHECK(`profession_skill_model_executions`.`stage` in ('reference-image-v1')),
	CONSTRAINT `profession_skill_model_executions_status_ck` CHECK(`profession_skill_model_executions`.`status` in ('prepared', 'egressing', 'persisting', 'passed', 'failed', 'indeterminate')),
	CONSTRAINT `profession_skill_model_executions_finished_ck` CHECK((`profession_skill_model_executions`.`status` in ('prepared', 'egressing', 'persisting') and `profession_skill_model_executions`.`finished_at` is null) or (`profession_skill_model_executions`.`status` in ('passed', 'failed', 'indeterminate') and `profession_skill_model_executions`.`finished_at` is not null)),
	CONSTRAINT `profession_skill_model_executions_evidence_ck` CHECK((`profession_skill_model_executions`.`status` = 'prepared' and `profession_skill_model_executions`.`model_call_id` is null and `profession_skill_model_executions`.`image_attempt_id` is null and `profession_skill_model_executions`.`output_artifact_id` is null and `profession_skill_model_executions`.`output_sha256` is null and `profession_skill_model_executions`.`output_byte_length` is null and `profession_skill_model_executions`.`error_code` is null) or (`profession_skill_model_executions`.`status` = 'egressing' and `profession_skill_model_executions`.`image_attempt_id` is null and `profession_skill_model_executions`.`output_artifact_id` is null and `profession_skill_model_executions`.`output_sha256` is null and `profession_skill_model_executions`.`output_byte_length` is null and `profession_skill_model_executions`.`error_code` is null) or (`profession_skill_model_executions`.`status` = 'persisting' and `profession_skill_model_executions`.`model_call_id` is not null and `profession_skill_model_executions`.`image_attempt_id` is null and `profession_skill_model_executions`.`output_artifact_id` is null and `profession_skill_model_executions`.`output_sha256` is not null and `profession_skill_model_executions`.`output_byte_length` is not null and `profession_skill_model_executions`.`error_code` is null) or (`profession_skill_model_executions`.`status` = 'passed' and `profession_skill_model_executions`.`model_call_id` is not null and `profession_skill_model_executions`.`image_attempt_id` is not null and `profession_skill_model_executions`.`output_artifact_id` is not null and `profession_skill_model_executions`.`output_sha256` is not null and `profession_skill_model_executions`.`output_byte_length` is not null and `profession_skill_model_executions`.`error_code` is null) or (`profession_skill_model_executions`.`status` = 'failed' and `profession_skill_model_executions`.`image_attempt_id` is null and `profession_skill_model_executions`.`output_artifact_id` is null and `profession_skill_model_executions`.`output_sha256` is null and `profession_skill_model_executions`.`output_byte_length` is null and `profession_skill_model_executions`.`error_code` is not null) or (`profession_skill_model_executions`.`status` = 'indeterminate' and `profession_skill_model_executions`.`image_attempt_id` is null and `profession_skill_model_executions`.`output_artifact_id` is null and `profession_skill_model_executions`.`error_code` is not null and ((`profession_skill_model_executions`.`output_sha256` is null and `profession_skill_model_executions`.`output_byte_length` is null) or (`profession_skill_model_executions`.`model_call_id` is not null and `profession_skill_model_executions`.`output_sha256` is not null and `profession_skill_model_executions`.`output_byte_length` is not null))))
);
--> statement-breakpoint
ALTER TABLE `profession_skill_model_executions` ADD CONSTRAINT `profession_skill_model_executions_run_id_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `profession_skill_model_executions` ADD CONSTRAINT `profession_skill_model_executions_worker_id_workers_id_fk` FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `profession_skill_model_executions` ADD CONSTRAINT `profession_skill_model_executions_job_run_fk` FOREIGN KEY (`run_id`,`job_id`) REFERENCES `jobs`(`run_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `profession_skill_model_executions` ADD CONSTRAINT `profession_skill_model_executions_attempt_lease_fk` FOREIGN KEY (`job_id`,`attempt`,`worker_id`,`lease_id`) REFERENCES `job_attempts`(`job_id`,`attempt`,`worker_id`,`lease_id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `profession_skill_model_executions` ADD CONSTRAINT `profession_skill_model_executions_run_skill_fk` FOREIGN KEY (`run_id`,`skill_id`) REFERENCES `style_skill_productions`(`run_id`,`skill_id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `profession_skill_model_executions` ADD CONSTRAINT `profession_skill_model_executions_model_call_run_fk` FOREIGN KEY (`run_id`,`model_call_id`) REFERENCES `model_calls`(`run_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `profession_skill_model_executions` ADD CONSTRAINT `profession_skill_model_executions_image_attempt_run_fk` FOREIGN KEY (`run_id`,`image_attempt_id`) REFERENCES `image_attempts`(`run_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `profession_skill_model_executions` ADD CONSTRAINT `profession_skill_model_executions_artifact_run_fk` FOREIGN KEY (`run_id`,`output_artifact_id`) REFERENCES `artifacts`(`run_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `profession_skill_model_executions_attempt_lease_idx` ON `profession_skill_model_executions` (`job_id`,`attempt`,`worker_id`,`lease_id`);--> statement-breakpoint
CREATE INDEX `profession_skill_model_executions_run_skill_idx` ON `profession_skill_model_executions` (`run_id`,`skill_id`);