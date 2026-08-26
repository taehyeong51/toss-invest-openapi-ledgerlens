CREATE TABLE `external_asset_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`account_key` text NOT NULL,
	`captured_at` text NOT NULL,
	`reason` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`institution` text NOT NULL,
	`currency` text NOT NULL,
	`balance` text NOT NULL,
	`value_krw` text NOT NULL,
	`valued_at` text NOT NULL,
	`maturity_date` text,
	`annual_rate_percent` text,
	`note` text NOT NULL,
	`source` text NOT NULL,
	`revision` integer NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `external_assets`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "external_asset_snapshots_reason_check" CHECK("external_asset_snapshots"."reason" IN ('created', 'updated')),
	CONSTRAINT "external_asset_snapshots_kind_check" CHECK("external_asset_snapshots"."kind" IN ('cash', 'deposit', 'savings', 'pension', 'insurance', 'property', 'crypto', 'other')),
	CONSTRAINT "external_asset_snapshots_source_check" CHECK("external_asset_snapshots"."source" = 'manual'),
	CONSTRAINT "external_asset_snapshots_revision_check" CHECK("external_asset_snapshots"."revision" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_external_asset_snapshots_asset_revision` ON `external_asset_snapshots` (`asset_id`,`revision`);--> statement-breakpoint
CREATE INDEX `idx_external_asset_snapshots_owner_account_captured` ON `external_asset_snapshots` (`owner_id`,`account_key`,`captured_at`);--> statement-breakpoint
CREATE TABLE `external_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`account_key` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`institution` text NOT NULL,
	`currency` text NOT NULL,
	`balance` text NOT NULL,
	`value_krw` text NOT NULL,
	`valued_at` text NOT NULL,
	`maturity_date` text,
	`annual_rate_percent` text,
	`note` text NOT NULL,
	`source` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "external_assets_kind_check" CHECK("external_assets"."kind" IN ('cash', 'deposit', 'savings', 'pension', 'insurance', 'property', 'crypto', 'other')),
	CONSTRAINT "external_assets_source_check" CHECK("external_assets"."source" = 'manual'),
	CONSTRAINT "external_assets_revision_check" CHECK("external_assets"."revision" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_external_assets_owner_account_idempotency` ON `external_assets` (`owner_id`,`account_key`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_external_assets_owner_account_updated` ON `external_assets` (`owner_id`,`account_key`,`updated_at`);