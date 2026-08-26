import { getD1 } from "../../db";
import {
  AUTOMATION_LOCAL_TIME,
  AUTOMATION_TIMEZONE,
  AUTOMATION_WEEKDAYS,
  type AutomationRunStatus,
  type StoredAutomationRun,
  type StoredSnapshotSchedule,
} from "./types";

const WEEKDAYS_TEXT = AUTOMATION_WEEKDAYS.join(",");
const MAX_ATTEMPTS = 3;

const CREATE_SCHEDULES_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_schedules (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL,
    account_key TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    timezone TEXT NOT NULL CHECK (timezone = 'Asia/Seoul'),
    local_time TEXT NOT NULL CHECK (local_time = '07:10'),
    weekdays TEXT NOT NULL CHECK (weekdays = '1,2,3,4,5'),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    trigger_verified_at TEXT
  )
`;

const CREATE_RUNS_TABLE = `
  CREATE TABLE IF NOT EXISTS snapshot_capture_runs (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL,
    account_key TEXT NOT NULL,
    scheduled_for TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
      status IN ('running', 'succeeded', 'retryable-failure', 'terminal-failure', 'skipped')
    ),
    attempt_count INTEGER NOT NULL CHECK (attempt_count BETWEEN 1 AND 3),
    lease_token TEXT,
    lease_expires_at TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    snapshot_id TEXT,
    error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`;

const CREATE_SCHEDULE_OWNER_INDEX = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshot_schedules_owner
  ON snapshot_schedules (owner_id)
`;
const CREATE_SCHEDULE_ENABLED_ACCOUNT_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_snapshot_schedules_enabled_account
  ON snapshot_schedules (enabled, account_key)
`;
const CREATE_RUN_SLOT_INDEX = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshot_capture_runs_owner_account_slot
  ON snapshot_capture_runs (owner_id, account_key, scheduled_for)
`;
const CREATE_RUN_STATUS_LEASE_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_snapshot_capture_runs_status_lease
  ON snapshot_capture_runs (status, lease_expires_at)
`;

const SELECT_SCHEDULE_BY_OWNER = `
  SELECT
    id, owner_id AS "ownerId", account_key AS "accountKey", enabled,
    timezone, local_time AS "localTime", weekdays, revision,
    created_at AS "createdAt", updated_at AS "updatedAt",
    trigger_verified_at AS "triggerVerifiedAt"
  FROM snapshot_schedules
  WHERE owner_id = ?
  LIMIT 1
`;

const SELECT_ENABLED_SCHEDULES = `
  SELECT
    id, owner_id AS "ownerId", account_key AS "accountKey", enabled,
    timezone, local_time AS "localTime", weekdays, revision,
    created_at AS "createdAt", updated_at AS "updatedAt",
    trigger_verified_at AS "triggerVerifiedAt"
  FROM snapshot_schedules
  WHERE enabled = 1 AND account_key = ?
  ORDER BY owner_id ASC
`;

const INSERT_SCHEDULE = `
  INSERT OR IGNORE INTO snapshot_schedules (
    id, owner_id, account_key, enabled, timezone, local_time, weekdays,
    revision, created_at, updated_at, trigger_verified_at
  ) VALUES (?, ?, ?, 1, 'Asia/Seoul', '07:10', '1,2,3,4,5', 1, ?, ?, NULL)
`;

const UPDATE_SCHEDULE = `
  UPDATE snapshot_schedules
  SET account_key = ?, enabled = ?, revision = ?, updated_at = ?, trigger_verified_at = ?
  WHERE owner_id = ? AND revision = ?
`;

const VERIFY_TRIGGER = `
  UPDATE snapshot_schedules
  SET trigger_verified_at = ?
  WHERE owner_id = ? AND account_key = ? AND enabled = 1
`;

const SELECT_RUN_BY_ID = `
  SELECT
    id, owner_id AS "ownerId", account_key AS "accountKey",
    scheduled_for AS "scheduledFor", status, attempt_count AS "attemptCount",
    lease_token AS "leaseToken", lease_expires_at AS "leaseExpiresAt",
    started_at AS "startedAt", finished_at AS "finishedAt",
    snapshot_id AS "snapshotId", error_code AS "errorCode",
    created_at AS "createdAt", updated_at AS "updatedAt"
  FROM snapshot_capture_runs
  WHERE id = ?
  LIMIT 1
`;

const INSERT_RUN = `
  INSERT OR IGNORE INTO snapshot_capture_runs (
    id, owner_id, account_key, scheduled_for, status, attempt_count,
    lease_token, lease_expires_at, started_at, finished_at, snapshot_id,
    error_code, created_at, updated_at
  ) VALUES (?, ?, ?, ?, 'running', 1, ?, ?, ?, NULL, NULL, NULL, ?, ?)
`;

const REACQUIRE_RUN = `
  UPDATE snapshot_capture_runs
  SET status = 'running', attempt_count = attempt_count + 1,
      lease_token = ?, lease_expires_at = ?, started_at = ?, finished_at = NULL,
      snapshot_id = NULL, error_code = NULL, updated_at = ?
  WHERE id = ? AND attempt_count = ? AND attempt_count < 3
    AND (
      status = 'retryable-failure'
      OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
    )
`;

const EXPIRE_FINAL_LEASE = `
  UPDATE snapshot_capture_runs
  SET status = 'terminal-failure', lease_token = NULL, lease_expires_at = NULL,
      finished_at = ?, error_code = 'automation-lease-expired', updated_at = ?
  WHERE id = ? AND status = 'running' AND attempt_count >= 3
    AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
`;

const COMPLETE_RUN_SUCCESS = `
  UPDATE snapshot_capture_runs
  SET status = 'succeeded', lease_token = NULL, lease_expires_at = NULL,
      finished_at = ?, snapshot_id = ?, error_code = NULL, updated_at = ?
  WHERE id = ? AND status = 'running' AND lease_token = ?
`;

const COMPLETE_RUN_FAILURE = `
  UPDATE snapshot_capture_runs
  SET status = ?, lease_token = NULL, lease_expires_at = NULL,
      finished_at = ?, snapshot_id = NULL, error_code = ?, updated_at = ?
  WHERE id = ? AND status = 'running' AND lease_token = ?
`;

const LIST_RUNS = `
  SELECT
    id, owner_id AS "ownerId", account_key AS "accountKey",
    scheduled_for AS "scheduledFor", status, attempt_count AS "attemptCount",
    lease_token AS "leaseToken", lease_expires_at AS "leaseExpiresAt",
    started_at AS "startedAt", finished_at AS "finishedAt",
    snapshot_id AS "snapshotId", error_code AS "errorCode",
    created_at AS "createdAt", updated_at AS "updatedAt"
  FROM snapshot_capture_runs
  WHERE owner_id = ? AND account_key = ?
  ORDER BY scheduled_for DESC, id DESC
  LIMIT ?
`;

const SELECT_LAST_SUCCESS = `
  SELECT
    id, owner_id AS "ownerId", account_key AS "accountKey",
    scheduled_for AS "scheduledFor", status, attempt_count AS "attemptCount",
    lease_token AS "leaseToken", lease_expires_at AS "leaseExpiresAt",
    started_at AS "startedAt", finished_at AS "finishedAt",
    snapshot_id AS "snapshotId", error_code AS "errorCode",
    created_at AS "createdAt", updated_at AS "updatedAt"
  FROM snapshot_capture_runs
  WHERE owner_id = ? AND account_key = ? AND status = 'succeeded'
  ORDER BY scheduled_for DESC, id DESC
  LIMIT 1
`;

interface ScheduleRow {
  id: unknown;
  ownerId: unknown;
  accountKey: unknown;
  enabled: unknown;
  timezone: unknown;
  localTime: unknown;
  weekdays: unknown;
  revision: unknown;
  createdAt: unknown;
  updatedAt: unknown;
  triggerVerifiedAt: unknown;
}

interface RunRow {
  id: unknown;
  ownerId: unknown;
  accountKey: unknown;
  scheduledFor: unknown;
  status: unknown;
  attemptCount: unknown;
  leaseToken: unknown;
  leaseExpiresAt: unknown;
  startedAt: unknown;
  finishedAt: unknown;
  snapshotId: unknown;
  errorCode: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

const initializationByBinding = new WeakMap<object, Promise<void>>();

export class AutomationStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AutomationStorageError";
  }
}

export class AutomationRevisionConflictError extends Error {
  constructor() {
    super("The automation schedule revision is stale.");
    this.name = "AutomationRevisionConflictError";
  }
}

export class AutomationScheduleNotFoundError extends Error {
  constructor() {
    super("No automation schedule exists for this owner.");
    this.name = "AutomationScheduleNotFoundError";
  }
}

export class AutomationAccountMismatchError extends Error {
  constructor() {
    super("The automation schedule is bound to a different account.");
    this.name = "AutomationAccountMismatchError";
  }
}

async function ensureAutomationSchema(database: ReturnType<typeof getD1>): Promise<void> {
  const key = database as object;
  const existing = initializationByBinding.get(key);
  if (existing) return existing;

  const initialization = database
    .batch([
      database.prepare(CREATE_SCHEDULES_TABLE),
      database.prepare(CREATE_RUNS_TABLE),
      database.prepare(CREATE_SCHEDULE_OWNER_INDEX),
      database.prepare(CREATE_SCHEDULE_ENABLED_ACCOUNT_INDEX),
      database.prepare(CREATE_RUN_SLOT_INDEX),
      database.prepare(CREATE_RUN_STATUS_LEASE_INDEX),
      database.prepare("PRAGMA optimize"),
    ])
    .then(() => undefined)
    .catch((error: unknown) => {
      initializationByBinding.delete(key);
      throw new AutomationStorageError("Unable to initialize automation storage.", {
        cause: error,
      });
    });
  initializationByBinding.set(key, initialization);
  return initialization;
}

function validIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

function safeText(value: unknown, maxLength: number, pattern?: RegExp): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !containsControlCharacter(value) &&
    (pattern === undefined || pattern.test(value))
  );
}

function nullableSafeText(value: unknown, maxLength: number, pattern?: RegExp): string | null {
  if (value === null) return null;
  if (!safeText(value, maxLength, pattern)) {
    throw new AutomationStorageError("Invalid nullable text in automation storage.");
  }
  return value;
}

function normalizeSchedule(row: ScheduleRow | null): StoredSnapshotSchedule | null {
  if (!row) return null;
  if (
    !safeText(row.id, 128, /^sas_[a-f0-9]{40}$/) ||
    !safeText(row.ownerId, 256) ||
    !safeText(row.accountKey, 256, /^(?:relay|direct):[a-f0-9]{64}$/) ||
    (row.enabled !== 0 && row.enabled !== 1 && row.enabled !== false && row.enabled !== true) ||
    row.timezone !== AUTOMATION_TIMEZONE ||
    row.localTime !== AUTOMATION_LOCAL_TIME ||
    row.weekdays !== WEEKDAYS_TEXT ||
    !Number.isSafeInteger(row.revision) ||
    Number(row.revision) < 1 ||
    !validIso(row.createdAt) ||
    !validIso(row.updatedAt) ||
    (row.triggerVerifiedAt !== null && !validIso(row.triggerVerifiedAt))
  ) {
    throw new AutomationStorageError("Automation storage contains an invalid schedule.");
  }
  return {
    id: row.id,
    ownerId: row.ownerId,
    accountKey: row.accountKey,
    enabled: row.enabled === 1 || row.enabled === true,
    timezone: AUTOMATION_TIMEZONE,
    localTime: AUTOMATION_LOCAL_TIME,
    weekdays: AUTOMATION_WEEKDAYS,
    revision: Number(row.revision),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    triggerVerifiedAt: row.triggerVerifiedAt,
  };
}

const RUN_STATUSES = new Set<AutomationRunStatus>([
  "running",
  "succeeded",
  "retryable-failure",
  "terminal-failure",
  "skipped",
]);

function normalizeRun(row: RunRow | null): StoredAutomationRun | null {
  if (!row) return null;
  const leaseToken = nullableSafeText(row.leaseToken, 128, /^[A-Za-z0-9._:-]{8,128}$/);
  const snapshotId = nullableSafeText(row.snapshotId, 128, /^ps_[a-f0-9]{40}$/);
  const errorCode = nullableSafeText(row.errorCode, 64, /^[a-z0-9-]{1,64}$/);
  if (
    !safeText(row.id, 128, /^scr_[a-f0-9]{40}$/) ||
    !safeText(row.ownerId, 256) ||
    !safeText(row.accountKey, 256, /^(?:relay|direct):[a-f0-9]{64}$/) ||
    !validIso(row.scheduledFor) ||
    typeof row.status !== "string" ||
    !RUN_STATUSES.has(row.status as AutomationRunStatus) ||
    !Number.isSafeInteger(row.attemptCount) ||
    Number(row.attemptCount) < 1 ||
    Number(row.attemptCount) > MAX_ATTEMPTS ||
    !validIso(row.startedAt) ||
    !validIso(row.createdAt) ||
    !validIso(row.updatedAt) ||
    (row.leaseExpiresAt !== null && !validIso(row.leaseExpiresAt)) ||
    (row.finishedAt !== null && !validIso(row.finishedAt))
  ) {
    throw new AutomationStorageError("Automation storage contains an invalid run.");
  }
  return {
    id: row.id,
    ownerId: row.ownerId,
    accountKey: row.accountKey,
    scheduledFor: row.scheduledFor,
    status: row.status as AutomationRunStatus,
    attemptCount: Number(row.attemptCount),
    leaseToken,
    leaseExpiresAt: row.leaseExpiresAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    snapshotId,
    errorCode,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function scheduleId(ownerId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ownerId));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `sas_${hex.slice(0, 40)}`;
}

async function readSchedule(database: ReturnType<typeof getD1>, ownerId: string) {
  return normalizeSchedule(
    await database.prepare(SELECT_SCHEDULE_BY_OWNER).bind(ownerId).first<ScheduleRow>(),
  );
}

export async function getSnapshotSchedule(ownerId: string): Promise<StoredSnapshotSchedule | null> {
  const database = getD1();
  await ensureAutomationSchema(database);
  try {
    return await readSchedule(database, ownerId);
  } catch (error) {
    if (error instanceof AutomationStorageError) throw error;
    throw new AutomationStorageError("Unable to read the automation schedule.", { cause: error });
  }
}

export async function listEnabledSnapshotSchedules(
  accountKey: string,
): Promise<StoredSnapshotSchedule[]> {
  const database = getD1();
  await ensureAutomationSchema(database);
  try {
    const result = await database.prepare(SELECT_ENABLED_SCHEDULES).bind(accountKey).all<ScheduleRow>();
    return result.results.map((row: ScheduleRow) => normalizeSchedule(row) as StoredSnapshotSchedule);
  } catch (error) {
    if (error instanceof AutomationStorageError) throw error;
    throw new AutomationStorageError("Unable to list enabled automation schedules.", { cause: error });
  }
}

export async function configureSnapshotSchedule(input: {
  ownerId: string;
  accountKey: string | null;
  enabled: boolean;
  expectedRevision: number;
  now?: Date;
}): Promise<{ schedule: StoredSnapshotSchedule; updated: boolean }> {
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new AutomationStorageError("Invalid schedule timestamp.");
  const nowIso = now.toISOString();
  const database = getD1();
  await ensureAutomationSchema(database);

  try {
    const current = await readSchedule(database, input.ownerId);
    if (!current) {
      if (!input.enabled) throw new AutomationScheduleNotFoundError();
      if (!input.accountKey) throw new AutomationAccountMismatchError();
      if (input.expectedRevision !== 0) throw new AutomationRevisionConflictError();
      const inserted = await database
        .prepare(INSERT_SCHEDULE)
        .bind(await scheduleId(input.ownerId), input.ownerId, input.accountKey, nowIso, nowIso)
        .run();
      const stored = await readSchedule(database, input.ownerId);
      if (!stored) throw new AutomationStorageError("Schedule creation completed without a readable row.");
      if (Number(inserted.meta?.changes ?? 0) === 0) {
        if (stored.enabled && stored.accountKey === input.accountKey) {
          return { schedule: stored, updated: false };
        }
        throw new AutomationRevisionConflictError();
      }
      return { schedule: stored, updated: true };
    }

    const accountMatches = !input.enabled || current.accountKey === input.accountKey;
    const sameState = current.enabled === input.enabled && accountMatches;
    if (input.expectedRevision !== current.revision) {
      if (sameState) return { schedule: current, updated: false };
      throw new AutomationRevisionConflictError();
    }
    if (sameState) return { schedule: current, updated: false };
    if (input.enabled && !input.accountKey) throw new AutomationAccountMismatchError();
    if (input.enabled && current.enabled && current.accountKey !== input.accountKey) {
      throw new AutomationAccountMismatchError();
    }

    const nextAccountKey = input.enabled ? (input.accountKey as string) : current.accountKey;
    const nextTriggerVerifiedAt = input.enabled ? null : current.triggerVerifiedAt;
    const nextRevision = current.revision + 1;
    const updated = await database
      .prepare(UPDATE_SCHEDULE)
      .bind(
        nextAccountKey,
        input.enabled ? 1 : 0,
        nextRevision,
        nowIso,
        nextTriggerVerifiedAt,
        input.ownerId,
        current.revision,
      )
      .run();
    const stored = await readSchedule(database, input.ownerId);
    if (!stored) throw new AutomationStorageError("Updated schedule is not readable.");
    if (Number(updated.meta?.changes ?? 0) === 0) {
      const nowMatches = stored.enabled === input.enabled && (!input.enabled || stored.accountKey === input.accountKey);
      if (nowMatches) return { schedule: stored, updated: false };
      throw new AutomationRevisionConflictError();
    }
    return { schedule: stored, updated: true };
  } catch (error) {
    if (
      error instanceof AutomationStorageError ||
      error instanceof AutomationRevisionConflictError ||
      error instanceof AutomationScheduleNotFoundError ||
      error instanceof AutomationAccountMismatchError
    ) {
      throw error;
    }
    throw new AutomationStorageError("Unable to configure the automation schedule.", { cause: error });
  }
}

export async function markScheduleTriggerVerified(
  ownerId: string,
  accountKey: string,
  observedAt: Date,
): Promise<void> {
  if (!Number.isFinite(observedAt.getTime())) throw new AutomationStorageError("Invalid trigger timestamp.");
  const database = getD1();
  await ensureAutomationSchema(database);
  try {
    await database.prepare(VERIFY_TRIGGER).bind(observedAt.toISOString(), ownerId, accountKey).run();
  } catch (error) {
    throw new AutomationStorageError("Unable to verify the automation trigger.", { cause: error });
  }
}

async function readRun(database: ReturnType<typeof getD1>, id: string) {
  return normalizeRun(await database.prepare(SELECT_RUN_BY_ID).bind(id).first<RunRow>());
}

export async function acquireAutomationRun(input: {
  id: string;
  ownerId: string;
  accountKey: string;
  scheduledFor: string;
  now?: Date;
  leaseMs?: number;
}): Promise<{ run: StoredAutomationRun; leaseToken: string } | null> {
  const now = input.now ?? new Date();
  const leaseMs = input.leaseMs ?? 60_000;
  if (!Number.isFinite(now.getTime()) || !Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000) {
    throw new AutomationStorageError("Invalid automation lease configuration.");
  }
  const nowIso = now.toISOString();
  const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
  const leaseToken = crypto.randomUUID();
  const database = getD1();
  await ensureAutomationSchema(database);

  try {
    const inserted = await database
      .prepare(INSERT_RUN)
      .bind(
        input.id,
        input.ownerId,
        input.accountKey,
        input.scheduledFor,
        leaseToken,
        leaseExpiresAt,
        nowIso,
        nowIso,
        nowIso,
      )
      .run();
    if (Number(inserted.meta?.changes ?? 0) > 0) {
      const run = await readRun(database, input.id);
      if (!run) throw new AutomationStorageError("Created automation run is not readable.");
      return { run, leaseToken };
    }

    let current = await readRun(database, input.id);
    if (!current) throw new AutomationStorageError("Existing automation run is not readable.");
    if (current.status === "succeeded" || current.status === "terminal-failure" || current.status === "skipped") {
      return null;
    }
    const leaseExpired =
      current.status === "running" &&
      current.leaseExpiresAt !== null &&
      Date.parse(current.leaseExpiresAt) <= now.getTime();
    if (current.attemptCount >= MAX_ATTEMPTS) {
      if (leaseExpired) {
        await database
          .prepare(EXPIRE_FINAL_LEASE)
          .bind(nowIso, nowIso, input.id, nowIso)
          .run();
      }
      return null;
    }
    if (current.status === "running" && !leaseExpired) return null;

    const reacquired = await database
      .prepare(REACQUIRE_RUN)
      .bind(
        leaseToken,
        leaseExpiresAt,
        nowIso,
        nowIso,
        input.id,
        current.attemptCount,
        nowIso,
      )
      .run();
    if (Number(reacquired.meta?.changes ?? 0) === 0) return null;
    current = await readRun(database, input.id);
    if (!current || current.leaseToken !== leaseToken) return null;
    return { run: current, leaseToken };
  } catch (error) {
    if (error instanceof AutomationStorageError) throw error;
    throw new AutomationStorageError("Unable to acquire an automation run.", { cause: error });
  }
}

export async function completeAutomationRunSuccess(
  id: string,
  leaseToken: string,
  snapshotId: string,
  now: Date = new Date(),
): Promise<void> {
  if (!Number.isFinite(now.getTime())) throw new AutomationStorageError("Invalid completion timestamp.");
  const nowIso = now.toISOString();
  const database = getD1();
  await ensureAutomationSchema(database);
  try {
    const result = await database
      .prepare(COMPLETE_RUN_SUCCESS)
      .bind(nowIso, snapshotId, nowIso, id, leaseToken)
      .run();
    if (Number(result.meta?.changes ?? 0) !== 1) {
      throw new AutomationStorageError("Automation run success lost its lease.");
    }
  } catch (error) {
    if (error instanceof AutomationStorageError) throw error;
    throw new AutomationStorageError("Unable to complete an automation run.", { cause: error });
  }
}

export async function completeAutomationRunFailure(
  run: StoredAutomationRun,
  leaseToken: string,
  errorCode: string,
  retryable: boolean,
  now: Date = new Date(),
): Promise<void> {
  if (!Number.isFinite(now.getTime())) throw new AutomationStorageError("Invalid failure timestamp.");
  const safeCode = /^[a-z0-9-]{1,64}$/.test(errorCode) ? errorCode : "automation-run-failed";
  const status: AutomationRunStatus =
    retryable && run.attemptCount < MAX_ATTEMPTS ? "retryable-failure" : "terminal-failure";
  const nowIso = now.toISOString();
  const database = getD1();
  await ensureAutomationSchema(database);
  try {
    const result = await database
      .prepare(COMPLETE_RUN_FAILURE)
      .bind(status, nowIso, safeCode, nowIso, run.id, leaseToken)
      .run();
    if (Number(result.meta?.changes ?? 0) !== 1) {
      throw new AutomationStorageError("Automation run failure lost its lease.");
    }
  } catch (error) {
    if (error instanceof AutomationStorageError) throw error;
    throw new AutomationStorageError("Unable to record an automation failure.", { cause: error });
  }
}

export async function listAutomationRuns(
  ownerId: string,
  accountKey: string,
  limit: number,
): Promise<StoredAutomationRun[]> {
  const database = getD1();
  await ensureAutomationSchema(database);
  try {
    const result = await database.prepare(LIST_RUNS).bind(ownerId, accountKey, limit).all<RunRow>();
    return result.results.map((row: RunRow) => normalizeRun(row) as StoredAutomationRun);
  } catch (error) {
    if (error instanceof AutomationStorageError) throw error;
    throw new AutomationStorageError("Unable to list automation runs.", { cause: error });
  }
}

export async function getLastSuccessfulAutomationRun(
  ownerId: string,
  accountKey: string,
): Promise<StoredAutomationRun | null> {
  const database = getD1();
  await ensureAutomationSchema(database);
  try {
    return normalizeRun(
      await database.prepare(SELECT_LAST_SUCCESS).bind(ownerId, accountKey).first<RunRow>(),
    );
  } catch (error) {
    if (error instanceof AutomationStorageError) throw error;
    throw new AutomationStorageError("Unable to read the last successful automation run.", {
      cause: error,
    });
  }
}
