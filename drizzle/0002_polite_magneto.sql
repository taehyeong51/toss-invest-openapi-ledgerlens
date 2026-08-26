DROP INDEX `idx_cash_flows_owner_idempotency`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_cash_flows_owner_account_idempotency` ON `cash_flows` (`owner_id`,`account_key`,`idempotency_key`);