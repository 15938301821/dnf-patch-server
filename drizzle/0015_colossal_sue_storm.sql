CREATE TABLE `profession_skill_source_entries` (
	`profession_id` varchar(64) NOT NULL,
	`skill_id` varchar(64) NOT NULL,
	`source_inventory_id` varchar(64) NOT NULL,
	`source_inventory_entry_id` varchar(64) NOT NULL,
	`ordinal` int unsigned NOT NULL,
	CONSTRAINT `profession_skill_source_entries_pk` PRIMARY KEY(`skill_id`,`source_inventory_entry_id`),
	CONSTRAINT `profession_skill_source_entries_ordinal_uq` UNIQUE(`skill_id`,`ordinal`)
);
--> statement-breakpoint
ALTER TABLE `profession_skills` ADD CONSTRAINT `profession_skills_source_inventory_uq` UNIQUE(`profession_id`,`id`,`source_inventory_id`);--> statement-breakpoint
ALTER TABLE `profession_skill_source_entries` ADD CONSTRAINT `profession_skill_source_entries_skill_inventory_fk` FOREIGN KEY (`profession_id`,`skill_id`,`source_inventory_id`) REFERENCES `profession_skills`(`profession_id`,`id`,`source_inventory_id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `profession_skill_source_entries` ADD CONSTRAINT `profession_skill_source_entries_inventory_entry_fk` FOREIGN KEY (`source_inventory_id`,`source_inventory_entry_id`) REFERENCES `npk_inventory_entries`(`inventory_id`,`id`) ON DELETE restrict ON UPDATE no action;