ALTER TABLE `api_tokens` ADD `connection_id` text REFERENCES waha_sessions(id) ON DELETE set null;
