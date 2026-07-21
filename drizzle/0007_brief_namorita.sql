CREATE TABLE `profession_skills` (
	`id` varchar(64) NOT NULL,
	`profession_id` varchar(64) NOT NULL,
	`stable_key` varchar(160) NOT NULL,
	`display_name` varchar(160) NOT NULL,
	`prompt_status` varchar(32) NOT NULL DEFAULT 'candidate',
	`mapping_status` varchar(32) NOT NULL DEFAULT 'unverified',
	`execution_status` varchar(32) NOT NULL DEFAULT 'draft-only',
	`source_run_id` varchar(64),
	`source_inventory_id` varchar(64),
	`source_inventory_entry_id` varchar(64),
	`source_frame_manifest_artifact_id` varchar(64),
	`source_metadata_sha256` varchar(64),
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `profession_skills_id` PRIMARY KEY(`id`),
	CONSTRAINT `profession_skills_stable_key_uq` UNIQUE(`profession_id`,`stable_key`),
	CONSTRAINT `profession_skills_profession_id_uq` UNIQUE(`profession_id`,`id`),
	CONSTRAINT `profession_skills_prompt_status_ck` CHECK(`profession_skills`.`prompt_status` in ('candidate', 'reviewed')),
	CONSTRAINT `profession_skills_mapping_status_ck` CHECK(`profession_skills`.`mapping_status` in ('unverified', 'verified')),
	CONSTRAINT `profession_skills_execution_status_ck` CHECK(`profession_skills`.`execution_status` in ('draft-only', 'build-ready')),
	CONSTRAINT `profession_skills_build_ready_evidence_ck` CHECK(`profession_skills`.`execution_status` <> 'build-ready' or (`profession_skills`.`mapping_status` = 'verified' and `profession_skills`.`source_run_id` is not null and `profession_skills`.`source_inventory_id` is not null and `profession_skills`.`source_inventory_entry_id` is not null and `profession_skills`.`source_frame_manifest_artifact_id` is not null and `profession_skills`.`source_metadata_sha256` is not null))
);
--> statement-breakpoint
CREATE TABLE `profession_style_skills` (
	`profession_id` varchar(64) NOT NULL,
	`style_id` varchar(64) NOT NULL,
	`skill_id` varchar(64) NOT NULL,
	`ordinal` int unsigned NOT NULL,
	`custom_prompt` text,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `profession_style_skills_pk` PRIMARY KEY(`style_id`,`skill_id`),
	CONSTRAINT `profession_style_skills_ordinal_uq` UNIQUE(`style_id`,`ordinal`)
);
--> statement-breakpoint
CREATE TABLE `profession_styles` (
	`id` varchar(64) NOT NULL,
	`profession_id` varchar(64) NOT NULL,
	`name` varchar(160) NOT NULL,
	`canonical_name` varchar(200) NOT NULL,
	`description` text NOT NULL,
	`agent` text NOT NULL,
	`prompt` text NOT NULL,
	`publish_status` varchar(32) NOT NULL DEFAULT 'private',
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `profession_styles_id` PRIMARY KEY(`id`),
	CONSTRAINT `profession_styles_name_uq` UNIQUE(`profession_id`,`canonical_name`),
	CONSTRAINT `profession_styles_profession_id_uq` UNIQUE(`profession_id`,`id`),
	CONSTRAINT `profession_styles_publish_status_ck` CHECK(`profession_styles`.`publish_status` in ('private', 'pending', 'published', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE `professions` (
	`id` varchar(64) NOT NULL,
	`name` varchar(160) NOT NULL,
	`slug` varchar(120) NOT NULL,
	`canonical_name` varchar(200) NOT NULL,
	`workflow_project_id` varchar(64),
	`catalog_snapshot_id` varchar(64),
	`publish_status` varchar(32) NOT NULL DEFAULT 'private',
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `professions_id` PRIMARY KEY(`id`),
	CONSTRAINT `professions_slug_uq` UNIQUE(`slug`),
	CONSTRAINT `professions_canonical_name_uq` UNIQUE(`canonical_name`),
	CONSTRAINT `professions_workflow_project_uq` UNIQUE(`workflow_project_id`),
	CONSTRAINT `professions_publish_status_ck` CHECK(`professions`.`publish_status` in ('private', 'pending', 'published', 'rejected')),
	CONSTRAINT `professions_workflow_binding_ck` CHECK((`professions`.`workflow_project_id` is null and `professions`.`catalog_snapshot_id` is null) or (`professions`.`workflow_project_id` is not null and `professions`.`catalog_snapshot_id` is not null))
);
--> statement-breakpoint
CREATE TABLE `style_packages` (
	`id` varchar(64) NOT NULL,
	`profession_id` varchar(64) NOT NULL,
	`style_id` varchar(64) NOT NULL,
	`run_id` varchar(64) NOT NULL,
	`package_artifact_id` varchar(64),
	`manifest_sha256` varchar(64),
	`status` varchar(32) NOT NULL DEFAULT 'queued',
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`finished_at` datetime(3),
	CONSTRAINT `style_packages_id` PRIMARY KEY(`id`),
	CONSTRAINT `style_packages_run_uq` UNIQUE(`run_id`),
	CONSTRAINT `style_packages_status_ck` CHECK(`style_packages`.`status` in ('queued', 'building', 'passed', 'failed', 'blocked')),
	CONSTRAINT `style_packages_passed_evidence_ck` CHECK(`style_packages`.`status` <> 'passed' or (`style_packages`.`package_artifact_id` is not null and `style_packages`.`manifest_sha256` is not null and `style_packages`.`finished_at` is not null))
);
--> statement-breakpoint
CREATE TABLE `style_skill_productions` (
	`id` varchar(64) NOT NULL,
	`profession_id` varchar(64) NOT NULL,
	`style_id` varchar(64) NOT NULL,
	`skill_id` varchar(64) NOT NULL,
	`run_id` varchar(64) NOT NULL,
	`job_id` varchar(64),
	`source_run_id` varchar(64) NOT NULL,
	`source_frame_manifest_artifact_id` varchar(64) NOT NULL,
	`prompt_sha256` varchar(64) NOT NULL,
	`model_call_id` varchar(64),
	`image_attempt_id` varchar(64),
	`aseprite_profile_id` varchar(128),
	`aseprite_binary_sha256` varchar(64),
	`aseprite_artifact_id` varchar(64),
	`validation_artifact_id` varchar(64),
	`status` varchar(32) NOT NULL DEFAULT 'planned',
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`finished_at` datetime(3),
	CONSTRAINT `style_skill_productions_id` PRIMARY KEY(`id`),
	CONSTRAINT `style_skill_productions_run_skill_uq` UNIQUE(`run_id`,`skill_id`),
	CONSTRAINT `style_skill_productions_status_ck` CHECK(`style_skill_productions`.`status` in ('planned', 'generating', 'adapting', 'validating', 'passed', 'failed', 'blocked')),
	CONSTRAINT `style_skill_productions_finished_ck` CHECK((`style_skill_productions`.`status` in ('passed', 'failed', 'blocked') and `style_skill_productions`.`finished_at` is not null) or (`style_skill_productions`.`status` not in ('passed', 'failed', 'blocked') and `style_skill_productions`.`finished_at` is null)),
	CONSTRAINT `style_skill_productions_passed_evidence_ck` CHECK(`style_skill_productions`.`status` <> 'passed' or (`style_skill_productions`.`model_call_id` is not null and `style_skill_productions`.`image_attempt_id` is not null and `style_skill_productions`.`aseprite_profile_id` is not null and `style_skill_productions`.`aseprite_binary_sha256` is not null and `style_skill_productions`.`aseprite_artifact_id` is not null and `style_skill_productions`.`validation_artifact_id` is not null))
);
--> statement-breakpoint
ALTER TABLE `image_attempts` ADD CONSTRAINT `image_attempts_run_id_uq` UNIQUE(`run_id`,`id`);--> statement-breakpoint
ALTER TABLE `jobs` ADD CONSTRAINT `jobs_run_id_uq` UNIQUE(`run_id`,`id`);--> statement-breakpoint
ALTER TABLE `npk_inventories` ADD CONSTRAINT `npk_inventories_run_id_uq` UNIQUE(`run_id`,`id`);--> statement-breakpoint
ALTER TABLE `npk_inventory_entries` ADD CONSTRAINT `npk_entries_inventory_id_uq` UNIQUE(`inventory_id`,`id`);--> statement-breakpoint
ALTER TABLE `profession_skills` ADD CONSTRAINT `profession_skills_profession_id_professions_id_fk` FOREIGN KEY (`profession_id`) REFERENCES `professions`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `profession_skills` ADD CONSTRAINT `profession_skills_source_run_id_runs_id_fk` FOREIGN KEY (`source_run_id`) REFERENCES `runs`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `profession_skills` ADD CONSTRAINT `profession_skills_source_inventory_run_fk` FOREIGN KEY (`source_run_id`,`source_inventory_id`) REFERENCES `npk_inventories`(`run_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `profession_skills` ADD CONSTRAINT `profession_skills_source_inventory_entry_fk` FOREIGN KEY (`source_inventory_id`,`source_inventory_entry_id`) REFERENCES `npk_inventory_entries`(`inventory_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `profession_skills` ADD CONSTRAINT `profession_skills_source_artifact_run_fk` FOREIGN KEY (`source_run_id`,`source_frame_manifest_artifact_id`) REFERENCES `artifacts`(`run_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `profession_style_skills` ADD CONSTRAINT `profession_style_skills_profession_id_professions_id_fk` FOREIGN KEY (`profession_id`) REFERENCES `professions`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `profession_style_skills` ADD CONSTRAINT `profession_style_skills_style_profession_fk` FOREIGN KEY (`profession_id`,`style_id`) REFERENCES `profession_styles`(`profession_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `profession_style_skills` ADD CONSTRAINT `profession_style_skills_skill_profession_fk` FOREIGN KEY (`profession_id`,`skill_id`) REFERENCES `profession_skills`(`profession_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `profession_styles` ADD CONSTRAINT `profession_styles_profession_id_professions_id_fk` FOREIGN KEY (`profession_id`) REFERENCES `professions`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `professions` ADD CONSTRAINT `professions_workflow_project_id_projects_id_fk` FOREIGN KEY (`workflow_project_id`) REFERENCES `projects`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `professions` ADD CONSTRAINT `professions_catalog_snapshot_project_fk` FOREIGN KEY (`workflow_project_id`,`catalog_snapshot_id`) REFERENCES `project_snapshots`(`project_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `style_packages` ADD CONSTRAINT `style_packages_run_id_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `style_packages` ADD CONSTRAINT `style_packages_style_profession_fk` FOREIGN KEY (`profession_id`,`style_id`) REFERENCES `profession_styles`(`profession_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `style_packages` ADD CONSTRAINT `style_packages_artifact_run_fk` FOREIGN KEY (`run_id`,`package_artifact_id`) REFERENCES `artifacts`(`run_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `style_skill_productions` ADD CONSTRAINT `style_skill_productions_run_id_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `style_skill_productions` ADD CONSTRAINT `style_skill_productions_source_run_id_runs_id_fk` FOREIGN KEY (`source_run_id`) REFERENCES `runs`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `style_skill_productions` ADD CONSTRAINT `style_skill_productions_style_profession_fk` FOREIGN KEY (`profession_id`,`style_id`) REFERENCES `profession_styles`(`profession_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `style_skill_productions` ADD CONSTRAINT `style_skill_productions_skill_profession_fk` FOREIGN KEY (`profession_id`,`skill_id`) REFERENCES `profession_skills`(`profession_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `style_skill_productions` ADD CONSTRAINT `style_skill_productions_selected_skill_fk` FOREIGN KEY (`style_id`,`skill_id`) REFERENCES `profession_style_skills`(`style_id`,`skill_id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `style_skill_productions` ADD CONSTRAINT `style_skill_productions_job_run_fk` FOREIGN KEY (`run_id`,`job_id`) REFERENCES `jobs`(`run_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `style_skill_productions` ADD CONSTRAINT `style_skill_productions_model_call_run_fk` FOREIGN KEY (`run_id`,`model_call_id`) REFERENCES `model_calls`(`run_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `style_skill_productions` ADD CONSTRAINT `style_skill_productions_image_attempt_run_fk` FOREIGN KEY (`run_id`,`image_attempt_id`) REFERENCES `image_attempts`(`run_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `style_skill_productions` ADD CONSTRAINT `style_skill_productions_source_artifact_run_fk` FOREIGN KEY (`source_run_id`,`source_frame_manifest_artifact_id`) REFERENCES `artifacts`(`run_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `style_skill_productions` ADD CONSTRAINT `style_skill_productions_aseprite_artifact_run_fk` FOREIGN KEY (`run_id`,`aseprite_artifact_id`) REFERENCES `artifacts`(`run_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `style_skill_productions` ADD CONSTRAINT `style_skill_productions_validation_artifact_run_fk` FOREIGN KEY (`run_id`,`validation_artifact_id`) REFERENCES `artifacts`(`run_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `profession_skills_profession_idx` ON `profession_skills` (`profession_id`);--> statement-breakpoint
CREATE INDEX `profession_styles_profession_idx` ON `profession_styles` (`profession_id`);--> statement-breakpoint
CREATE INDEX `style_packages_style_idx` ON `style_packages` (`style_id`);--> statement-breakpoint
CREATE INDEX `style_skill_productions_style_idx` ON `style_skill_productions` (`style_id`);--> statement-breakpoint
CREATE INDEX `style_skill_productions_run_idx` ON `style_skill_productions` (`run_id`);