ALTER TABLE `job_attempts` ADD `lease_id` varchar(64);--> statement-breakpoint
ALTER TABLE `jobs` ADD `lease_id` varchar(64);--> statement-breakpoint
ALTER TABLE `runs` ADD `request_fingerprint_sha256` varchar(64);--> statement-breakpoint
ALTER TABLE `job_attempts` ADD CONSTRAINT `job_attempts_status_ck` CHECK (`job_attempts`.`status` in ('running', 'passed', 'failed', 'blocked', 'timed_out'));--> statement-breakpoint
ALTER TABLE `jobs` ADD CONSTRAINT `jobs_status_ck` CHECK (`jobs`.`status` in ('queued', 'leased', 'passed', 'failed', 'blocked'));--> statement-breakpoint
ALTER TABLE `jobs` ADD CONSTRAINT `jobs_attempt_limit_ck` CHECK (`jobs`.`attempt_count` <= `jobs`.`max_attempts`);--> statement-breakpoint
ALTER TABLE `jobs` ADD CONSTRAINT `jobs_lease_fields_ck` CHECK ((`jobs`.`status` = 'leased' and `jobs`.`lease_owner_id` is not null and `jobs`.`lease_id` is not null and `jobs`.`lease_expires_at` is not null) or (`jobs`.`status` <> 'leased' and `jobs`.`lease_owner_id` is null and `jobs`.`lease_id` is null and `jobs`.`lease_expires_at` is null));--> statement-breakpoint
ALTER TABLE `runs` ADD CONSTRAINT `runs_status_ck` CHECK (`runs`.`status` in ('queued', 'running', 'passed', 'failed', 'blocked'));--> statement-breakpoint
ALTER TABLE `runs` ADD CONSTRAINT `runs_safety_state_ck` CHECK (`runs`.`deployment_authorized` = false and `runs`.`deployment_performed` = false and `runs`.`full_skill_coverage_proven` = false and `runs`.`client_compatibility_proven` = false);