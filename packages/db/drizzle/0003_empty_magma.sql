CREATE TABLE `message_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`connection_id` text,
	`chat_id` text NOT NULL,
	`type` text DEFAULT 'text' NOT NULL,
	`content` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`scheduled_at` integer,
	`sent_at` integer,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`max_retries` integer DEFAULT 3 NOT NULL,
	`last_error` text,
	`label` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `waha_sessions`(`id`) ON UPDATE no action ON DELETE set null
);