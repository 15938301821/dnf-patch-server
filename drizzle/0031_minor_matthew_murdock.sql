CREATE TABLE `profession_skill_frame_targets` (
	`id` varchar(64) NOT NULL,
	`run_id` varchar(64) NOT NULL,
	`job_id` varchar(64) NOT NULL,
	`worker_id` varchar(64) NOT NULL,
	`lease_id` varchar(64) NOT NULL,
	`attempt` int unsigned NOT NULL,
	`skill_id` varchar(64) NOT NULL,
	`manifest_artifact_id` varchar(64) NOT NULL,
	`manifest_upload_id` varchar(64) NOT NULL,
	`manifest_sha256` varchar(64) NOT NULL,
	`source_run_id` varchar(64) NOT NULL,
	`source_frame_manifest_artifact_id` varchar(64) NOT NULL,
	`source_frame_manifest_sha256` varchar(64) NOT NULL,
	`source_sha256` varchar(64) NOT NULL,
	`frame_ordinal` int unsigned NOT NULL,
	`generation_ordinal` int unsigned,
	`entry_index` int unsigned NOT NULL,
	`frame_index` int unsigned NOT NULL,
	`internal_path` varchar(500) NOT NULL,
	`img_version` int unsigned NOT NULL,
	`frame_type` varchar(40) NOT NULL,
	`compress_mode` varchar(40) NOT NULL,
	`hidden` boolean NOT NULL,
	`width` int unsigned NOT NULL,
	`height` int unsigned NOT NULL,
	`canvas_width` int unsigned NOT NULL,
	`canvas_height` int unsigned NOT NULL,
	`x` int NOT NULL,
	`y` int NOT NULL,
	`target_policy` varchar(32) NOT NULL,
	`link_target_frame_index` int unsigned,
	`source_decoded_bgra_sha256` varchar(64),
	`source_alpha_sha256` varchar(64),
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `profession_skill_frame_targets_id` PRIMARY KEY(`id`),
	CONSTRAINT `profession_skill_frame_targets_frame_uq` UNIQUE(`job_id`,`attempt`,`skill_id`,`entry_index`,`frame_index`),
	CONSTRAINT `profession_skill_frame_targets_ordinal_uq` UNIQUE(`job_id`,`attempt`,`skill_id`,`frame_ordinal`),
	CONSTRAINT `profession_skill_frame_targets_generation_uq` UNIQUE(`job_id`,`attempt`,`skill_id`,`generation_ordinal`),
	CONSTRAINT `profession_skill_frame_targets_policy_ck` CHECK(`profession_skill_frame_targets`.`target_policy` in ('generate-same-size', 'preserve-hidden-source', 'reuse-link-target')),
	CONSTRAINT `profession_skill_frame_targets_img_version_ck` CHECK(`profession_skill_frame_targets`.`img_version` between 1 and 6),
	CONSTRAINT `profession_skill_frame_targets_geometry_ck` CHECK(`profession_skill_frame_targets`.`width` > 0 and `profession_skill_frame_targets`.`height` > 0 and `profession_skill_frame_targets`.`canvas_width` > 0 and `profession_skill_frame_targets`.`canvas_height` > 0),
	CONSTRAINT `profession_skill_frame_targets_policy_evidence_ck` CHECK((`profession_skill_frame_targets`.`target_policy` = 'generate-same-size' and `profession_skill_frame_targets`.`hidden` = false and `profession_skill_frame_targets`.`generation_ordinal` is not null and `profession_skill_frame_targets`.`link_target_frame_index` is null and `profession_skill_frame_targets`.`source_decoded_bgra_sha256` is not null and `profession_skill_frame_targets`.`source_alpha_sha256` is not null) or (`profession_skill_frame_targets`.`target_policy` = 'preserve-hidden-source' and `profession_skill_frame_targets`.`hidden` = true and `profession_skill_frame_targets`.`generation_ordinal` is null and `profession_skill_frame_targets`.`link_target_frame_index` is null and `profession_skill_frame_targets`.`source_decoded_bgra_sha256` is not null and `profession_skill_frame_targets`.`source_alpha_sha256` is not null) or (`profession_skill_frame_targets`.`target_policy` = 'reuse-link-target' and `profession_skill_frame_targets`.`generation_ordinal` is null and `profession_skill_frame_targets`.`link_target_frame_index` is not null and `profession_skill_frame_targets`.`source_decoded_bgra_sha256` is null and `profession_skill_frame_targets`.`source_alpha_sha256` is null)),
	CONSTRAINT `profession_skill_frame_targets_link_not_self_ck` CHECK(`profession_skill_frame_targets`.`link_target_frame_index` is null or `profession_skill_frame_targets`.`link_target_frame_index` <> `profession_skill_frame_targets`.`frame_index`)
);
--> statement-breakpoint
ALTER TABLE `profession_skill_frame_targets` ADD CONSTRAINT `profession_skill_frame_targets_run_id_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `profession_skill_frame_targets` ADD CONSTRAINT `profession_skill_frame_targets_worker_id_workers_id_fk` FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `profession_skill_frame_targets` ADD CONSTRAINT `profession_skill_frame_targets_source_run_id_runs_id_fk` FOREIGN KEY (`source_run_id`) REFERENCES `runs`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `profession_skill_frame_targets` ADD CONSTRAINT `profession_skill_frame_targets_job_run_fk` FOREIGN KEY (`run_id`,`job_id`) REFERENCES `jobs`(`run_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `profession_skill_frame_targets` ADD CONSTRAINT `profession_skill_frame_targets_attempt_lease_fk` FOREIGN KEY (`job_id`,`attempt`,`worker_id`,`lease_id`) REFERENCES `job_attempts`(`job_id`,`attempt`,`worker_id`,`lease_id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `profession_skill_frame_targets` ADD CONSTRAINT `profession_skill_frame_targets_run_skill_fk` FOREIGN KEY (`run_id`,`skill_id`) REFERENCES `style_skill_productions`(`run_id`,`skill_id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `profession_skill_frame_targets` ADD CONSTRAINT `profession_skill_frame_targets_manifest_artifact_run_fk` FOREIGN KEY (`run_id`,`manifest_artifact_id`) REFERENCES `artifacts`(`run_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `profession_skill_frame_targets` ADD CONSTRAINT `profession_skill_frame_targets_source_artifact_run_fk` FOREIGN KEY (`source_run_id`,`source_frame_manifest_artifact_id`) REFERENCES `artifacts`(`run_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `profession_skill_frame_targets` ADD CONSTRAINT `profession_skill_frame_targets_manifest_upload_fk` FOREIGN KEY (`manifest_upload_id`,`run_id`,`job_id`,`worker_id`,`lease_id`,`attempt`,`manifest_artifact_id`) REFERENCES `artifact_upload_sessions`(`id`,`run_id`,`job_id`,`worker_id`,`lease_id`,`attempt`,`artifact_id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `profession_skill_frame_targets` ADD CONSTRAINT `profession_skill_frame_targets_link_target_fk` FOREIGN KEY (`job_id`,`attempt`,`skill_id`,`entry_index`,`link_target_frame_index`) REFERENCES `profession_skill_frame_targets`(`job_id`,`attempt`,`skill_id`,`entry_index`,`frame_index`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `profession_skill_frame_targets_run_skill_idx` ON `profession_skill_frame_targets` (`run_id`,`skill_id`,`target_policy`);--> statement-breakpoint
CREATE INDEX `profession_skill_frame_targets_manifest_idx` ON `profession_skill_frame_targets` (`manifest_artifact_id`);