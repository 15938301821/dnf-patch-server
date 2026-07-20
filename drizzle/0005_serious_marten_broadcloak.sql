ALTER TABLE `npk_inventories` DROP FOREIGN KEY `npk_inventories_inventory_artifact_id_artifacts_id_fk`;
--> statement-breakpoint
ALTER TABLE `npk_inventories` ADD `run_id` varchar(64) NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD CONSTRAINT `runs_project_id_uq` UNIQUE(`project_id`,`id`);--> statement-breakpoint
ALTER TABLE `npk_inventories` ADD CONSTRAINT `npk_inventories_project_run_fk` FOREIGN KEY (`project_id`,`run_id`) REFERENCES `runs`(`project_id`,`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `npk_inventories` ADD CONSTRAINT `npk_inventories_inventory_artifact_run_fk` FOREIGN KEY (`run_id`,`inventory_artifact_id`) REFERENCES `artifacts`(`run_id`,`id`) ON DELETE restrict ON UPDATE no action;