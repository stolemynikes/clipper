-- posts was empty when accounts were added: recreate instead of ALTER (SQLite cannot add a NOT NULL column without a default).
DROP TABLE `posts`;--> statement-breakpoint
CREATE TABLE `posts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`clip_id` integer NOT NULL,
	`account_id` integer NOT NULL,
	`platform` text NOT NULL,
	`url` text,
	`posted_at` integer,
	`submitted` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`clip_id`) REFERENCES `clips`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
