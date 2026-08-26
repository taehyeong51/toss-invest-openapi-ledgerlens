import { findPortfolioSnapshot, capturePortfolioSnapshot, HistoryStorageError } from "../history/storage";
import { HistoryIdentityError, resolveHistoryAccountKey } from "../history/identity";
import { getPortfolioEnvironment } from "../portfolio/environment";
import { loadCurrentPortfolio } from "../portfolio/loader";
import { PortfolioRelayError } from "../portfolio/relay";
import { PortfolioBuildError } from "../portfolio/service";
import { TossApiError } from "../toss/errors";
import {
  acquireAutomationRun,
  AutomationStorageError,
  completeAutomationRunFailure,
  completeAutomationRunSuccess,
  listEnabledSnapshotSchedules,
  markScheduleTriggerVerified,
} from "./storage";
import type { StoredAutomationRun, StoredSnapshotSchedule } from "./types";

const SCHEDULED_UTC_HOUR = 22;
const SCHEDULED_UTC_MINUTE = 10;
const FIRST_UTC_WEEKDAY = 0; // Sunday 22:10 UTC is Monday 07:10 Asia/Seoul.
const LAST_UTC_WEEKDAY = 4; // Thursday 22:10 UTC is Friday 07:10 Asia/Seoul.

export interface ScheduledCaptureResult {
  accepted: boolean;
  scheduledFor: string | null;
  scheduleCount: number;
  claimedCount: number;
  succeededCount: number;
  failedCount: number;
  retryableFailureCount: number;
  terminalFailureCount: number;
}

interface RunnerDependencies {
  now?: () => Date;
  loadPortfolio?: typeof loadCurrentPortfolio;
  resolveAccountKey?: typeof resolveHistoryAccountKey;
  getEnvironment?: typeof getPortfolioEnvironment;
}

function validDate(date: Date): Date {
  if (!Number.isFinite(date.getTime())) throw new TypeError("Automation clock returned an invalid date.");
  return date;
}

/** Accepts only the single fixed Phase 4A weekday slot. No D1 or network access occurs here. */
export function automationScheduledSlot(scheduledTime: number): Date | null {
  if (!Number.isSafeInteger(scheduledTime) || scheduledTime < 0) return null;
  const date = new Date(scheduledTime);
  if (!Number.isFinite(date.getTime())) return null;
  const weekday = date.getUTCDay();
  if (
    weekday < FIRST_UTC_WEEKDAY ||
    weekday > LAST_UTC_WEEKDAY ||
    date.getUTCHours() !== SCHEDULED_UTC_HOUR ||
    date.getUTCMinutes() !== SCHEDULED_UTC_MINUTE ||
    date.getUTCSeconds() !== 0 ||
    date.getUTCMilliseconds() !== 0
  ) {
    return null;
  }
  return date;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function scheduledCaptureRunId(
  ownerId: string,
  accountKey: string,
  scheduledFor: string,
): Promise<string> {
  return `scr_${(await sha256Hex(`${ownerId}\u0000${accountKey}\u0000${scheduledFor}`)).slice(0, 40)}`;
}

export function scheduledCaptureIdempotencyKey(
  accountKey: string,
  scheduledFor: string,
): string {
  const key = `scheduled:v1:${scheduledFor}:${accountKey}`;
  if (key.length > 128 || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
    throw new TypeError("Unable to construct a valid scheduled capture key.");
  }
  return key;
}

function classifyRunFailure(error: unknown): { code: string; retryable: boolean } {
  if (error instanceof PortfolioRelayError) {
    return {
      code: /^[a-z0-9-]{1,64}$/.test(error.code) ? error.code : "relay-request-failed",
      retryable: ["relay-timeout", "relay-network-error", "relay-unavailable", "relay-rate-limited"].includes(
        error.code,
      ),
    };
  }
  if (error instanceof TossApiError) {
    const retryable =
      error.code === "timeout" ||
      error.code === "network-error" ||
      error.upstreamStatus === 429 ||
      (error.upstreamStatus ?? 0) >= 500;
    return { code: retryable ? "toss-temporarily-unavailable" : "toss-request-rejected", retryable };
  }
  if (error instanceof HistoryStorageError || error instanceof AutomationStorageError) {
    return { code: "automation-storage-unavailable", retryable: true };
  }
  if (error instanceof HistoryIdentityError) {
    return { code: "automation-account-unavailable", retryable: false };
  }
  if (error instanceof PortfolioBuildError) {
    return { code: "invalid-portfolio-response", retryable: false };
  }
  if (error instanceof TypeError || error instanceof RangeError) {
    return { code: "automation-configuration-invalid", retryable: false };
  }
  return { code: "automation-run-failed", retryable: false };
}

async function runOneSchedule(
  schedule: StoredSnapshotSchedule,
  accountKey: string,
  scheduledFor: string,
  dependencies: Required<Pick<RunnerDependencies, "now" | "loadPortfolio">>,
): Promise<"not-claimed" | "succeeded" | "retryable-failure" | "terminal-failure"> {
  const id = await scheduledCaptureRunId(schedule.ownerId, accountKey, scheduledFor);
  const claim = await acquireAutomationRun({
    id,
    ownerId: schedule.ownerId,
    accountKey,
    scheduledFor,
    now: validDate(dependencies.now()),
  });
  if (!claim) return "not-claimed";

  const idempotencyKey = scheduledCaptureIdempotencyKey(accountKey, scheduledFor);
  try {
    const existing = await findPortfolioSnapshot(schedule.ownerId, idempotencyKey);
    if (existing) {
      await completeAutomationRunSuccess(
        claim.run.id,
        claim.leaseToken,
        existing.id,
        validDate(dependencies.now()),
      );
      return "succeeded";
    }

    const portfolio = await dependencies.loadPortfolio();
    if (portfolio.mode !== "live") {
      throw new TypeError("Scheduled capture requires a live relay portfolio.");
    }
    const captured = await capturePortfolioSnapshot(
      portfolio,
      {
        ownerId: schedule.ownerId,
        accountKey,
        idempotencyKey,
      },
      validDate(dependencies.now()),
    );
    await completeAutomationRunSuccess(
      claim.run.id,
      claim.leaseToken,
      captured.snapshot.id,
      validDate(dependencies.now()),
    );
    return "succeeded";
  } catch (error) {
    const failure = classifyRunFailure(error);
    await completeAutomationRunFailure(
      claim.run as StoredAutomationRun,
      claim.leaseToken,
      failure.code,
      failure.retryable,
      validDate(dependencies.now()),
    );
    return failure.retryable && claim.run.attemptCount < 3
      ? "retryable-failure"
      : "terminal-failure";
  }
}

/**
 * Runs directly from the Worker scheduled handler. It never self-fetches an API
 * route and never imports or mutates unrelated financial ledgers.
 */
export async function runScheduledCaptures(
  scheduledTime: number,
  dependencies: RunnerDependencies = {},
): Promise<ScheduledCaptureResult> {
  const slot = automationScheduledSlot(scheduledTime);
  if (!slot) {
    return {
      accepted: false,
      scheduledFor: null,
      scheduleCount: 0,
      claimedCount: 0,
      succeededCount: 0,
      failedCount: 0,
      retryableFailureCount: 0,
      terminalFailureCount: 0,
    };
  }

  const getEnvironment = dependencies.getEnvironment ?? getPortfolioEnvironment;
  // This guard intentionally precedes account resolution, D1, and upstream I/O.
  if (getEnvironment().source !== "relay") {
    return {
      accepted: false,
      scheduledFor: slot.toISOString(),
      scheduleCount: 0,
      claimedCount: 0,
      succeededCount: 0,
      failedCount: 0,
      retryableFailureCount: 0,
      terminalFailureCount: 0,
    };
  }

  const now = dependencies.now ?? (() => new Date());
  const resolveAccountKey = dependencies.resolveAccountKey ?? resolveHistoryAccountKey;
  const loadPortfolio = dependencies.loadPortfolio ?? loadCurrentPortfolio;
  const accountKey = await resolveAccountKey();
  const schedules = await listEnabledSnapshotSchedules(accountKey);
  if (schedules.some((schedule) => schedule.accountKey !== accountKey)) {
    throw new AutomationStorageError("Automation schedule account partition mismatch.");
  }
  const observedAt = validDate(now());
  for (const schedule of schedules) {
    await markScheduleTriggerVerified(schedule.ownerId, accountKey, observedAt);
  }

  let claimedCount = 0;
  let succeededCount = 0;
  let failedCount = 0;
  let retryableFailureCount = 0;
  let terminalFailureCount = 0;
  for (const schedule of schedules) {
    const outcome = await runOneSchedule(schedule, accountKey, slot.toISOString(), {
      now,
      loadPortfolio,
    });
    if (outcome !== "not-claimed") claimedCount += 1;
    if (outcome === "succeeded") succeededCount += 1;
    if (outcome === "retryable-failure") {
      failedCount += 1;
      retryableFailureCount += 1;
    }
    if (outcome === "terminal-failure") {
      failedCount += 1;
      terminalFailureCount += 1;
    }
  }

  return {
    accepted: true,
    scheduledFor: slot.toISOString(),
    scheduleCount: schedules.length,
    claimedCount,
    succeededCount,
    failedCount,
    retryableFailureCount,
    terminalFailureCount,
  };
}
