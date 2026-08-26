CREATE TABLE `portfolio_holding_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`snapshot_id` text NOT NULL,
	`position` integer NOT NULL,
	`symbol` text NOT NULL,
	`name` text NOT NULL,
	`market_country` text NOT NULL,
	`currency` text NOT NULL,
	`quantity` text NOT NULL,
	`last_price` text NOT NULL,
	`average_purchase_price` text NOT NULL,
	`market_value_native` text NOT NULL,
	`market_value_krw` text NOT NULL,
	`profit_loss_native` text NOT NULL,
	`profit_loss_rate` text NOT NULL,
	`daily_profit_loss_native` text NOT NULL,
	`daily_profit_loss_rate` text NOT NULL,
	FOREIGN KEY (`snapshot_id`) REFERENCES `portfolio_snapshots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_portfolio_holding_snapshots_snapshot_position` ON `portfolio_holding_snapshots` (`snapshot_id`,`position`);--> statement-breakpoint
CREATE TABLE `portfolio_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`captured_at` text NOT NULL,
	`owner_id` text NOT NULL,
	`account_key` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`mode` text NOT NULL,
	`account_masked_number` text NOT NULL,
	`account_type` text NOT NULL,
	`equity_value_krw` text NOT NULL,
	`purchase_value_krw` text NOT NULL,
	`profit_loss_krw` text NOT NULL,
	`profit_loss_rate` text NOT NULL,
	`daily_profit_loss_krw` text NOT NULL,
	`daily_profit_loss_rate` text NOT NULL,
	`buying_power_krw` text NOT NULL,
	`buying_power_usd` text NOT NULL,
	`usd_krw_rate` text NOT NULL,
	`total_tracked_value_krw` text NOT NULL,
	`holding_count` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_portfolio_snapshots_owner_idempotency` ON `portfolio_snapshots` (`owner_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_portfolio_snapshots_owner_account_captured` ON `portfolio_snapshots` (`owner_id`,`account_key`,`captured_at`);