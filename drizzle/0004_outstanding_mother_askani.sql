ALTER TABLE `image_attempts` DROP FOREIGN KEY `image_attempts_model_call_id_model_calls_id_fk`;
--> statement-breakpoint
ALTER TABLE `image_attempts` DROP FOREIGN KEY `image_attempts_output_artifact_id_artifacts_id_fk`;
--> statement-breakpoint
ALTER TABLE `manual_reviews` DROP FOREIGN KEY `manual_reviews_evidence_artifact_id_artifacts_id_fk`;
--> statement-breakpoint
ALTER TABLE `run_events` DROP FOREIGN KEY `run_events_evidence_artifact_id_artifacts_id_fk`;
--> statement-breakpoint
ALTER TABLE `artifacts` ADD CONSTRAINT `artifacts_run_id_uq` UNIQUE(`run_id`,`id`);--> statement-breakpoint
ALTER TABLE `model_calls` ADD CONSTRAINT `model_calls_run_id_uq` UNIQUE(`run_id`,`id`);--> statement-breakpoint
ALTER TABLE `image_attempts` ADD CONSTRAINT `image_attempts_model_call_run_fk` FOREIGN KEY (`run_id`,`model_call_id`) REFERENCES `model_calls`(`run_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `image_attempts` ADD CONSTRAINT `image_attempts_output_artifact_run_fk` FOREIGN KEY (`run_id`,`output_artifact_id`) REFERENCES `artifacts`(`run_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `manual_reviews` ADD CONSTRAINT `manual_reviews_evidence_artifact_run_fk` FOREIGN KEY (`run_id`,`evidence_artifact_id`) REFERENCES `artifacts`(`run_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `run_events` ADD CONSTRAINT `run_events_evidence_artifact_run_fk` FOREIGN KEY (`run_id`,`evidence_artifact_id`) REFERENCES `artifacts`(`run_id`,`id`) ON DELETE restrict ON UPDATE no action;