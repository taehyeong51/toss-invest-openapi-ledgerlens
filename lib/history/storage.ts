import { getD1 } from "../../db";
import { isDecimalString } from "../portfolio/decimal";
import { calculateTotalTrackedValueKrw } from "../portfolio/tracked";
import type { PortfolioHolding, PortfolioResponse } from "../portfolio/types";
import type {
  PortfolioHoldingHistoryIdentity,
  PortfolioHoldingHistoryPoint,
  PortfolioHoldingHistorySelector,
  PortfolioSnapshotSummary,
} from "./types";
import { createSnapshotId } from "./identity";

// Runtime initialization keeps local D1 development useful; the generated
// Drizzle migration remains the source of truth for deployed databases. Each
// prepared string below contains exactly one SQL statement.
const CREATE_SNAPSHOTS_TABLE = `
  CREATE TABLE IF NOT EXISTS portfolio_snapshots (
    id TEXT PRIMARY KEY NOT NULL,
    captured_at TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    account_key TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    mode TEXT NOT NULL,
    account_masked_number TEXT NOT NULL,
    account_type TEXT NOT NULL,
    equity_value_krw TEXT NOT NULL,
    purchase_value_krw TEXT NOT NULL,
    profit_loss_krw TEXT NOT NULL,
    profit_loss_rate TEXT NOT NULL,
    daily_profit_loss_krw TEXT NOT NULL,
    daily_profit_loss_rate TEXT NOT NULL,
    buying_power_krw TEXT NOT NULL,
    buying_power_usd TEXT NOT NULL,
    usd_krw_rate TEXT NOT NULL,
    total_tracked_value_krw TEXT NOT NULL,
    holding_count INTEGER NOT NULL
  )
`;

const CREATE_HOLDINGS_TABLE = `
  CREATE TABLE IF NOT EXISTS portfolio_holding_snapshots (
    id TEXT PRIMARY KEY NOT NULL,
    snapshot_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    name TEXT NOT NULL,
    market_country TEXT NOT NULL,
    currency TEXT NOT NULL,
    quantity TEXT NOT NULL,
    last_price TEXT NOT NULL,
    average_purchase_price TEXT NOT NULL,
    market_value_native TEXT NOT NULL,
    market_value_krw TEXT NOT NULL,
    profit_loss_native TEXT NOT NULL,
    profit_loss_rate TEXT NOT NULL,
    daily_profit_loss_native TEXT NOT NULL,
    daily_profit_loss_rate TEXT NOT NULL,
    FOREIGN KEY (snapshot_id) REFERENCES portfolio_snapshots(id) ON DELETE CASCADE
  )
`;

const CREATE_OWNER_IDEMPOTENCY_INDEX = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_portfolio_snapshots_owner_idempotency
  ON portfolio_snapshots (owner_id, idempotency_key)
`;

const CREATE_OWNER_ACCOUNT_CAPTURED_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_owner_account_captured
  ON portfolio_snapshots (owner_id, account_key, captured_at)
`;

const CREATE_HOLDING_POSITION_INDEX = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_portfolio_holding_snapshots_snapshot_position
  ON portfolio_holding_snapshots (snapshot_id, position)
`;

const INSERT_SNAPSHOT = `
  INSERT OR IGNORE INTO portfolio_snapshots (
    id, captured_at, owner_id, account_key, idempotency_key, mode,
    account_masked_number, account_type,
    equity_value_krw, purchase_value_krw, profit_loss_krw, profit_loss_rate,
    daily_profit_loss_krw, daily_profit_loss_rate, buying_power_krw,
    buying_power_usd, usd_krw_rate, total_tracked_value_krw, holding_count
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const INSERT_HOLDINGS = `
  INSERT OR IGNORE INTO portfolio_holding_snapshots (
    id, snapshot_id, position, symbol, name, market_country, currency, quantity,
    last_price, average_purchase_price, market_value_native, market_value_krw,
    profit_loss_native, profit_loss_rate, daily_profit_loss_native,
    daily_profit_loss_rate
  )
  SELECT
    json_extract(value, '$.id'),
    ?,
    CAST(key AS INTEGER),
    json_extract(value, '$.symbol'),
    json_extract(value, '$.name'),
    json_extract(value, '$.marketCountry'),
    json_extract(value, '$.currency'),
    json_extract(value, '$.quantity'),
    json_extract(value, '$.lastPrice'),
    json_extract(value, '$.averagePurchasePrice'),
    json_extract(value, '$.marketValueNative'),
    json_extract(value, '$.marketValueKrw'),
    json_extract(value, '$.profitLossNative'),
    json_extract(value, '$.profitLossRate'),
    json_extract(value, '$.dailyProfitLossNative'),
    json_extract(value, '$.dailyProfitLossRate')
  FROM json_each(?)
`;

const MAX_HOLDINGS_JSON_BYTES = 1_800_000;

const SELECT_SNAPSHOT_BY_ID = `
  SELECT
    id,
    captured_at AS "capturedAt",
    equity_value_krw AS "equityValueKrw",
    profit_loss_krw AS "profitLossKrw",
    buying_power_krw AS "buyingPowerKrw",
    total_tracked_value_krw AS "totalTrackedValueKrw",
    usd_krw_rate AS "usdKrwRate",
    holding_count AS "holdingCount"
  FROM portfolio_snapshots
  WHERE owner_id = ? AND idempotency_key = ?
  LIMIT 1
`;

const LIST_SNAPSHOTS = `
  SELECT
    id,
    captured_at AS "capturedAt",
    equity_value_krw AS "equityValueKrw",
    profit_loss_krw AS "profitLossKrw",
    buying_power_krw AS "buyingPowerKrw",
    total_tracked_value_krw AS "totalTrackedValueKrw",
    usd_krw_rate AS "usdKrwRate",
    holding_count AS "holdingCount"
  FROM portfolio_snapshots
  WHERE owner_id = ? AND account_key = ?
  ORDER BY captured_at DESC, id DESC
  LIMIT ?
`;

const LIST_HOLDING_HISTORY = `
  SELECT
    snapshots.id AS "snapshotId",
    snapshots.captured_at AS "capturedAt",
    holdings.symbol,
    holdings.name,
    holdings.market_country AS "marketCountry",
    holdings.currency,
    holdings.quantity,
    holdings.last_price AS "lastPrice",
    holdings.average_purchase_price AS "averagePurchasePrice",
    holdings.market_value_native AS "marketValueNative",
    holdings.market_value_krw AS "marketValueKrw",
    holdings.profit_loss_native AS "profitLossNative",
    holdings.profit_loss_rate AS "profitLossRate",
    holdings.daily_profit_loss_native AS "dailyProfitLossNative",
    holdings.daily_profit_loss_rate AS "dailyProfitLossRate",
    snapshots.usd_krw_rate AS "usdKrwRate"
  FROM portfolio_snapshots AS snapshots
  INNER JOIN portfolio_holding_snapshots AS holdings
    ON holdings.snapshot_id = snapshots.id
  WHERE snapshots.owner_id = ?
    AND snapshots.account_key = ?
    AND holdings.symbol = ?
    AND holdings.market_country = ?
    AND holdings.currency = ?
  ORDER BY snapshots.captured_at DESC, snapshots.id DESC, holdings.position ASC
  LIMIT ?
`;

interface PortfolioHoldingHistoryRow extends PortfolioHoldingHistoryPoint {
  symbol: string;
  name: string;
  marketCountry: string;
  currency: string;
}

const initializationByBinding = new WeakMap<object, Promise<void>>();

export class HistoryStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HistoryStorageError";
  }
}

async function ensureHistorySchema(database: ReturnType<typeof getD1>): Promise<void> {
  const key = database as object;
  const existing = initializationByBinding.get(key);
  if (existing) return existing;

  const initialization = database
    .batch([
      database.prepare(CREATE_SNAPSHOTS_TABLE),
      database.prepare(CREATE_HOLDINGS_TABLE),
      database.prepare(CREATE_OWNER_IDEMPOTENCY_INDEX),
      database.prepare(CREATE_OWNER_ACCOUNT_CAPTURED_INDEX),
      database.prepare(CREATE_HOLDING_POSITION_INDEX),
      database.prepare("PRAGMA optimize"),
    ])
    .then(() => undefined)
    .catch((error: unknown) => {
      initializationByBinding.delete(key);
      throw new HistoryStorageError("Unable to initialize portfolio history storage.", {
        cause: error,
      });
    });

  initializationByBinding.set(key, initialization);
  return initialization;
}

function requireDecimal(value: unknown, field: string): string {
  if (!isDecimalString(value)) {
    throw new HistoryStorageError(`Invalid decimal supplied for ${field}.`);
  }
  return value;
}

function validateHolding(holding: PortfolioHolding, position: number): void {
  const prefix = `holdings[${position}]`;
  for (const [field, value] of [
    ["quantity", holding.quantity],
    ["lastPrice", holding.lastPrice],
    ["averagePurchasePrice", holding.averagePurchasePrice],
    ["marketValueNative", holding.marketValueNative],
    ["marketValueKrw", holding.marketValueKrw],
    ["profitLossNative", holding.profitLossNative],
    ["profitLossRate", holding.profitLossRate],
    ["dailyProfitLossNative", holding.dailyProfitLossNative],
    ["dailyProfitLossRate", holding.dailyProfitLossRate],
  ] as const) {
    requireDecimal(value, `${prefix}.${field}`);
  }
}

function normalizeSummary(row: PortfolioSnapshotSummary | null): PortfolioSnapshotSummary | null {
  if (!row) return null;
  if (
    typeof row.id !== "string" ||
    typeof row.capturedAt !== "string" ||
    !Number.isInteger(row.holdingCount) ||
    row.holdingCount < 0
  ) {
    throw new HistoryStorageError("Portfolio history contains an invalid snapshot record.");
  }
  requireDecimal(row.equityValueKrw, "snapshot.equityValueKrw");
  requireDecimal(row.profitLossKrw, "snapshot.profitLossKrw");
  requireDecimal(row.buyingPowerKrw, "snapshot.buyingPowerKrw");
  requireDecimal(row.totalTrackedValueKrw, "snapshot.totalTrackedValueKrw");
  requireDecimal(row.usdKrwRate, "snapshot.usdKrwRate");
  return row;
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

function requireHoldingHistorySelector(
  selector: PortfolioHoldingHistorySelector,
): void {
  if (
    !selector ||
    typeof selector.symbol !== "string" ||
    !/^[A-Za-z0-9.-]{1,32}$/.test(selector.symbol) ||
    typeof selector.marketCountry !== "string" ||
    !/^[A-Z][A-Z0-9_-]{0,29}$/.test(selector.marketCountry) ||
    typeof selector.currency !== "string" ||
    !/^[A-Z][A-Z0-9_-]{0,9}$/.test(selector.currency)
  ) {
    throw new HistoryStorageError("Holding-history selector is invalid.");
  }
}

function normalizeHoldingHistoryRow(
  row: PortfolioHoldingHistoryRow,
): PortfolioHoldingHistoryRow {
  const capturedAt = new Date(row.capturedAt);
  if (
    typeof row.snapshotId !== "string" ||
    row.snapshotId.length === 0 ||
    !Number.isFinite(capturedAt.getTime()) ||
    capturedAt.toISOString() !== row.capturedAt ||
    typeof row.symbol !== "string" ||
    !/^[A-Za-z0-9.-]{1,32}$/.test(row.symbol) ||
    typeof row.name !== "string" ||
    row.name.length === 0 ||
    row.name.length > 500 ||
    containsControlCharacter(row.name) ||
    typeof row.marketCountry !== "string" ||
    !/^[A-Z][A-Z0-9_-]{0,29}$/.test(row.marketCountry) ||
    typeof row.currency !== "string" ||
    !/^[A-Z][A-Z0-9_-]{0,9}$/.test(row.currency)
  ) {
    throw new HistoryStorageError("Portfolio history contains an invalid holding record.");
  }
  for (const [field, value] of [
    ["quantity", row.quantity],
    ["lastPrice", row.lastPrice],
    ["averagePurchasePrice", row.averagePurchasePrice],
    ["marketValueNative", row.marketValueNative],
    ["marketValueKrw", row.marketValueKrw],
    ["profitLossNative", row.profitLossNative],
    ["profitLossRate", row.profitLossRate],
    ["dailyProfitLossNative", row.dailyProfitLossNative],
    ["dailyProfitLossRate", row.dailyProfitLossRate],
    ["usdKrwRate", row.usdKrwRate],
  ] as const) {
    requireDecimal(value, `holdingHistory.${field}`);
  }
  return row;
}

export async function listPortfolioHoldingHistory(
  ownerId: string,
  accountKey: string,
  selector: PortfolioHoldingHistorySelector,
  limit: number,
): Promise<{
  holding: PortfolioHoldingHistoryIdentity | null;
  points: PortfolioHoldingHistoryPoint[];
}> {
  if (!ownerId || !accountKey) {
    throw new HistoryStorageError("Holding-history identity is incomplete.");
  }
  requireHoldingHistorySelector(selector);
  if (!Number.isInteger(limit) || limit < 1 || limit > 365) {
    throw new HistoryStorageError("Holding-history query limit is out of range.");
  }

  const database = getD1();
  await ensureHistorySchema(database);
  try {
    const result = await database
      .prepare(LIST_HOLDING_HISTORY)
      .bind(
        ownerId,
        accountKey,
        selector.symbol,
        selector.marketCountry,
        selector.currency,
        limit,
      )
      .all<PortfolioHoldingHistoryRow>();
    const rows = result.results.map(normalizeHoldingHistoryRow);
    const latest = rows[0];
    return {
      holding: latest
        ? {
            symbol: latest.symbol,
            name: latest.name,
            marketCountry: latest.marketCountry,
            currency: latest.currency,
          }
        : null,
      points: rows.map((row) => ({
        snapshotId: row.snapshotId,
        capturedAt: row.capturedAt,
        quantity: row.quantity,
        lastPrice: row.lastPrice,
        averagePurchasePrice: row.averagePurchasePrice,
        marketValueNative: row.marketValueNative,
        marketValueKrw: row.marketValueKrw,
        profitLossNative: row.profitLossNative,
        profitLossRate: row.profitLossRate,
        dailyProfitLossNative: row.dailyProfitLossNative,
        dailyProfitLossRate: row.dailyProfitLossRate,
        usdKrwRate: row.usdKrwRate,
      })),
    };
  } catch (error) {
    if (error instanceof HistoryStorageError) throw error;
    throw new HistoryStorageError("Unable to read holding history.", { cause: error });
  }
}

export async function listPortfolioSnapshots(
  ownerId: string,
  accountKey: string,
  limit: number,
): Promise<PortfolioSnapshotSummary[]> {
  const database = getD1();
  await ensureHistorySchema(database);
  try {
    const result = await database
      .prepare(LIST_SNAPSHOTS)
      .bind(ownerId, accountKey, limit)
      .all<PortfolioSnapshotSummary>();
    return result.results.map((row: PortfolioSnapshotSummary) =>
      normalizeSummary(row) as PortfolioSnapshotSummary,
    );
  } catch (error) {
    if (error instanceof HistoryStorageError) throw error;
    throw new HistoryStorageError("Unable to read portfolio history.", { cause: error });
  }
}

export async function capturePortfolioSnapshot(
  portfolio: PortfolioResponse,
  identity: { ownerId: string; accountKey: string; idempotencyKey: string },
  now: Date = new Date(),
): Promise<{ snapshot: PortfolioSnapshotSummary; created: boolean }> {
  if (portfolio.mode !== "live") {
    throw new HistoryStorageError("Only a live portfolio can be captured.");
  }
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    throw new HistoryStorageError("Unable to create a valid capture timestamp.");
  }

  const summary = portfolio.summary;
  const equityValueKrw = requireDecimal(summary.equityValueKrw, "summary.equityValueKrw");
  const purchaseValueKrw = requireDecimal(summary.purchaseValueKrw, "summary.purchaseValueKrw");
  const profitLossKrw = requireDecimal(summary.profitLossKrw, "summary.profitLossKrw");
  const profitLossRate = requireDecimal(summary.profitLossRate, "summary.profitLossRate");
  const dailyProfitLossKrw = requireDecimal(
    summary.dailyProfitLossKrw,
    "summary.dailyProfitLossKrw",
  );
  const dailyProfitLossRate = requireDecimal(
    summary.dailyProfitLossRate,
    "summary.dailyProfitLossRate",
  );
  const buyingPowerKrw = requireDecimal(summary.buyingPowerKrw, "summary.buyingPowerKrw");
  const buyingPowerUsd = requireDecimal(summary.buyingPowerUsd, "summary.buyingPowerUsd");
  const usdKrwRate = requireDecimal(summary.usdKrwRate, "summary.usdKrwRate");
  const totalTrackedValueKrw = calculateTotalTrackedValueKrw({
    equityValueKrw,
    buyingPowerKrw,
    buyingPowerUsd,
    usdKrwRate,
  });

  portfolio.holdings.forEach(validateHolding);
  const snapshotId = await createSnapshotId(
    identity.ownerId,
    identity.accountKey,
    identity.idempotencyKey,
  );
  const idStem = snapshotId.slice(3);
  const capturedAt = now.toISOString();
  const holdingsJson = JSON.stringify(
    portfolio.holdings.map((holding, position) => ({
      id: `ph_${idStem}_${position.toString(36)}`,
      symbol: holding.symbol,
      name: holding.name,
      marketCountry: holding.marketCountry,
      currency: holding.currency,
      quantity: holding.quantity,
      lastPrice: holding.lastPrice,
      averagePurchasePrice: holding.averagePurchasePrice,
      marketValueNative: holding.marketValueNative,
      marketValueKrw: holding.marketValueKrw,
      profitLossNative: holding.profitLossNative,
      profitLossRate: holding.profitLossRate,
      dailyProfitLossNative: holding.dailyProfitLossNative,
      dailyProfitLossRate: holding.dailyProfitLossRate,
    })),
  );
  if (new TextEncoder().encode(holdingsJson).byteLength > MAX_HOLDINGS_JSON_BYTES) {
    throw new HistoryStorageError("Portfolio holdings are too large for one atomic snapshot.");
  }
  const database = getD1();
  await ensureHistorySchema(database);

  try {
    const statements = [
      database.prepare(INSERT_SNAPSHOT).bind(
        snapshotId,
        capturedAt,
        identity.ownerId,
        identity.accountKey,
        identity.idempotencyKey,
        portfolio.mode,
        portfolio.account.maskedNumber,
        portfolio.account.type,
        equityValueKrw,
        purchaseValueKrw,
        profitLossKrw,
        profitLossRate,
        dailyProfitLossKrw,
        dailyProfitLossRate,
        buyingPowerKrw,
        buyingPowerUsd,
        usdKrwRate,
        totalTrackedValueKrw,
        portfolio.holdings.length,
      ),
      ...(portfolio.holdings.length > 0
        ? [database.prepare(INSERT_HOLDINGS).bind(snapshotId, holdingsJson)]
        : []),
    ];

    // D1 executes a batch as an ordered, transaction-equivalent unit. The
    // owner-scoped idempotency key and deterministic server ID make retries safe.
    const results = await database.batch(statements);
    const changes = Number(results[0]?.meta?.changes ?? 0);
    const stored = normalizeSummary(
      await database
        .prepare(SELECT_SNAPSHOT_BY_ID)
        .bind(identity.ownerId, identity.idempotencyKey)
        .first<PortfolioSnapshotSummary>(),
    );
    if (!stored) {
      throw new HistoryStorageError("Portfolio capture completed without a readable snapshot.");
    }
    return { snapshot: stored, created: changes > 0 };
  } catch (error) {
    if (error instanceof HistoryStorageError) throw error;
    throw new HistoryStorageError("Unable to save the portfolio snapshot.", { cause: error });
  }
}

export async function findPortfolioSnapshot(
  ownerId: string,
  idempotencyKey: string,
): Promise<PortfolioSnapshotSummary | null> {
  const database = getD1();
  await ensureHistorySchema(database);
  try {
    return normalizeSummary(
      await database
        .prepare(SELECT_SNAPSHOT_BY_ID)
        .bind(ownerId, idempotencyKey)
        .first<PortfolioSnapshotSummary>(),
    );
  } catch (error) {
    if (error instanceof HistoryStorageError) throw error;
    throw new HistoryStorageError("Unable to read an idempotent capture.", { cause: error });
  }
}
