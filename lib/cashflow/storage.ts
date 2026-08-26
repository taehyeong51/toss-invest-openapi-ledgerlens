import { getD1 } from "../../db";
import { isDecimalString } from "../portfolio/decimal";
import type { CashFlowRecord, NewManualCashFlow } from "./types";
import {
  MAX_MANUAL_CASH_FLOW_AMOUNT_LENGTH,
  parseManualCashFlow,
} from "./validation";

const CREATE_CASH_FLOWS_TABLE = `
  CREATE TABLE IF NOT EXISTS cash_flows (
    id TEXT PRIMARY KEY NOT NULL,
    created_at TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    account_key TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('contribution', 'withdrawal')),
    amount_krw TEXT NOT NULL,
    note TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source = 'manual')
  )
`;

const DROP_LEGACY_OWNER_IDEMPOTENCY_INDEX = `
  DROP INDEX IF EXISTS idx_cash_flows_owner_idempotency
`;

const CREATE_OWNER_ACCOUNT_IDEMPOTENCY_INDEX = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_flows_owner_account_idempotency
  ON cash_flows (owner_id, account_key, idempotency_key)
`;

const CREATE_OWNER_ACCOUNT_OCCURRED_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_cash_flows_owner_account_occurred
  ON cash_flows (owner_id, account_key, occurred_at)
`;

const INSERT_CASH_FLOW = `
  INSERT OR IGNORE INTO cash_flows (
    id, created_at, occurred_at, owner_id, account_key, idempotency_key,
    kind, amount_krw, note, source
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual')
`;

const SELECT_BY_IDEMPOTENCY = `
  SELECT
    id,
    occurred_at AS "occurredAt",
    created_at AS "createdAt",
    kind,
    amount_krw AS "amountKrw",
    note
  FROM cash_flows
  WHERE owner_id = ? AND account_key = ? AND idempotency_key = ?
  LIMIT 1
`;

const LIST_CASH_FLOWS = `
  SELECT
    id,
    occurred_at AS "occurredAt",
    created_at AS "createdAt",
    kind,
    amount_krw AS "amountKrw",
    note
  FROM cash_flows
  WHERE owner_id = ? AND account_key = ?
  ORDER BY occurred_at DESC, created_at DESC, id DESC
  LIMIT ?
`;

const LIST_CASH_FLOWS_FOR_PERIOD = `
  SELECT
    id,
    occurred_at AS "occurredAt",
    created_at AS "createdAt",
    kind,
    amount_krw AS "amountKrw",
    note
  FROM cash_flows
  WHERE owner_id = ? AND account_key = ?
    AND occurred_at > ? AND occurred_at <= ?
  ORDER BY occurred_at ASC, created_at ASC, id ASC
`;

const CANONICAL_POSITIVE_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/;
const initializationByBinding = new WeakMap<object, Promise<void>>();

export class CashFlowStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CashFlowStorageError";
  }
}

export class CashFlowIdempotencyConflictError extends CashFlowStorageError {
  constructor() {
    super("Idempotency-Key was already used for a different cash-flow payload.");
    this.name = "CashFlowIdempotencyConflictError";
  }
}

async function ensureCashFlowSchema(database: ReturnType<typeof getD1>): Promise<void> {
  const key = database as object;
  const existing = initializationByBinding.get(key);
  if (existing) return existing;

  const initialization = database
    .batch([
      database.prepare(CREATE_CASH_FLOWS_TABLE),
      database.prepare(DROP_LEGACY_OWNER_IDEMPOTENCY_INDEX),
      database.prepare(CREATE_OWNER_ACCOUNT_IDEMPOTENCY_INDEX),
      database.prepare(CREATE_OWNER_ACCOUNT_OCCURRED_INDEX),
      database.prepare("PRAGMA optimize"),
    ])
    .then(() => undefined)
    .catch((error: unknown) => {
      initializationByBinding.delete(key);
      throw new CashFlowStorageError("Unable to initialize cash-flow storage.", {
        cause: error,
      });
    });

  initializationByBinding.set(key, initialization);
  return initialization;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
}

function normalizeCashFlow(row: CashFlowRecord | null): CashFlowRecord | null {
  if (row === null) return null;
  if (
    typeof row.id !== "string" ||
    !isCanonicalTimestamp(row.occurredAt) ||
    !isCanonicalTimestamp(row.createdAt) ||
    (row.kind !== "contribution" && row.kind !== "withdrawal") ||
    !isDecimalString(row.amountKrw) ||
    row.amountKrw.length > MAX_MANUAL_CASH_FLOW_AMOUNT_LENGTH ||
    !CANONICAL_POSITIVE_DECIMAL.test(row.amountKrw) ||
    row.amountKrw === "0" ||
    typeof row.note !== "string" ||
    row.note.length > 200
  ) {
    throw new CashFlowStorageError("Cash-flow storage contains an invalid record.");
  }
  return row;
}

export function cashFlowPayloadMatches(
  stored: CashFlowRecord,
  input: NewManualCashFlow,
): boolean {
  return (
    stored.kind === input.kind &&
    stored.amountKrw === input.amountKrw &&
    stored.occurredAt === input.occurredAt &&
    stored.note === input.note
  );
}

async function createCashFlowId(
  ownerId: string,
  accountKey: string,
  idempotencyKey: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    `${ownerId}\u0000${accountKey}\u0000${idempotencyKey}`,
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `cf_${hex.slice(0, 40)}`;
}

function requireLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 365) {
    throw new CashFlowStorageError("Cash-flow query limit is out of range.");
  }
}

export async function listCashFlows(
  ownerId: string,
  accountKey: string,
  limit: number,
): Promise<CashFlowRecord[]> {
  requireLimit(limit);
  const database = getD1();
  await ensureCashFlowSchema(database);
  try {
    const result = await database
      .prepare(LIST_CASH_FLOWS)
      .bind(ownerId, accountKey, limit)
      .all<CashFlowRecord>();
    return result.results.map(
      (row: CashFlowRecord) => normalizeCashFlow(row) as CashFlowRecord,
    );
  } catch (error) {
    if (error instanceof CashFlowStorageError) throw error;
    throw new CashFlowStorageError("Unable to read cash flows.", { cause: error });
  }
}

export async function listCashFlowsForPeriod(
  ownerId: string,
  accountKey: string,
  startedAtExclusive: string,
  endedAtInclusive: string,
): Promise<CashFlowRecord[]> {
  if (!isCanonicalTimestamp(startedAtExclusive) || !isCanonicalTimestamp(endedAtInclusive)) {
    throw new CashFlowStorageError("Analytics period contains an invalid timestamp.");
  }
  const database = getD1();
  await ensureCashFlowSchema(database);
  try {
    const result = await database
      .prepare(LIST_CASH_FLOWS_FOR_PERIOD)
      .bind(ownerId, accountKey, startedAtExclusive, endedAtInclusive)
      .all<CashFlowRecord>();
    return result.results.map(
      (row: CashFlowRecord) => normalizeCashFlow(row) as CashFlowRecord,
    );
  } catch (error) {
    if (error instanceof CashFlowStorageError) throw error;
    throw new CashFlowStorageError("Unable to read cash flows for analytics.", {
      cause: error,
    });
  }
}

export async function findCashFlow(
  ownerId: string,
  accountKey: string,
  idempotencyKey: string,
): Promise<CashFlowRecord | null> {
  const database = getD1();
  await ensureCashFlowSchema(database);
  try {
    return normalizeCashFlow(
      await database
        .prepare(SELECT_BY_IDEMPOTENCY)
        .bind(ownerId, accountKey, idempotencyKey)
        .first<CashFlowRecord>(),
    );
  } catch (error) {
    if (error instanceof CashFlowStorageError) throw error;
    throw new CashFlowStorageError("Unable to read an idempotent cash flow.", {
      cause: error,
    });
  }
}

export async function recordCashFlow(
  input: NewManualCashFlow,
  identity: { ownerId: string; accountKey: string; idempotencyKey: string },
  now: Date = new Date(),
): Promise<{ cashFlow: CashFlowRecord; created: boolean }> {
  const normalized = parseManualCashFlow(input, now);
  if (!identity.ownerId || !identity.accountKey || !identity.idempotencyKey) {
    throw new CashFlowStorageError("Cash-flow identity is incomplete.");
  }
  const createdAt = now.toISOString();
  const id = await createCashFlowId(
    identity.ownerId,
    identity.accountKey,
    identity.idempotencyKey,
  );
  const database = getD1();
  await ensureCashFlowSchema(database);

  try {
    const result = await database
      .prepare(INSERT_CASH_FLOW)
      .bind(
        id,
        createdAt,
        normalized.occurredAt,
        identity.ownerId,
        identity.accountKey,
        identity.idempotencyKey,
        normalized.kind,
        normalized.amountKrw,
        normalized.note,
      )
      .run();
    const stored = normalizeCashFlow(
      await database
        .prepare(SELECT_BY_IDEMPOTENCY)
        .bind(identity.ownerId, identity.accountKey, identity.idempotencyKey)
        .first<CashFlowRecord>(),
    );
    if (!stored) {
      throw new CashFlowStorageError("Cash-flow write completed without a readable record.");
    }
    if (!cashFlowPayloadMatches(stored, normalized)) {
      throw new CashFlowIdempotencyConflictError();
    }
    return { cashFlow: stored, created: Number(result.meta.changes ?? 0) > 0 };
  } catch (error) {
    if (error instanceof CashFlowStorageError) throw error;
    throw new CashFlowStorageError("Unable to save the cash flow.", { cause: error });
  }
}
