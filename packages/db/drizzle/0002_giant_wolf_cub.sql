DROP INDEX "users_email_unique";--> statement-breakpoint
DROP INDEX "users_stripe_customer_id_unique";--> statement-breakpoint
DROP INDEX "waha_workers_pod_name_unique";--> statement-breakpoint
DROP INDEX "waha_sessions_session_name_unique";--> statement-breakpoint
DROP INDEX "api_tokens_token_hash_unique";--> statement-breakpoint
ALTER TABLE `waha_workers` ALTER COLUMN "ingress_secret" TO "ingress_secret" text;--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_stripe_customer_id_unique` ON `users` (`stripe_customer_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `waha_workers_pod_name_unique` ON `waha_workers` (`pod_name`);--> statement-breakpoint
CREATE UNIQUE INDEX `waha_sessions_session_name_unique` ON `waha_sessions` (`session_name`);--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_token_hash_unique` ON `api_tokens` (`token_hash`);--> statement-breakpoint
ALTER TABLE `waha_sessions` ADD COLUMN `warmup_connected_at` integer;--> statement-breakpoint
ALTER TABLE `waha_sessions` ADD COLUMN `warmup_total_sent` integer NOT NULL DEFAULT 0;