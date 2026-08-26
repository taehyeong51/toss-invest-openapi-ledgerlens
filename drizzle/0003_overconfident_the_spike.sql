CREATE TABLE `snapshot_capture_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`account_key` text NOT NULL,
	`scheduled_for` text NOT NULL,
	`status` text NOT NULL,
	`attempt_count` integer NOT NULL,
	`lease_token` text,
	`lease_expires_at` text,
	`started_at` text NOT NULL,
	`finished_at` text,
	`snapshot_id` text,
	`error_code` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "snapshot_capture_runs_status_check" CHECK("snapshot_capture_runs"."status" IN ('running', 'succeeded', 'retryable-failure', 'terminal-failure', 'skipped')),
	CONSTRAINT "snapshot_capture_runs_attempt_count_check" CHECK("snapshot_capture_runs"."attempt_count" BETWEEN 1 AND 3)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_snapshot_capture_runs_owner_account_slot` ON `snapshot_capture_runs` (`owner_id`,`account_key`,`scheduled_for`);--> statement-breakpoint
CREATE INDEX `idx_snapshot_capture_runs_status_lease` ON `snapshot_capture_runs` (`status`,`lease_expires_at`);--> statement-breakpoint
CREATE TABLE `snapshot_schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`account_key` text NOT NULL,
	`enabled` integer NOT NULL,
	`timezone` text NOT NULL,
	`local_time` text NOT NULL,
	`weekdays` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`trigger_verified_at` text,
	CONSTRAINT "snapshot_schedules_enabled_check" CHECK("snapshot_schedules"."enabled" IN (0, 1)),
	CONSTRAINT "snapshot_schedules_timezone_check" CHECK("snapshot_schedules"."timezone" = 'Asia/Seoul'),
	CONSTRAINT "snapshot_schedules_local_time_check" CHECK("snapshot_schedules"."local_time" = '07:10'),
	CONSTRAINT "snapshot_schedules_weekdays_check" CHECK("snapshot_schedules"."weekdays" = '1,2,3,4,5'),
	CONSTRAINT "snapshot_schedules_revision_check" CHECK("snapshot_schedules"."revision" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_snapshot_schedules_owner` ON `snapshot_schedules` (`owner_id`);--> statement-breakpoint
CREATE INDEX `idx_snapshot_schedules_enabled_account` ON `snapshot_schedules` (`enabled`,`account_key`);