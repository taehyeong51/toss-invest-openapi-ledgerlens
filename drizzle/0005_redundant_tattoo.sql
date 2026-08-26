CREATE TABLE `review_journal` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`account_key` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`period_started_at` text NOT NULL,
	`period_ended_at` text NOT NULL,
	`cash_flow_confirmation` text NOT NULL,
	`action` text NOT NULL,
	`status` text NOT NULL,
	`snapshot_count` integer NOT NULL,
	`plan_revision` integer,
	`revision` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`resolved_at` text,
	CONSTRAINT "review_journal_cash_flow_confirmation_check" CHECK("review_journal"."cash_flow_confirmation" IN ('complete', 'incomplete')),
	CONSTRAINT "review_journal_status_check" CHECK("review_journal"."status" IN ('open', 'resolved')),
	CONSTRAINT "review_journal_snapshot_count_check" CHECK("review_journal"."snapshot_count" BETWEEN 0 AND 365),
	CONSTRAINT "review_journal_revision_check" CHECK("review_journal"."revision" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_review_journal_owner_account_idempotency` ON `review_journal` (`owner_id`,`account_key`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_review_journal_owner_account_created` ON `review_journal` (`owner_id`,`account_key`,`created_at`);--> statement-breakpoint
ALTER TABLE `capital_plans` ADD `start_asset_krw` text;
