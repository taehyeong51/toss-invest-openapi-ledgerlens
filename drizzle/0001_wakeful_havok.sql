CREATE TABLE `cash_flows` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`occurred_at` text NOT NULL,
	`owner_id` text NOT NULL,
	`account_key` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`kind` text NOT NULL,
	`amount_krw` text NOT NULL,
	`note` text NOT NULL,
	`source` text NOT NULL,
	CONSTRAINT "cash_flows_kind_check" CHECK("cash_flows"."kind" IN ('contribution', 'withdrawal')),
	CONSTRAINT "cash_flows_source_check" CHECK("cash_flows"."source" = 'manual')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_cash_flows_owner_idempotency` ON `cash_flows` (`owner_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_cash_flows_owner_account_occurred` ON `cash_flows` (`owner_id`,`account_key`,`occurred_at`);