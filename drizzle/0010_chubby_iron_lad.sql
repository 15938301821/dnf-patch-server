ALTER TABLE `profession_skills` ADD `profession_prompt` json;--> statement-breakpoint
ALTER TABLE `profession_skills` ADD `profession_prompt_sha256` varchar(64);--> statement-breakpoint
ALTER TABLE `profession_style_skills` ADD `changes` text;--> statement-breakpoint
ALTER TABLE `profession_style_skills` ADD `acceptance_criteria` text;--> statement-breakpoint
ALTER TABLE `profession_style_skills` ADD `exclusions` text;--> statement-breakpoint
ALTER TABLE `profession_styles` ADD `theme_definition` json;--> statement-breakpoint
ALTER TABLE `profession_skills` ADD CONSTRAINT `profession_skills_prompt_binding_ck` CHECK ((`profession_skills`.`profession_prompt` is null and `profession_skills`.`profession_prompt_sha256` is null) or (`profession_skills`.`profession_prompt` is not null and `profession_skills`.`profession_prompt_sha256` is not null));