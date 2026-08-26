import { getD1 } from "../../db";
import { decimalSum, isDecimalString } from "../portfolio/decimal";
import type {
  ExternalAssetInput,
  ExternalAssetRecord,
  ExternalAssetSummary,
  ExternalAssetsPayload,
  ExternalAssetUpdateInput,
} from "./types";
import {
  ExternalAssetValidationError,
  parseExternalAssetInput,
  parseStoredExternalAssetInput,
  parseExternalAssetUpdate,
} from "./validation";

const CREATE_EXTERNAL_ASSETS_TABLE = `
  CREATE TABLE IF NOT EXISTS external_assets (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL,
    account_key TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (
      kind IN ('cash', 'deposit', 'savings', 'pension', 'insurance', 'property', 'crypto', 'other')
    ),
    name TEXT NOT NULL,
    institution TEXT NOT NULL,
    currency TEXT NOT NULL,
    balance TEXT NOT NULL,
    value_krw TEXT NOT NULL,
    valued_at TEXT NOT NULL,
    maturity_date TEXT,
    annual_rate_percent TEXT,
    note TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source = 'manual'),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`;

const CREATE_EXTERNAL_ASSET_SNAPSHOTS_TABLE = `
  CREATE TABLE IF NOT EXISTS external_asset_snapshots (
    id TEXT PRIMARY KEY NOT NULL,
    asset_id TEXT NOT NULL REFERENCES external_assets(id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL,
    account_key TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('created', 'updated')),
    kind TEXT NOT NULL CHECK (
      kind IN ('cash', 'deposit', 'savings', 'pension', 'insurance', 'property', 'crypto', 'other')
    ),
    name TEXT NOT NULL,
    institution TEXT NOT NULL,
    currency TEXT NOT NULL,
    balance TEXT NOT NULL,
    value_krw TEXT NOT NULL,
    valued_at TEXT NOT NULL,
    maturity_date TEXT,
    annual_rate_percent TEXT,
    note TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source = 'manual'),
    revision INTEGER NOT NULL CHECK (revision >= 1)
  )
`;

const CREATE_EXTERNAL_ASSET_IDEMPOTENCY_INDEX = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_external_assets_owner_account_idempotency
  ON external_assets (owner_id, account_key, idempotency_key)
`;

const CREATE_EXTERNAL_ASSET_UPDATED_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_external_assets_owner_account_updated
  ON external_assets (owner_id, account_key, updated_at)
`;

const CREATE_EXTERNAL_ASSET_SNAPSHOT_REVISION_INDEX = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_external_asset_snapshots_asset_revision
  ON external_asset_snapshots (asset_id, revision)
`;

const CREATE_EXTERNAL_ASSET_SNAPSHOT_CAPTURED_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_external_asset_snapshots_owner_account_captured
  ON external_asset_snapshots (owner_id, account_key, captured_at)
`;

const INSERT_EXTERNAL_ASSET = `
  INSERT OR IGNORE INTO external_assets (
    id, owner_id, account_key, idempotency_key, kind, name, institution,
    currency, balance, value_krw, valued_at, maturity_date,
    annual_rate_percent, note, source, revision, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', 1, ?, ?)
`;

const INSERT_CREATED_SNAPSHOT = `
  INSERT OR IGNORE INTO external_asset_snapshots (
    id, asset_id, owner_id, account_key, captured_at, reason, kind, name,
    institution, currency, balance, value_krw, valued_at, maturity_date,
    annual_rate_percent, note, source, revision
  )
  SELECT ?, id, owner_id, account_key, ?, 'created', kind, name, institution,
    currency, balance, value_krw, valued_at, maturity_date,
    annual_rate_percent, note, source, revision
  FROM external_assets
  WHERE id = ? AND owner_id = ? AND account_key = ? AND revision = 1
`;

const UPDATE_EXTERNAL_ASSET = `
  UPDATE external_assets
  SET kind = ?, name = ?, institution = ?, currency = ?, balance = ?,
    value_krw = ?, valued_at = ?, maturity_date = ?, annual_rate_percent = ?,
    note = ?, revision = revision + 1, updated_at = ?
  WHERE id = ? AND owner_id = ? AND account_key = ? AND revision = ?
`;

const INSERT_UPDATED_SNAPSHOT = `
  INSERT OR IGNORE INTO external_asset_snapshots (
    id, asset_id, owner_id, account_key, captured_at, reason, kind, name,
    institution, currency, balance, value_krw, valued_at, maturity_date,
    annual_rate_percent, note, source, revision
  )
  SELECT ?, id, owner_id, account_key, ?, 'updated', kind, name, institution,
    currency, balance, value_krw, valued_at, maturity_date,
    annual_rate_percent, note, source, revision
  FROM external_assets
  WHERE id = ? AND owner_id = ? AND account_key = ? AND revision = ?
`;

const SELECT_EXTERNAL_ASSET_COLUMNS = `
  id,
  kind,
  name,
  institution,
  currency,
  balance,
  value_krw AS "valueKrw",
  valued_at AS "valuedAt",
  maturity_date AS "maturityDate",
  annual_rate_percent AS "annualRatePercent",
  note,
  source,
  revision,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const SELECT_EXTERNAL_ASSET_BY_IDEMPOTENCY = `
  SELECT ${SELECT_EXTERNAL_ASSET_COLUMNS}
  FROM external_assets
  WHERE owner_id = ? AND account_key = ? AND idempotency_key = ?
  LIMIT 1
`;

const SELECT_EXTERNAL_ASSET_BY_ID = `
  SELECT ${SELECT_EXTERNAL_ASSET_COLUMNS}
  FROM external_assets
  WHERE id = ? AND owner_id = ? AND account_key = ?
  LIMIT 1
`;

const LIST_EXTERNAL_ASSETS = `
  SELECT ${SELECT_EXTERNAL_ASSET_COLUMNS}
  FROM external_assets
  WHERE owner_id = ? AND account_key = ?
  ORDER BY updated_at DESC, id DESC
  LIMIT ?
`;

const SUMMARIZE_EXTERNAL_ASSETS = `
  SELECT
    value_krw AS "valueKrw",
    updated_at AS "updatedAt"
  FROM external_assets
  WHERE owner_id = ? AND account_key = ?
`;

const LIST_EXTERNAL_ASSET_SNAPSHOTS = `
  SELECT
    asset_id AS "assetId",
    captured_at AS "capturedAt",
    value_krw AS "valueKrw",
    valued_at AS "valuedAt",
    revision
  FROM external_asset_snapshots
  WHERE owner_id = ? AND account_key = ?
  ORDER BY captured_at DESC, revision DESC, valued_at DESC, asset_id DESC
  LIMIT ?
`;

const initializationByBinding = new WeakMap<object, Promise<void>>();
const CANONICAL_NONNEGATIVE_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/;
const KST_OFFSET_MS = 9 * 60 * 60 * 1_000;

interface ExternalAssetSummaryRow {
  valueKrw: string;
  updatedAt: string;
}

/** A valuation revision used to reconstruct the registered-asset timeline. */
export interface ExternalAssetSnapshotRecord {
  assetId: string;
  capturedAt: string;
  valueKrw: string;
  valuedAt: string;
  revision: number;
}

export class ExternalAssetStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExternalAssetStorageError";
  }
}

export class ExternalAssetIdempotencyConflictError extends ExternalAssetStorageError {
  constructor() {
    super("Idempotency-Key was already used for a different external asset.");
    this.name = "ExternalAssetIdempotencyConflictError";
  }
}

export class ExternalAssetRevisionConflictError extends ExternalAssetStorageError {
  readonly actualRevision: number | null;

  constructor(actualRevision: number | null) {
    super("The external asset changed after it was read.");
    this.name = "ExternalAssetRevisionConflictError";
    this.actualRevision = actualRevision;
  }
}

export class ExternalAssetNotFoundError extends ExternalAssetStorageError {
  constructor() {
    super("The external asset does not exist in this account partition.");
    this.name = "ExternalAssetNotFoundError";
  }
}

async function ensureExternalAssetSchema(
  database: ReturnType<typeof getD1>,
): Promise<void> {
  const key = database as object;
  const existing = initializationByBinding.get(key);
  if (existing) return existing;

  const initialization = database
    .batch([
      database.prepare(CREATE_EXTERNAL_ASSETS_TABLE),
      database.prepare(CREATE_EXTERNAL_ASSET_SNAPSHOTS_TABLE),
      database.prepare(CREATE_EXTERNAL_ASSET_IDEMPOTENCY_INDEX),
      database.prepare(CREATE_EXTERNAL_ASSET_UPDATED_INDEX),
      database.prepare(CREATE_EXTERNAL_ASSET_SNAPSHOT_REVISION_INDEX),
      database.prepare(CREATE_EXTERNAL_ASSET_SNAPSHOT_CAPTURED_INDEX),
      database.prepare("PRAGMA optimize"),
    ])
    .then(() => undefined)
    .catch((error: unknown) => {
      initializationByBinding.delete(key);
      throw new ExternalAssetStorageError(
        "Unable to initialize external-asset storage.",
        { cause: error },
      );
    });

  initializationByBinding.set(key, initialization);
  return initialization;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
}

function normalizeExternalAsset(
  row: ExternalAssetRecord | null,
): ExternalAssetRecord | null {
  if (row === null) return null;
  if (
    typeof row.id !== "string" ||
    !/^ea_[a-f0-9]{40}$/.test(row.id) ||
    row.source !== "manual" ||
    !Number.isInteger(row.revision) ||
    row.revision < 1 ||
    !isCanonicalTimestamp(row.createdAt) ||
    !isCanonicalTimestamp(row.updatedAt) ||
    row.updatedAt < row.createdAt ||
    typeof row.name !== "string" ||
    typeof row.institution !== "string" ||
    typeof row.currency !== "string" ||
    typeof row.balance !== "string" ||
    typeof row.valueKrw !== "string" ||
    typeof row.valuedAt !== "string" ||
    !(
      row.maturityDate === null ||
      typeof row.maturityDate === "string"
    ) ||
    !(
      row.annualRatePercent === null ||
      typeof row.annualRatePercent === "string"
    ) ||
    typeof row.note !== "string"
  ) {
    throw new ExternalAssetStorageError(
      "External-asset storage contains an invalid record.",
    );
  }

  try {
    const normalized = parseStoredExternalAssetInput({
      kind: row.kind,
      name: row.name,
      institution: row.institution,
      currency: row.currency,
      balance: row.balance,
      valueKrw: row.valueKrw,
      valuedAt: row.valuedAt,
      maturityDate: row.maturityDate,
      annualRatePercent: row.annualRatePercent,
      note: row.note,
    });
    if (
      normalized.kind !== row.kind ||
      normalized.name !== row.name ||
      normalized.institution !== row.institution ||
      normalized.currency !== row.currency ||
      normalized.balance !== row.balance ||
      normalized.valueKrw !== row.valueKrw ||
      normalized.valuedAt !== row.valuedAt ||
      normalized.maturityDate !== row.maturityDate ||
      normalized.annualRatePercent !== row.annualRatePercent ||
      normalized.note !== row.note
    ) {
      throw new ExternalAssetStorageError(
        "External-asset storage contains a non-canonical record.",
      );
    }
  } catch (error) {
    if (error instanceof ExternalAssetStorageError) throw error;
    if (error instanceof ExternalAssetValidationError) {
      throw new ExternalAssetStorageError(
        "External-asset storage contains an invalid record.",
        { cause: error },
      );
    }
    throw error;
  }
  return row;
}

function requireIdentity(identity: {
  ownerId: string;
  accountKey: string;
  idempotencyKey?: string;
}): void {
  if (!identity.ownerId || !identity.accountKey || identity.idempotencyKey === "") {
    throw new ExternalAssetStorageError("External-asset identity is incomplete.");
  }
}

function requireLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ExternalAssetStorageError("External-asset query limit is out of range.");
  }
}

function requireBulkLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 251) {
    throw new ExternalAssetStorageError(
      "External-asset bulk query limit is out of range.",
    );
  }
}

function requireSnapshotLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_001) {
    throw new ExternalAssetStorageError(
      "External-asset snapshot query limit is out of range.",
    );
  }
}

function requireValuationNotInFuture(valuedAt: string, now: Date): void {
  const todayInKorea = new Date(now.getTime() + KST_OFFSET_MS)
    .toISOString()
    .slice(0, 10);
  if (valuedAt > todayInKorea) {
    throw new ExternalAssetValidationError(
      "future-valued-at",
      "valuedAt은 오늘 이후 날짜일 수 없습니다.",
    );
  }
}

function isCanonicalDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function normalizeExternalAssetSnapshot(
  row: ExternalAssetSnapshotRecord,
): ExternalAssetSnapshotRecord {
  if (
    typeof row.assetId !== "string" ||
    !/^ea_[a-f0-9]{40}$/.test(row.assetId) ||
    !isCanonicalTimestamp(row.capturedAt) ||
    typeof row.valueKrw !== "string" ||
    row.valueKrw.length > 40 ||
    !isDecimalString(row.valueKrw) ||
    !CANONICAL_NONNEGATIVE_DECIMAL.test(row.valueKrw) ||
    !isCanonicalDate(row.valuedAt) ||
    !Number.isInteger(row.revision) ||
    row.revision < 1
  ) {
    throw new ExternalAssetStorageError(
      "External-asset storage contains an invalid snapshot record.",
    );
  }
  return row;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function createExternalAssetId(
  ownerId: string,
  accountKey: string,
  idempotencyKey: string,
): Promise<string> {
  return `ea_${(
    await sha256(`${ownerId}\u0000${accountKey}\u0000${idempotencyKey}`)
  ).slice(0, 40)}`;
}

function createSnapshotId(assetId: string, revision: number): string {
  return `eas_${assetId.slice(3)}_${revision}`;
}

export function externalAssetPayloadMatches(
  stored: ExternalAssetRecord,
  input: ExternalAssetInput,
): boolean {
  return (
    stored.kind === input.kind &&
    stored.name === input.name &&
    stored.institution === input.institution &&
    stored.currency === input.currency &&
    stored.balance === input.balance &&
    stored.valueKrw === input.valueKrw &&
    stored.valuedAt === input.valuedAt &&
    stored.maturityDate === input.maturityDate &&
    stored.annualRatePercent === input.annualRatePercent &&
    stored.note === input.note
  );
}

export function createExternalAssetsPayload(
  status: "demo" | "ready",
  assets: ExternalAssetRecord[],
  summary?: ExternalAssetSummary,
): ExternalAssetsPayload {
  const lastUpdatedAt = summary?.lastUpdatedAt ?? assets.reduce<string | null>(
    (latest, asset) =>
      latest === null || asset.updatedAt > latest ? asset.updatedAt : latest,
    null,
  );
  return {
    status,
    assets,
    count: summary?.count ?? assets.length,
    totalValueKrw: summary?.totalValueKrw ?? decimalSum(assets.map((asset) => asset.valueKrw)),
    lastUpdatedAt,
  };
}

export async function summarizeExternalAssets(
  ownerId: string,
  accountKey: string,
): Promise<ExternalAssetSummary> {
  requireIdentity({ ownerId, accountKey });
  const database = getD1();
  await ensureExternalAssetSchema(database);
  try {
    const result = await database
      .prepare(SUMMARIZE_EXTERNAL_ASSETS)
      .bind(ownerId, accountKey)
      .all<ExternalAssetSummaryRow>();
    for (const row of result.results) {
      if (
        typeof row.valueKrw !== "string" ||
        row.valueKrw.length > 40 ||
        !isDecimalString(row.valueKrw) ||
        !CANONICAL_NONNEGATIVE_DECIMAL.test(row.valueKrw) ||
        !isCanonicalTimestamp(row.updatedAt)
      ) {
        throw new ExternalAssetStorageError(
          "External-asset storage contains an invalid summary record.",
        );
      }
    }
    return {
      count: result.results.length,
      totalValueKrw: decimalSum(result.results.map((row) => row.valueKrw)),
      lastUpdatedAt: result.results.reduce<string | null>(
        (latest, row) => latest === null || row.updatedAt > latest ? row.updatedAt : latest,
        null,
      ),
    };
  } catch (error) {
    if (error instanceof ExternalAssetStorageError) throw error;
    throw new ExternalAssetStorageError("Unable to summarize external assets.", {
      cause: error,
    });
  }
}

export async function listExternalAssets(
  ownerId: string,
  accountKey: string,
  limit: number,
): Promise<ExternalAssetRecord[]> {
  requireLimit(limit);
  requireIdentity({ ownerId, accountKey });
  const database = getD1();
  await ensureExternalAssetSchema(database);
  try {
    const result = await database
      .prepare(LIST_EXTERNAL_ASSETS)
      .bind(ownerId, accountKey, limit)
      .all<ExternalAssetRecord>();
    return result.results.map(
      (row: ExternalAssetRecord) =>
        normalizeExternalAsset(row) as ExternalAssetRecord,
    );
  } catch (error) {
    if (error instanceof ExternalAssetStorageError) throw error;
    throw new ExternalAssetStorageError("Unable to read external assets.", {
      cause: error,
    });
  }
}

/**
 * Reads a bounded complete slice for CSV export. Callers request one row beyond
 * their public cap so they can fail explicitly instead of silently truncating.
 */
export async function listExternalAssetsForExport(
  ownerId: string,
  accountKey: string,
  limit: number,
): Promise<ExternalAssetRecord[]> {
  requireBulkLimit(limit);
  requireIdentity({ ownerId, accountKey });
  const database = getD1();
  await ensureExternalAssetSchema(database);
  try {
    const result = await database
      .prepare(LIST_EXTERNAL_ASSETS)
      .bind(ownerId, accountKey, limit)
      .all<ExternalAssetRecord>();
    return result.results.map(
      (row: ExternalAssetRecord) =>
        normalizeExternalAsset(row) as ExternalAssetRecord,
    );
  } catch (error) {
    if (error instanceof ExternalAssetStorageError) throw error;
    throw new ExternalAssetStorageError(
      "Unable to read external assets for export.",
      { cause: error },
    );
  }
}

export async function listExternalAssetSnapshots(
  ownerId: string,
  accountKey: string,
  limit: number,
): Promise<ExternalAssetSnapshotRecord[]> {
  requireSnapshotLimit(limit);
  requireIdentity({ ownerId, accountKey });
  const database = getD1();
  await ensureExternalAssetSchema(database);
  try {
    const result = await database
      .prepare(LIST_EXTERNAL_ASSET_SNAPSHOTS)
      .bind(ownerId, accountKey, limit)
      .all<ExternalAssetSnapshotRecord>();
    return result.results.map(normalizeExternalAssetSnapshot);
  } catch (error) {
    if (error instanceof ExternalAssetStorageError) throw error;
    throw new ExternalAssetStorageError(
      "Unable to read external-asset snapshots.",
      { cause: error },
    );
  }
}

async function findByIdempotency(
  database: ReturnType<typeof getD1>,
  ownerId: string,
  accountKey: string,
  idempotencyKey: string,
): Promise<ExternalAssetRecord | null> {
  return normalizeExternalAsset(
    await database
      .prepare(SELECT_EXTERNAL_ASSET_BY_IDEMPOTENCY)
      .bind(ownerId, accountKey, idempotencyKey)
      .first<ExternalAssetRecord>(),
  );
}

async function findById(
  database: ReturnType<typeof getD1>,
  id: string,
  ownerId: string,
  accountKey: string,
): Promise<ExternalAssetRecord | null> {
  return normalizeExternalAsset(
    await database
      .prepare(SELECT_EXTERNAL_ASSET_BY_ID)
      .bind(id, ownerId, accountKey)
      .first<ExternalAssetRecord>(),
  );
}

async function createNormalizedExternalAsset(
  normalized: ExternalAssetInput,
  identity: { ownerId: string; accountKey: string; idempotencyKey: string },
  now: Date = new Date(),
): Promise<{ asset: ExternalAssetRecord; created: boolean }> {
  requireIdentity(identity);
  if (!Number.isFinite(now.getTime())) {
    throw new ExternalAssetStorageError("External-asset clock is invalid.");
  }
  requireValuationNotInFuture(normalized.valuedAt, now);
  const createdAt = now.toISOString();
  const id = await createExternalAssetId(
    identity.ownerId,
    identity.accountKey,
    identity.idempotencyKey,
  );
  const database = getD1();
  await ensureExternalAssetSchema(database);

  try {
    const results = await database.batch([
      database
        .prepare(INSERT_EXTERNAL_ASSET)
        .bind(
          id,
          identity.ownerId,
          identity.accountKey,
          identity.idempotencyKey,
          normalized.kind,
          normalized.name,
          normalized.institution,
          normalized.currency,
          normalized.balance,
          normalized.valueKrw,
          normalized.valuedAt,
          normalized.maturityDate,
          normalized.annualRatePercent,
          normalized.note,
          createdAt,
          createdAt,
        ),
      database
        .prepare(INSERT_CREATED_SNAPSHOT)
        .bind(
          createSnapshotId(id, 1),
          createdAt,
          id,
          identity.ownerId,
          identity.accountKey,
        ),
    ]);
    const stored = await findByIdempotency(
      database,
      identity.ownerId,
      identity.accountKey,
      identity.idempotencyKey,
    );
    if (!stored) {
      throw new ExternalAssetStorageError(
        "External-asset write completed without a readable record.",
      );
    }
    if (!externalAssetPayloadMatches(stored, normalized)) {
      throw new ExternalAssetIdempotencyConflictError();
    }
    return {
      asset: stored,
      created: Number(results[0]?.meta.changes ?? 0) > 0,
    };
  } catch (error) {
    if (error instanceof ExternalAssetStorageError) throw error;
    throw new ExternalAssetStorageError("Unable to save the external asset.", {
      cause: error,
    });
  }
}

export async function createExternalAsset(
  input: ExternalAssetInput,
  identity: { ownerId: string; accountKey: string; idempotencyKey: string },
  now: Date = new Date(),
): Promise<{ asset: ExternalAssetRecord; created: boolean }> {
  return createNormalizedExternalAsset(
    parseExternalAssetInput(input),
    identity,
    now,
  );
}

/**
 * CSV backups may contain an explicitly closed zero-value revision. The normal
 * create endpoint still rejects zero values; only the separately authorized
 * import route can restore this persisted state.
 */
export async function createImportedExternalAsset(
  input: ExternalAssetInput,
  identity: { ownerId: string; accountKey: string; idempotencyKey: string },
  now: Date = new Date(),
): Promise<{ asset: ExternalAssetRecord; created: boolean }> {
  return createNormalizedExternalAsset(
    parseStoredExternalAssetInput(input),
    identity,
    now,
  );
}

export async function updateExternalAsset(
  input: ExternalAssetUpdateInput,
  identity: { ownerId: string; accountKey: string },
  now: Date = new Date(),
): Promise<{ asset: ExternalAssetRecord; updated: true }> {
  const normalized = parseExternalAssetUpdate(input);
  requireIdentity(identity);
  if (!Number.isFinite(now.getTime())) {
    throw new ExternalAssetStorageError("External-asset clock is invalid.");
  }
  requireValuationNotInFuture(normalized.valuedAt, now);
  const updatedAt = now.toISOString();
  const nextRevision = normalized.expectedRevision + 1;
  const database = getD1();
  await ensureExternalAssetSchema(database);

  try {
    const existing = await findById(
      database,
      normalized.id,
      identity.ownerId,
      identity.accountKey,
    );
    if (!existing) throw new ExternalAssetNotFoundError();
    if (existing.revision !== normalized.expectedRevision) {
      throw new ExternalAssetRevisionConflictError(existing.revision);
    }

    const results = await database.batch([
      database
        .prepare(UPDATE_EXTERNAL_ASSET)
        .bind(
          normalized.kind,
          normalized.name,
          normalized.institution,
          normalized.currency,
          normalized.balance,
          normalized.valueKrw,
          normalized.valuedAt,
          normalized.maturityDate,
          normalized.annualRatePercent,
          normalized.note,
          updatedAt,
          normalized.id,
          identity.ownerId,
          identity.accountKey,
          normalized.expectedRevision,
        ),
      database
        .prepare(INSERT_UPDATED_SNAPSHOT)
        .bind(
          createSnapshotId(normalized.id, nextRevision),
          updatedAt,
          normalized.id,
          identity.ownerId,
          identity.accountKey,
          nextRevision,
        ),
    ]);

    if (Number(results[0]?.meta.changes ?? 0) === 0) {
      const current = await findById(
        database,
        normalized.id,
        identity.ownerId,
        identity.accountKey,
      );
      if (!current) throw new ExternalAssetNotFoundError();
      throw new ExternalAssetRevisionConflictError(current.revision);
    }

    const stored = await findById(
      database,
      normalized.id,
      identity.ownerId,
      identity.accountKey,
    );
    if (!stored || stored.revision !== nextRevision) {
      throw new ExternalAssetStorageError(
        "External-asset update completed without a readable revision.",
      );
    }
    return { asset: stored, updated: true };
  } catch (error) {
    if (error instanceof ExternalAssetStorageError) throw error;
    throw new ExternalAssetStorageError("Unable to update the external asset.", {
      cause: error,
    });
  }
}
