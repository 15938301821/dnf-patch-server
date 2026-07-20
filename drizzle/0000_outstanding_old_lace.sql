CREATE TABLE `artifacts` (
	`id` varchar(64) NOT NULL,
	`run_id` varchar(64) NOT NULL,
	`logical_name` varchar(200) NOT NULL,
	`storage_key` varchar(500) NOT NULL,
	`media_type` varchar(120) NOT NULL,
	`byte_length` int unsigned NOT NULL,
	`sha256` varchar(64) NOT NULL,
	`provenance` json NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `artifacts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `factories` (
	`id` varchar(64) NOT NULL,
	`version` varchar(32) NOT NULL,
	`display_name` varchar(160) NOT NULL,
	`config` json NOT NULL,
	`config_sha256` varchar(64) NOT NULL,
	`enabled` boolean NOT NULL DEFAULT true,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `factories_id` PRIMARY KEY(`id`),
	CONSTRAINT `factories_version_uq` UNIQUE(`id`,`version`)
);
--> statement-breakpoint
CREATE TABLE `guardrail_decisions` (
	`id` varchar(64) NOT NULL,
	`run_id` varchar(64) NOT NULL,
	`policy_id` varchar(100) NOT NULL,
	`policy_sha256` varchar(64) NOT NULL,
	`input_sha256` varchar(64) NOT NULL,
	`decision` varchar(32) NOT NULL,
	`reason_code` varchar(100) NOT NULL,
	`details` json NOT NULL,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `guardrail_decisions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `image_attempts` (
	`id` varchar(64) NOT NULL,
	`run_id` varchar(64) NOT NULL,
	`model_call_id` varchar(64),
	`prompt_sha256` varchar(64) NOT NULL,
	`input_snapshot_sha256` varchar(64) NOT NULL,
	`generation_config_sha256` varchar(64) NOT NULL,
	`actual_seed` varchar(80),
	`adapter_identity` varchar(200) NOT NULL,
	`output_artifact_id` varchar(64),
	`status` varchar(32) NOT NULL,
	`direct_runtime_use_allowed` boolean NOT NULL DEFAULT false,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `image_attempts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `job_attempts` (
	`id` varchar(64) NOT NULL,
	`job_id` varchar(64) NOT NULL,
	`worker_id` varchar(64) NOT NULL,
	`attempt` int unsigned NOT NULL,
	`status` varchar(32) NOT NULL,
	`result_sha256` varchar(64),
	`error_code` varchar(80),
	`error_message` text,
	`started_at` datetime(3) NOT NULL,
	`finished_at` datetime(3),
	CONSTRAINT `job_attempts_id` PRIMARY KEY(`id`),
	CONSTRAINT `job_attempts_uq` UNIQUE(`job_id`,`attempt`)
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` varchar(64) NOT NULL,
	`run_id` varchar(64) NOT NULL,
	`kind` varchar(64) NOT NULL,
	`status` varchar(32) NOT NULL,
	`payload` json NOT NULL,
	`payload_sha256` varchar(64) NOT NULL,
	`lease_owner_id` varchar(64),
	`lease_expires_at` datetime(3),
	`attempt_count` int unsigned NOT NULL DEFAULT 0,
	`max_attempts` int unsigned NOT NULL DEFAULT 3,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `jobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `manual_reviews` (
	`id` varchar(64) NOT NULL,
	`run_id` varchar(64) NOT NULL,
	`status` varchar(32) NOT NULL,
	`reviewer` varchar(160),
	`evidence_artifact_id` varchar(64),
	`created_at` datetime(3) NOT NULL,
	`completed_at` datetime(3),
	CONSTRAINT `manual_reviews_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `model_calls` (
	`id` varchar(64) NOT NULL,
	`run_id` varchar(64) NOT NULL,
	`role` varchar(32) NOT NULL,
	`model` varchar(120) NOT NULL,
	`endpoint_identity` varchar(300) NOT NULL,
	`request_sha256` varchar(64) NOT NULL,
	`response_sha256` varchar(64),
	`response_id` varchar(160),
	`status` varchar(32) NOT NULL,
	`model_egress_authorized` boolean NOT NULL,
	`error_code` varchar(80),
	`created_at` datetime(3) NOT NULL,
	`finished_at` datetime(3),
	CONSTRAINT `model_calls_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `npk_inventories` (
	`id` varchar(64) NOT NULL,
	`project_id` varchar(64) NOT NULL,
	`source_label` varchar(200) NOT NULL,
	`source_length` int unsigned NOT NULL,
	`source_sha256` varchar(64) NOT NULL,
	`entry_count` int unsigned NOT NULL,
	`status` varchar(40) NOT NULL,
	`inventory_artifact_id` varchar(64),
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `npk_inventories_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `npk_inventory_entries` (
	`id` varchar(64) NOT NULL,
	`inventory_id` varchar(64) NOT NULL,
	`internal_path` varchar(500) NOT NULL,
	`img_version` int unsigned NOT NULL,
	`frame_count` int unsigned NOT NULL,
	`metadata_sha256` varchar(64) NOT NULL,
	CONSTRAINT `npk_inventory_entries_id` PRIMARY KEY(`id`),
	CONSTRAINT `npk_entries_path_uq` UNIQUE(`inventory_id`,`internal_path`)
);
--> statement-breakpoint
CREATE TABLE `outbox_events` (
	`id` varchar(64) NOT NULL,
	`topic` varchar(120) NOT NULL,
	`aggregate_id` varchar(64) NOT NULL,
	`payload` json NOT NULL,
	`created_at` datetime(3) NOT NULL,
	`published_at` datetime(3),
	CONSTRAINT `outbox_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `project_snapshots` (
	`id` varchar(64) NOT NULL,
	`project_id` varchar(64) NOT NULL,
	`client_snapshot_id` varchar(128) NOT NULL,
	`root_rules_sha256` varchar(64) NOT NULL,
	`manifest_sha256` varchar(64),
	`prompt_tree_sha256` varchar(64) NOT NULL,
	`tool_catalog_sha256` varchar(64) NOT NULL,
	`repository_revision` varchar(80),
	`full_skill_coverage_proven` boolean NOT NULL DEFAULT false,
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `project_snapshots_id` PRIMARY KEY(`id`),
	CONSTRAINT `project_snapshots_client_uq` UNIQUE(`project_id`,`client_snapshot_id`)
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` varchar(64) NOT NULL,
	`factory_id` varchar(64) NOT NULL,
	`client_project_id` varchar(128),
	`display_name` varchar(160) NOT NULL,
	`canonical_name` varchar(200) NOT NULL,
	`version` int unsigned NOT NULL DEFAULT 1,
	`archived` boolean NOT NULL DEFAULT false,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	CONSTRAINT `projects_id` PRIMARY KEY(`id`),
	CONSTRAINT `projects_canonical_uq` UNIQUE(`canonical_name`)
);
--> statement-breakpoint
CREATE TABLE `run_events` (
	`id` varchar(64) NOT NULL,
	`run_id` varchar(64) NOT NULL,
	`sequence` int unsigned NOT NULL,
	`level` varchar(16) NOT NULL,
	`stage` varchar(96) NOT NULL,
	`message` text NOT NULL,
	`evidence_artifact_id` varchar(64),
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `run_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `run_events_sequence_uq` UNIQUE(`run_id`,`sequence`)
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` varchar(64) NOT NULL,
	`project_id` varchar(64) NOT NULL,
	`snapshot_id` varchar(64) NOT NULL,
	`client_run_id` varchar(128) NOT NULL,
	`idempotency_key` varchar(128) NOT NULL,
	`action` varchar(40) NOT NULL,
	`status` varchar(48) NOT NULL,
	`current_stage` varchar(96) NOT NULL,
	`request_sha256` varchar(64) NOT NULL,
	`server_connection_enabled` boolean NOT NULL DEFAULT true,
	`model_egress_authorized` boolean NOT NULL DEFAULT false,
	`deployment_authorized` boolean NOT NULL DEFAULT false,
	`deployment_performed` boolean NOT NULL DEFAULT false,
	`full_skill_coverage_proven` boolean NOT NULL DEFAULT false,
	`client_compatibility_proven` boolean NOT NULL DEFAULT false,
	`created_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL,
	`finished_at` datetime(3),
	CONSTRAINT `runs_id` PRIMARY KEY(`id`),
	CONSTRAINT `runs_idempotency_uq` UNIQUE(`project_id`,`idempotency_key`),
	CONSTRAINT `runs_client_uq` UNIQUE(`project_id`,`client_run_id`)
);
--> statement-breakpoint
CREATE TABLE `workers` (
	`id` varchar(64) NOT NULL,
	`display_name` varchar(160) NOT NULL,
	`capabilities` json NOT NULL,
	`disabled` boolean NOT NULL DEFAULT false,
	`last_heartbeat_at` datetime(3),
	`created_at` datetime(3) NOT NULL,
	CONSTRAINT `workers_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `artifacts_run_idx` ON `artifacts` (`run_id`);--> statement-breakpoint
CREATE INDEX `guardrail_run_idx` ON `guardrail_decisions` (`run_id`);--> statement-breakpoint
CREATE INDEX `image_attempts_run_idx` ON `image_attempts` (`run_id`);--> statement-breakpoint
CREATE INDEX `jobs_claim_idx` ON `jobs` (`status`,`kind`,`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `jobs_run_idx` ON `jobs` (`run_id`);--> statement-breakpoint
CREATE INDEX `manual_reviews_run_idx` ON `manual_reviews` (`run_id`);--> statement-breakpoint
CREATE INDEX `model_calls_run_idx` ON `model_calls` (`run_id`);--> statement-breakpoint
CREATE INDEX `npk_inventories_project_idx` ON `npk_inventories` (`project_id`);--> statement-breakpoint
CREATE INDEX `outbox_pending_idx` ON `outbox_events` (`published_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `project_snapshots_project_idx` ON `project_snapshots` (`project_id`);--> statement-breakpoint
CREATE INDEX `projects_factory_idx` ON `projects` (`factory_id`);--> statement-breakpoint
CREATE INDEX `runs_project_idx` ON `runs` (`project_id`);--> statement-breakpoint
CREATE INDEX `workers_disabled_idx` ON `workers` (`disabled`);