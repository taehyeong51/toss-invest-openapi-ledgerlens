import { getD1 } from "../../db";
import type {
  NewReviewJournalEntry,
  ReviewActionStatus,
  ReviewJournalEntry,
} from "./types";
import {
  parseNewReviewJournalEntry,
  parseReviewStatusUpdate,
} from "./validation";

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS review_journal (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL,
    account_key TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    period_started_at TEXT NOT NULL,
    period_ended_at TEXT NOT NULL,
    cash_flow_confirmation TEXT NOT NULL CHECK (cash_flow_confirmation IN ('complete', 'incomplete')),
    action TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
    snapshot_count INTEGER NOT NULL CHECK (snapshot_count BETWEEN 0 AND 365),
    plan_revision INTEGER,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    resolved_at TEXT
  )
`;
const CREATE_IDEMPOTENCY_INDEX = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_review_journal_owner_account_idempotency
  ON review_journal (owner_id, account_key, idempotency_key)
`;
const CREATE_CREATED_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_review_journal_owner_account_created
  ON review_journal (owner_id, account_key, created_at)
`;
const SELECT_COLUMNS = `
  id, period_started_at AS "periodStartedAt", period_ended_at AS "periodEndedAt",
  cash_flow_confirmation AS "cashFlowConfirmation", action, status,
  snapshot_count AS "snapshotCount", plan_revision AS "planRevision", revision,
  created_at AS "createdAt", updated_at AS "updatedAt", resolved_at AS "resolvedAt"
`;
const SELECT_BY_IDEMPOTENCY = `
  SELECT ${SELECT_COLUMNS} FROM review_journal
  WHERE owner_id = ? AND account_key = ? AND idempotency_key = ? LIMIT 1
`;
const SELECT_BY_ID = `
  SELECT ${SELECT_COLUMNS} FROM review_journal
  WHERE owner_id = ? AND account_key = ? AND id = ? LIMIT 1
`;
const LIST_REVIEWS = `
  SELECT ${SELECT_COLUMNS} FROM review_journal
  WHERE owner_id = ? AND account_key = ?
  ORDER BY created_at DESC, id DESC LIMIT ?
`;
const INSERT_REVIEW = `
  INSERT OR IGNORE INTO review_journal (
    id, owner_id, account_key, idempotency_key, period_started_at, period_ended_at,
    cash_flow_confirmation, action, status, snapshot_count, plan_revision,
    revision, created_at, updated_at, resolved_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, 1, ?, ?, NULL)
`;
const UPDATE_STATUS = `
  UPDATE review_journal SET status = ?, revision = ?, updated_at = ?, resolved_at = ?
  WHERE owner_id = ? AND account_key = ? AND id = ? AND revision = ?
`;

const initializationByBinding = new WeakMap<object, Promise<void>>();

export class ReviewStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReviewStorageError";
  }
}

export class ReviewIdempotencyConflictError extends ReviewStorageError {
  constructor() {
    super("Idempotency-Key was already used for a different review payload.");
    this.name = "ReviewIdempotencyConflictError";
  }
}

export class ReviewRevisionConflictError extends ReviewStorageError {
  constructor() {
    super("Review revision is stale.");
    this.name = "ReviewRevisionConflictError";
  }
}

async function ensureSchema(database: ReturnType<typeof getD1>): Promise<void> {
  const key = database as object;
  const existing = initializationByBinding.get(key);
  if (existing) return existing;
  const initialization = database.batch([
    database.prepare(CREATE_TABLE),
    database.prepare(CREATE_IDEMPOTENCY_INDEX),
    database.prepare(CREATE_CREATED_INDEX),
    database.prepare("PRAGMA optimize"),
  ]).then(() => undefined).catch((error: unknown) => {
    initializationByBinding.delete(key);
    throw new ReviewStorageError("Unable to initialize review storage.", { cause: error });
  });
  initializationByBinding.set(key, initialization);
  return initialization;
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function normalizeReview(row: ReviewJournalEntry | null): ReviewJournalEntry | null {
  if (!row) return null;
  if (
    typeof row.id !== "string" ||
    (row.status !== "open" && row.status !== "resolved") ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1 ||
    !canonicalTimestamp(row.createdAt) ||
    !canonicalTimestamp(row.updatedAt) ||
    (row.resolvedAt !== null && !canonicalTimestamp(row.resolvedAt))
  ) {
    throw new ReviewStorageError("Review storage contains an invalid record.");
  }
  const parsed = parseNewReviewJournalEntry({
    periodStartedAt: row.periodStartedAt,
    periodEndedAt: row.periodEndedAt,
    cashFlowConfirmation: row.cashFlowConfirmation,
    action: row.action,
    snapshotCount: row.snapshotCount,
    planRevision: row.planRevision,
  });
  return {
    id: row.id,
    ...parsed,
    status: row.status,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    resolvedAt: row.resolvedAt,
  };
}

async function reviewId(ownerId: string, accountKey: string, idempotencyKey: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${ownerId}\u0000${accountKey}\u0000${idempotencyKey}`),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `rv_${hex.slice(0, 40)}`;
}

export function reviewPayloadMatches(
  stored: ReviewJournalEntry,
  input: NewReviewJournalEntry,
): boolean {
  return (
    stored.periodStartedAt === input.periodStartedAt &&
    stored.periodEndedAt === input.periodEndedAt &&
    stored.cashFlowConfirmation === input.cashFlowConfirmation &&
    stored.action === input.action &&
    stored.snapshotCount === input.snapshotCount &&
    stored.planRevision === input.planRevision
  );
}

export async function findReviewByIdempotency(
  ownerId: string,
  accountKey: string,
  idempotencyKey: string,
): Promise<ReviewJournalEntry | null> {
  const database = getD1();
  await ensureSchema(database);
  try {
    return normalizeReview(await database.prepare(SELECT_BY_IDEMPOTENCY)
      .bind(ownerId, accountKey, idempotencyKey).first<ReviewJournalEntry>());
  } catch (error) {
    if (error instanceof ReviewStorageError) throw error;
    throw new ReviewStorageError("Unable to read an idempotent review.", { cause: error });
  }
}

export async function listReviews(
  ownerId: string,
  accountKey: string,
  limit: number,
): Promise<ReviewJournalEntry[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new ReviewStorageError("Review query limit is out of range.");
  }
  const database = getD1();
  await ensureSchema(database);
  try {
    const result = await database.prepare(LIST_REVIEWS)
      .bind(ownerId, accountKey, limit).all<ReviewJournalEntry>();
    return result.results.map((row) => normalizeReview(row) as ReviewJournalEntry);
  } catch (error) {
    if (error instanceof ReviewStorageError) throw error;
    throw new ReviewStorageError("Unable to list reviews.", { cause: error });
  }
}

export async function recordReview(
  input: NewReviewJournalEntry,
  identity: { ownerId: string; accountKey: string; idempotencyKey: string },
  now = new Date(),
): Promise<{ review: ReviewJournalEntry; created: boolean }> {
  const parsed = parseNewReviewJournalEntry(input);
  if (!Number.isFinite(now.getTime())) throw new ReviewStorageError("Invalid review timestamp.");
  const nowIso = now.toISOString();
  const database = getD1();
  await ensureSchema(database);
  try {
    const result = await database.prepare(INSERT_REVIEW).bind(
      await reviewId(identity.ownerId, identity.accountKey, identity.idempotencyKey),
      identity.ownerId,
      identity.accountKey,
      identity.idempotencyKey,
      parsed.periodStartedAt,
      parsed.periodEndedAt,
      parsed.cashFlowConfirmation,
      parsed.action,
      parsed.snapshotCount,
      parsed.planRevision,
      nowIso,
      nowIso,
    ).run();
    const stored = await findReviewByIdempotency(
      identity.ownerId,
      identity.accountKey,
      identity.idempotencyKey,
    );
    if (!stored) throw new ReviewStorageError("Created review is not readable.");
    if (!reviewPayloadMatches(stored, parsed)) throw new ReviewIdempotencyConflictError();
    return { review: stored, created: Number(result.meta?.changes ?? 0) > 0 };
  } catch (error) {
    if (error instanceof ReviewStorageError) throw error;
    throw new ReviewStorageError("Unable to save the review.", { cause: error });
  }
}

export async function updateReviewStatus(input: {
  ownerId: string;
  accountKey: string;
  id: string;
  status: ReviewActionStatus;
  expectedRevision: number;
  now?: Date;
}): Promise<ReviewJournalEntry> {
  const parsed = parseReviewStatusUpdate({
    id: input.id,
    status: input.status,
    expectedRevision: input.expectedRevision,
  });
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new ReviewStorageError("Invalid review timestamp.");
  const database = getD1();
  await ensureSchema(database);
  try {
    const current = normalizeReview(await database.prepare(SELECT_BY_ID)
      .bind(input.ownerId, input.accountKey, parsed.id).first<ReviewJournalEntry>());
    if (!current) throw new ReviewStorageError("Review record was not found.");
    if (current.revision !== parsed.expectedRevision) throw new ReviewRevisionConflictError();
    if (current.status === parsed.status) return current;
    const nowIso = now.toISOString();
    const nextRevision = current.revision + 1;
    const resolvedAt = parsed.status === "resolved" ? nowIso : null;
    const result = await database.prepare(UPDATE_STATUS).bind(
      parsed.status,
      nextRevision,
      nowIso,
      resolvedAt,
      input.ownerId,
      input.accountKey,
      parsed.id,
      current.revision,
    ).run();
    if (Number(result.meta?.changes ?? 0) !== 1) throw new ReviewRevisionConflictError();
    const stored = normalizeReview(await database.prepare(SELECT_BY_ID)
      .bind(input.ownerId, input.accountKey, parsed.id).first<ReviewJournalEntry>());
    if (!stored) throw new ReviewStorageError("Updated review is not readable.");
    return stored;
  } catch (error) {
    if (error instanceof ReviewStorageError) throw error;
    throw new ReviewStorageError("Unable to update the review.", { cause: error });
  }
}
