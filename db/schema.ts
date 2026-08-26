import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * One immutable, point-in-time view of the connected portfolio.
 *
 * Financial values intentionally use TEXT instead of SQLite REAL so values
 * returned by Toss never pass through binary floating-point storage.
 */
export const portfolioSnapshots = sqliteTable(
  "portfolio_snapshots",
  {
    id: text("id").primaryKey(),
    capturedAt: text("captured_at").notNull(),
    ownerId: text("owner_id").notNull(),
    accountKey: text("account_key").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    mode: text("mode").notNull(),
    accountMaskedNumber: text("account_masked_number").notNull(),
    accountType: text("account_type").notNull(),
    equityValueKrw: text("equity_value_krw").notNull(),
    purchaseValueKrw: text("purchase_value_krw").notNull(),
    profitLossKrw: text("profit_loss_krw").notNull(),
    profitLossRate: text("profit_loss_rate").notNull(),
    dailyProfitLossKrw: text("daily_profit_loss_krw").notNull(),
    dailyProfitLossRate: text("daily_profit_loss_rate").notNull(),
    buyingPowerKrw: text("buying_power_krw").notNull(),
    buyingPowerUsd: text("buying_power_usd").notNull(),
    usdKrwRate: text("usd_krw_rate").notNull(),
    totalTrackedValueKrw: text("total_tracked_value_krw").notNull(),
    holdingCount: integer("holding_count").notNull(),
  },
  (table) => [
    uniqueIndex("idx_portfolio_snapshots_owner_idempotency").on(
      table.ownerId,
      table.idempotencyKey,
    ),
    index("idx_portfolio_snapshots_owner_account_captured").on(
      table.ownerId,
      table.accountKey,
      table.capturedAt,
    ),
  ],
);

/** Holdings are copied into the snapshot so history remains reproducible. */
export const portfolioHoldingSnapshots = sqliteTable(
  "portfolio_holding_snapshots",
  {
    id: text("id").primaryKey(),
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => portfolioSnapshots.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    symbol: text("symbol").notNull(),
    name: text("name").notNull(),
    marketCountry: text("market_country").notNull(),
    currency: text("currency").notNull(),
    quantity: text("quantity").notNull(),
    lastPrice: text("last_price").notNull(),
    averagePurchasePrice: text("average_purchase_price").notNull(),
    marketValueNative: text("market_value_native").notNull(),
    marketValueKrw: text("market_value_krw").notNull(),
    profitLossNative: text("profit_loss_native").notNull(),
    profitLossRate: text("profit_loss_rate").notNull(),
    dailyProfitLossNative: text("daily_profit_loss_native").notNull(),
    dailyProfitLossRate: text("daily_profit_loss_rate").notNull(),
  },
  (table) => [
    uniqueIndex("idx_portfolio_holding_snapshots_snapshot_position").on(
      table.snapshotId,
      table.position,
    ),
  ],
);

/**
 * An immutable owner-entered contribution or withdrawal. Money remains TEXT
 * so cash-flow-adjusted performance never relies on SQLite floating point.
 */
export const cashFlows = sqliteTable(
  "cash_flows",
  {
    id: text("id").primaryKey(),
    createdAt: text("created_at").notNull(),
    occurredAt: text("occurred_at").notNull(),
    ownerId: text("owner_id").notNull(),
    accountKey: text("account_key").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    kind: text("kind").notNull(),
    amountKrw: text("amount_krw").notNull(),
    note: text("note").notNull(),
    source: text("source").notNull(),
  },
  (table) => [
    check(
      "cash_flows_kind_check",
      sql`${table.kind} IN ('contribution', 'withdrawal')`,
    ),
    check("cash_flows_source_check", sql`${table.source} = 'manual'`),
    uniqueIndex("idx_cash_flows_owner_account_idempotency").on(
      table.ownerId,
      table.accountKey,
      table.idempotencyKey,
    ),
    index("idx_cash_flows_owner_account_occurred").on(
      table.ownerId,
      table.accountKey,
      table.occurredAt,
    ),
  ],
);

/**
 * One editable capital plan per owner and connected account. Financial values
 * and weights remain TEXT so validation and storage never use SQLite REAL.
 */
export const capitalPlans = sqliteTable(
  "capital_plans",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    accountKey: text("account_key").notNull(),
    startAssetKrw: text("start_asset_krw"),
    targetAssetKrw: text("target_asset_krw").notNull(),
    startDate: text("start_date").notNull(),
    targetDate: text("target_date").notNull(),
    monthlyContributionKrw: text("monthly_contribution_krw").notNull(),
    targetKrWeight: text("target_kr_weight").notNull(),
    targetUsWeight: text("target_us_weight").notNull(),
    targetCashWeight: text("target_cash_weight").notNull(),
    revision: integer("revision").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("capital_plans_revision_check", sql`${table.revision} >= 1`),
    uniqueIndex("idx_capital_plans_owner_account").on(table.ownerId, table.accountKey),
  ],
);

/** A short periodic review with one owner-chosen follow-up action. */
export const reviewJournal = sqliteTable(
  "review_journal",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    accountKey: text("account_key").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    periodStartedAt: text("period_started_at").notNull(),
    periodEndedAt: text("period_ended_at").notNull(),
    cashFlowConfirmation: text("cash_flow_confirmation").notNull(),
    action: text("action").notNull(),
    status: text("status").notNull(),
    snapshotCount: integer("snapshot_count").notNull(),
    planRevision: integer("plan_revision"),
    revision: integer("revision").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    resolvedAt: text("resolved_at"),
  },
  (table) => [
    check(
      "review_journal_cash_flow_confirmation_check",
      sql`${table.cashFlowConfirmation} IN ('complete', 'incomplete')`,
    ),
    check("review_journal_status_check", sql`${table.status} IN ('open', 'resolved')`),
    check(
      "review_journal_snapshot_count_check",
      sql`${table.snapshotCount} BETWEEN 0 AND 365`,
    ),
    check("review_journal_revision_check", sql`${table.revision} >= 1`),
    uniqueIndex("idx_review_journal_owner_account_idempotency").on(
      table.ownerId,
      table.accountKey,
      table.idempotencyKey,
    ),
    index("idx_review_journal_owner_account_created").on(
      table.ownerId,
      table.accountKey,
      table.createdAt,
    ),
  ],
);

/**
 * An owner-maintained asset outside the connected Toss portfolio. The balance,
 * KRW valuation, and optional rate remain TEXT to preserve decimal precision.
 */
export const externalAssets = sqliteTable(
  "external_assets",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    accountKey: text("account_key").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    institution: text("institution").notNull(),
    currency: text("currency").notNull(),
    balance: text("balance").notNull(),
    valueKrw: text("value_krw").notNull(),
    valuedAt: text("valued_at").notNull(),
    maturityDate: text("maturity_date"),
    annualRatePercent: text("annual_rate_percent"),
    note: text("note").notNull(),
    source: text("source").notNull(),
    revision: integer("revision").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check(
      "external_assets_kind_check",
      sql`${table.kind} IN ('cash', 'deposit', 'savings', 'pension', 'insurance', 'property', 'crypto', 'other')`,
    ),
    check("external_assets_source_check", sql`${table.source} = 'manual'`),
    check("external_assets_revision_check", sql`${table.revision} >= 1`),
    uniqueIndex("idx_external_assets_owner_account_idempotency").on(
      table.ownerId,
      table.accountKey,
      table.idempotencyKey,
    ),
    index("idx_external_assets_owner_account_updated").on(
      table.ownerId,
      table.accountKey,
      table.updatedAt,
    ),
  ],
);

/** Immutable valuation history for every created or updated external asset. */
export const externalAssetSnapshots = sqliteTable(
  "external_asset_snapshots",
  {
    id: text("id").primaryKey(),
    assetId: text("asset_id")
      .notNull()
      .references(() => externalAssets.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull(),
    accountKey: text("account_key").notNull(),
    capturedAt: text("captured_at").notNull(),
    reason: text("reason").notNull(),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    institution: text("institution").notNull(),
    currency: text("currency").notNull(),
    balance: text("balance").notNull(),
    valueKrw: text("value_krw").notNull(),
    valuedAt: text("valued_at").notNull(),
    maturityDate: text("maturity_date"),
    annualRatePercent: text("annual_rate_percent"),
    note: text("note").notNull(),
    source: text("source").notNull(),
    revision: integer("revision").notNull(),
  },
  (table) => [
    check(
      "external_asset_snapshots_reason_check",
      sql`${table.reason} IN ('created', 'updated')`,
    ),
    check(
      "external_asset_snapshots_kind_check",
      sql`${table.kind} IN ('cash', 'deposit', 'savings', 'pension', 'insurance', 'property', 'crypto', 'other')`,
    ),
    check("external_asset_snapshots_source_check", sql`${table.source} = 'manual'`),
    check(
      "external_asset_snapshots_revision_check",
      sql`${table.revision} >= 1`,
    ),
    uniqueIndex("idx_external_asset_snapshots_asset_revision").on(
      table.assetId,
      table.revision,
    ),
    index("idx_external_asset_snapshots_owner_account_captured").on(
      table.ownerId,
      table.accountKey,
      table.capturedAt,
    ),
  ],
);

/**
 * Owner-authorized automation policy. Phase 4A intentionally supports one
 * fixed weekday schedule per owner; trigger provisioning remains a hosting
 * control-plane responsibility.
 */
export const snapshotSchedules = sqliteTable(
  "snapshot_schedules",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    accountKey: text("account_key").notNull(),
    enabled: integer("enabled").notNull(),
    timezone: text("timezone").notNull(),
    localTime: text("local_time").notNull(),
    weekdays: text("weekdays").notNull(),
    revision: integer("revision").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    triggerVerifiedAt: text("trigger_verified_at"),
  },
  (table) => [
    check("snapshot_schedules_enabled_check", sql`${table.enabled} IN (0, 1)`),
    check("snapshot_schedules_timezone_check", sql`${table.timezone} = 'Asia/Seoul'`),
    check("snapshot_schedules_local_time_check", sql`${table.localTime} = '07:10'`),
    check("snapshot_schedules_weekdays_check", sql`${table.weekdays} = '1,2,3,4,5'`),
    check("snapshot_schedules_revision_check", sql`${table.revision} >= 1`),
    uniqueIndex("idx_snapshot_schedules_owner").on(table.ownerId),
    index("idx_snapshot_schedules_enabled_account").on(table.enabled, table.accountKey),
  ],
);

/** Operational metadata only; it never contains portfolio payloads or secrets. */
export const snapshotCaptureRuns = sqliteTable(
  "snapshot_capture_runs",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    accountKey: text("account_key").notNull(),
    scheduledFor: text("scheduled_for").notNull(),
    status: text("status").notNull(),
    attemptCount: integer("attempt_count").notNull(),
    leaseToken: text("lease_token"),
    leaseExpiresAt: text("lease_expires_at"),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    snapshotId: text("snapshot_id"),
    errorCode: text("error_code"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check(
      "snapshot_capture_runs_status_check",
      sql`${table.status} IN ('running', 'succeeded', 'retryable-failure', 'terminal-failure', 'skipped')`,
    ),
    check(
      "snapshot_capture_runs_attempt_count_check",
      sql`${table.attemptCount} BETWEEN 1 AND 3`,
    ),
    uniqueIndex("idx_snapshot_capture_runs_owner_account_slot").on(
      table.ownerId,
      table.accountKey,
      table.scheduledFor,
    ),
    index("idx_snapshot_capture_runs_status_lease").on(table.status, table.leaseExpiresAt),
  ],
);
