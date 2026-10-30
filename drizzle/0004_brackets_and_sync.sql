CREATE TABLE `bracket_slots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`division` text NOT NULL,
	`slot` text NOT NULL,
	`label` text NOT NULL,
	`round_no` integer NOT NULL,
	`room_id` integer,
	`source_a` text NOT NULL,
	`source_b` text NOT NULL,
	`counts` integer DEFAULT true NOT NULL,
	`match_id` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bracket_slots_unique` ON `bracket_slots` (`session_id`,`division`,`slot`);--> statement-breakpoint
ALTER TABLE `events` ADD `wp_event_id` integer;--> statement-breakpoint
ALTER TABLE `events` ADD `wp_synced_at` text;--> statement-breakpoint
ALTER TABLE `events` ADD `public_individuals` text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE `matches` ADD `stage` text DEFAULT 'pool' NOT NULL;--> statement-breakpoint
ALTER TABLE `matches` ADD `bracket_slot` text;--> statement-breakpoint
ALTER TABLE `matches` ADD `division` text;--> statement-breakpoint
ALTER TABLE `players` ADD `wp_student_id` integer;--> statement-breakpoint
ALTER TABLE `teams` ADD `pool_id` integer;--> statement-breakpoint
ALTER TABLE `teams` ADD `roster_confirmed_at` text;--> statement-breakpoint
ALTER TABLE `teams` ADD `roster_confirmed_by` text;