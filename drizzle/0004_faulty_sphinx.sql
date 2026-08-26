CREATE TABLE `capital_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`account_key` text NOT NULL,
	`target_asset_krw` text NOT NULL,
	`start_date` text NOT NULL,
	`target_date` text NOT NULL,
	`monthly_contribution_krw` text NOT NULL,
	`target_kr_weight` text NOT NULL,
	`target_us_weight` text NOT NULL,
	`target_cash_weight` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "capital_plans_revision_check" CHECK("capital_plans"."revision" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_capital_plans_owner_account` ON `capital_plans` (`owner_id`,`account_key`);