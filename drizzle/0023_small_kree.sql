ALTER TABLE `model_calls` ADD `input_tokens` int unsigned;--> statement-breakpoint
ALTER TABLE `model_calls` ADD `output_tokens` int unsigned;--> statement-breakpoint
ALTER TABLE `model_calls` ADD `total_tokens` int unsigned;--> statement-breakpoint
ALTER TABLE `model_calls` ADD `provider_latency_ms` int unsigned;--> statement-breakpoint
ALTER TABLE `model_calls` ADD CONSTRAINT `model_calls_usage_ck` CHECK ((`model_calls`.`input_tokens` is null and `model_calls`.`output_tokens` is null and `model_calls`.`total_tokens` is null) or (`model_calls`.`input_tokens` is not null and `model_calls`.`output_tokens` is not null and `model_calls`.`total_tokens` is not null));--> statement-breakpoint
ALTER TABLE `model_calls` ADD CONSTRAINT `model_calls_latency_ck` CHECK (`model_calls`.`provider_latency_ms` is null or `model_calls`.`provider_latency_ms` > 0);