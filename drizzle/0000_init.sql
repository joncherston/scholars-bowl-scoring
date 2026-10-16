CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`details` text,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_event` ON `audit_log` (`event_id`);--> statement-breakpoint
CREATE TABLE `auth_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`user_id` integer,
	`event_id` integer,
	`room_id` integer,
	`device_id` text,
	`expires_at` text NOT NULL,
	`last_seen_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `auth_sessions_user` ON `auth_sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `event_staff` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_staff_unique` ON `event_staff` (`event_id`,`email`,`role`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`event_date` text NOT NULL,
	`is_test` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'setup' NOT NULL,
	`public_results` integer DEFAULT false NOT NULL,
	`confirmations` text DEFAULT '{}' NOT NULL,
	`classifications` text NOT NULL,
	`settings_source` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `matches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`round_no` integer NOT NULL,
	`room_id` integer NOT NULL,
	`team_a_id` integer NOT NULL,
	`team_b_id` integer NOT NULL,
	`counts` integer DEFAULT true NOT NULL,
	`pool_id` integer,
	`rule_version_id` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`team_a_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`team_b_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pool_id`) REFERENCES `pools`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`rule_version_id`) REFERENCES `rule_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `matches_session` ON `matches` (`session_id`,`round_no`);--> statement-breakpoint
CREATE TABLE `players` (
	`id` text PRIMARY KEY NOT NULL,
	`school_id` integer NOT NULL,
	`first_name` text NOT NULL,
	`last_name` text NOT NULL,
	`preferred_name` text,
	`grade` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `pools` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`name` text NOT NULL,
	`classifications` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `rejected_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_uuid` text NOT NULL,
	`match_id` integer,
	`device_id` text,
	`reason` text NOT NULL,
	`raw` text NOT NULL,
	`received_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rooms` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`pin` text NOT NULL,
	`projector_token` text NOT NULL,
	`active_device_id` text,
	`last_heard_at` text,
	`active` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `roster_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`team_id` integer NOT NULL,
	`player_id` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`removed` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `roster_unique` ON `roster_entries` (`team_id`,`player_id`);--> statement-breakpoint
CREATE TABLE `rule_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`version` integer NOT NULL,
	`settings` text NOT NULL,
	`note` text,
	`created_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rule_versions_event_version` ON `rule_versions` (`event_id`,`version`);--> statement-breakpoint
CREATE TABLE `schools` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`display_name` text NOT NULL,
	`normalized_key` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `score_events` (
	`id` text PRIMARY KEY NOT NULL,
	`match_id` integer NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`body` text NOT NULL,
	`actor` text NOT NULL,
	`actor_name` text,
	`device_id` text,
	`device_seq` integer,
	`client_ts` text,
	`server_ts` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`source` text DEFAULT 'live' NOT NULL,
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `score_events_match_seq` ON `score_events` (`match_id`,`seq`);--> statement-breakpoint
CREATE INDEX `score_events_device` ON `score_events` (`device_id`,`match_id`);--> statement-breakpoint
CREATE TABLE `session_rooms` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`room_id` integer NOT NULL,
	`moderator` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_rooms_unique` ON `session_rooms` (`session_id`,`room_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`name` text NOT NULL,
	`date` text NOT NULL,
	`start_time` text NOT NULL,
	`classifications` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`round_count` integer DEFAULT 6 NOT NULL,
	`round_times` text DEFAULT '[]' NOT NULL,
	`schedule_status` text DEFAULT 'draft' NOT NULL,
	`schedule_published_at` text,
	`finalized_at` text,
	`finalized_by` text,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `teams` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`school_id` integer NOT NULL,
	`name` text NOT NULL,
	`classification` text NOT NULL,
	`session_id` integer,
	`registration_id` integer,
	`source` text DEFAULT 'manual' NOT NULL,
	`registration_status` text,
	`contact_name` text,
	`contact_email` text,
	`contact_phone` text,
	`competing_students` integer,
	`coaches` integer,
	`arrived_at` text,
	`arrived_by` text,
	`withdrawn` integer DEFAULT false NOT NULL,
	`notes` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teams_event_registration` ON `teams` (`event_id`,`registration_id`);--> statement-breakpoint
CREATE INDEX `teams_event` ON `teams` (`event_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`password_hash` text NOT NULL,
	`is_admin` integer DEFAULT false NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`must_change_password` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);