ALTER TABLE `npk_inventories` ADD `source_id` varchar(120);--> statement-breakpoint
ALTER TABLE `npk_inventories` ADD CONSTRAINT `npk_inventories_run_source_uq` UNIQUE(`run_id`,`source_id`);