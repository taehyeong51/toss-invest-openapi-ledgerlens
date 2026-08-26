import { getD1 } from "../../db";
import type { CapitalPlanInput, StoredCapitalPlan } from "./types";
import { parseCapitalPlan } from "./validation";

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS capital_plans (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL,
    account_key TEXT NOT NULL,
    start_asset_krw TEXT,
    target_asset_krw TEXT NOT NULL,
    start_date TEXT NOT NULL,
    target_date TEXT NOT NULL,
    monthly_contribution_krw TEXT NOT NULL,
    target_kr_weight TEXT NOT NULL,
    target_us_weight TEXT NOT NULL,
    target_cash_weight TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`;
const CREATE_INDEX = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_capital_plans_owner_account
  ON capital_plans (owner_id, account_key)
`;
const SELECT_PLAN = `
  SELECT id, owner_id AS "ownerId", account_key AS "accountKey",
    start_asset_krw AS "startAssetKrw", target_asset_krw AS "targetAssetKrw",
    start_date AS "startDate",
    target_date AS "targetDate", monthly_contribution_krw AS "monthlyContributionKrw",
    target_kr_weight AS "targetKrWeight", target_us_weight AS "targetUsWeight",
    target_cash_weight AS "targetCashWeight", revision,
    created_at AS "createdAt", updated_at AS "updatedAt"
  FROM capital_plans WHERE owner_id = ? AND account_key = ? LIMIT 1
`;
const INSERT_PLAN = `
  INSERT OR IGNORE INTO capital_plans (
    id, owner_id, account_key, start_asset_krw, target_asset_krw, start_date, target_date,
    monthly_contribution_krw, target_kr_weight, target_us_weight,
    target_cash_weight, revision, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
`;
const UPDATE_PLAN = `
  UPDATE capital_plans SET start_asset_krw = ?, target_asset_krw = ?, start_date = ?, target_date = ?,
    monthly_contribution_krw = ?, target_kr_weight = ?, target_us_weight = ?,
    target_cash_weight = ?, revision = ?, updated_at = ?
  WHERE owner_id = ? AND account_key = ? AND revision = ?
`;

interface PlanRow {
  id: unknown;
  ownerId: unknown;
  accountKey: unknown;
  startAssetKrw: unknown;
  targetAssetKrw: unknown;
  startDate: unknown;
  targetDate: unknown;
  monthlyContributionKrw: unknown;
  targetKrWeight: unknown;
  targetUsWeight: unknown;
  targetCashWeight: unknown;
  revision: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

const initializationByBinding = new WeakMap<object, Promise<void>>();

export class CapitalPlanStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CapitalPlanStorageError";
  }
}

export class CapitalPlanRevisionConflictError extends Error {
  constructor() {
    super("Capital plan revision is stale.");
    this.name = "CapitalPlanRevisionConflictError";
  }
}

async function ensureSchema(database: ReturnType<typeof getD1>): Promise<void> {
  const key = database as object;
  const existing = initializationByBinding.get(key);
  if (existing) return existing;
  const initialization = (async () => {
    await database.batch([
      database.prepare(CREATE_TABLE),
      database.prepare(CREATE_INDEX),
      database.prepare("PRAGMA optimize"),
    ]);
    const columns = await database.prepare("PRAGMA table_info(capital_plans)").all<{ name: string }>();
    if (!columns.results.some((column) => column.name === "start_asset_krw")) {
      await database.prepare("ALTER TABLE capital_plans ADD COLUMN start_asset_krw TEXT").run();
    }
  })().catch((error: unknown) => {
      initializationByBinding.delete(key);
      throw new CapitalPlanStorageError("Unable to initialize capital-plan storage.", { cause: error });
    });
  initializationByBinding.set(key, initialization);
  return initialization;
}

function validIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function normalizePlan(row: PlanRow | null): StoredCapitalPlan | null {
  if (!row) return null;
  if (
    typeof row.id !== "string" ||
    typeof row.ownerId !== "string" ||
    typeof row.accountKey !== "string" ||
    !Number.isSafeInteger(row.revision) ||
    Number(row.revision) < 1 ||
    !validIso(row.createdAt) ||
    !validIso(row.updatedAt)
  ) {
    throw new CapitalPlanStorageError("Capital-plan storage contains an invalid record.");
  }
  const hasConfirmedStartAsset = typeof row.startAssetKrw === "string" && row.startAssetKrw !== "0";
  const input = parseCapitalPlan({
    startAssetKrw: hasConfirmedStartAsset ? row.startAssetKrw : "0",
    targetAssetKrw: row.targetAssetKrw,
    startDate: row.startDate,
    targetDate: row.targetDate,
    monthlyContributionKrw: row.monthlyContributionKrw,
    targetKrWeight: row.targetKrWeight,
    targetUsWeight: row.targetUsWeight,
    targetCashWeight: row.targetCashWeight,
    expectedRevision: Number(row.revision),
  }, { allowMissingStartAsset: true });
  return {
    id: row.id,
    ownerId: row.ownerId,
    accountKey: row.accountKey,
    startAssetKrw: hasConfirmedStartAsset ? input.startAssetKrw : null,
    targetAssetKrw: input.targetAssetKrw,
    startDate: input.startDate,
    targetDate: input.targetDate,
    monthlyContributionKrw: input.monthlyContributionKrw,
    targetKrWeight: input.targetKrWeight,
    targetUsWeight: input.targetUsWeight,
    targetCashWeight: input.targetCashWeight,
    revision: Number(row.revision),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function planId(ownerId: string, accountKey: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${ownerId}\u0000${accountKey}`),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `cp_${hex.slice(0, 40)}`;
}

async function readPlan(
  database: ReturnType<typeof getD1>,
  ownerId: string,
  accountKey: string,
): Promise<StoredCapitalPlan | null> {
  return normalizePlan(
    await database.prepare(SELECT_PLAN).bind(ownerId, accountKey).first<PlanRow>(),
  );
}

export async function getCapitalPlan(
  ownerId: string,
  accountKey: string,
): Promise<StoredCapitalPlan | null> {
  const database = getD1();
  await ensureSchema(database);
  try {
    return await readPlan(database, ownerId, accountKey);
  } catch (error) {
    if (error instanceof CapitalPlanStorageError) throw error;
    throw new CapitalPlanStorageError("Unable to read the capital plan.", { cause: error });
  }
}

function samePlan(plan: StoredCapitalPlan, input: CapitalPlanInput): boolean {
  return (
    plan.startAssetKrw === input.startAssetKrw &&
    plan.targetAssetKrw === input.targetAssetKrw &&
    plan.startDate === input.startDate &&
    plan.targetDate === input.targetDate &&
    plan.monthlyContributionKrw === input.monthlyContributionKrw &&
    plan.targetKrWeight === input.targetKrWeight &&
    plan.targetUsWeight === input.targetUsWeight &&
    plan.targetCashWeight === input.targetCashWeight
  );
}

export async function saveCapitalPlan(input: {
  ownerId: string;
  accountKey: string;
  plan: CapitalPlanInput;
  now?: Date;
}): Promise<{ plan: StoredCapitalPlan; updated: boolean }> {
  const normalized = parseCapitalPlan(input.plan);
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new CapitalPlanStorageError("Invalid plan timestamp.");
  const nowIso = now.toISOString();
  const database = getD1();
  await ensureSchema(database);
  try {
    const current = await readPlan(database, input.ownerId, input.accountKey);
    if (!current) {
      if (normalized.expectedRevision !== 0) throw new CapitalPlanRevisionConflictError();
      const result = await database.prepare(INSERT_PLAN).bind(
        await planId(input.ownerId, input.accountKey),
        input.ownerId,
        input.accountKey,
        normalized.startAssetKrw,
        normalized.targetAssetKrw,
        normalized.startDate,
        normalized.targetDate,
        normalized.monthlyContributionKrw,
        normalized.targetKrWeight,
        normalized.targetUsWeight,
        normalized.targetCashWeight,
        nowIso,
        nowIso,
      ).run();
      const stored = await readPlan(database, input.ownerId, input.accountKey);
      if (!stored) throw new CapitalPlanStorageError("Created plan is not readable.");
      if (Number(result.meta?.changes ?? 0) === 0 && !samePlan(stored, normalized)) {
        throw new CapitalPlanRevisionConflictError();
      }
      return { plan: stored, updated: Number(result.meta?.changes ?? 0) > 0 };
    }
    if (normalized.expectedRevision !== current.revision) {
      if (samePlan(current, normalized)) return { plan: current, updated: false };
      throw new CapitalPlanRevisionConflictError();
    }
    if (samePlan(current, normalized)) return { plan: current, updated: false };
    const nextRevision = current.revision + 1;
    const result = await database.prepare(UPDATE_PLAN).bind(
      normalized.startAssetKrw,
      normalized.targetAssetKrw,
      normalized.startDate,
      normalized.targetDate,
      normalized.monthlyContributionKrw,
      normalized.targetKrWeight,
      normalized.targetUsWeight,
      normalized.targetCashWeight,
      nextRevision,
      nowIso,
      input.ownerId,
      input.accountKey,
      current.revision,
    ).run();
    const stored = await readPlan(database, input.ownerId, input.accountKey);
    if (!stored) throw new CapitalPlanStorageError("Updated plan is not readable.");
    if (Number(result.meta?.changes ?? 0) !== 1) throw new CapitalPlanRevisionConflictError();
    return { plan: stored, updated: true };
  } catch (error) {
    if (error instanceof CapitalPlanStorageError || error instanceof CapitalPlanRevisionConflictError) {
      throw error;
    }
    throw new CapitalPlanStorageError("Unable to save the capital plan.", { cause: error });
  }
}
