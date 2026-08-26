export const AUTOMATION_TIMEZONE = "Asia/Seoul" as const;
export const AUTOMATION_LOCAL_TIME = "07:10" as const;
export const AUTOMATION_WEEKDAYS = [1, 2, 3, 4, 5] as const;

export type AutomationRunStatus =
  | "running"
  | "succeeded"
  | "retryable-failure"
  | "terminal-failure"
  | "skipped";

export type AutomationStatus =
  | "demo"
  | "manual-only"
  | "ready"
  | "awaiting-trigger"
  | "scheduled"
  | "degraded";

export interface StoredSnapshotSchedule {
  id: string;
  ownerId: string;
  accountKey: string;
  enabled: boolean;
  timezone: typeof AUTOMATION_TIMEZONE;
  localTime: typeof AUTOMATION_LOCAL_TIME;
  weekdays: typeof AUTOMATION_WEEKDAYS;
  revision: number;
  createdAt: string;
  updatedAt: string;
  triggerVerifiedAt: string | null;
}

export interface SnapshotScheduleView {
  enabled: boolean;
  timezone: typeof AUTOMATION_TIMEZONE;
  localTime: typeof AUTOMATION_LOCAL_TIME;
  weekdays: [1, 2, 3, 4, 5];
  revision: number;
  updatedAt: string;
  triggerVerifiedAt: string | null;
}

export interface AutomationRunView {
  id: string;
  scheduledFor: string;
  status: AutomationRunStatus;
  attemptCount: number;
  startedAt: string;
  finishedAt: string | null;
  snapshotId: string | null;
  errorCode: string | null;
}

export interface StoredAutomationRun extends AutomationRunView {
  ownerId: string;
  accountKey: string;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationResponse {
  source: "demo" | "direct" | "relay";
  status: AutomationStatus;
  relay: {
    configured: boolean;
    accountBound: boolean;
  };
  canManageSchedule: boolean;
  schedule: SnapshotScheduleView | null;
  recentRuns: AutomationRunView[];
  lastSuccessfulRun: AutomationRunView | null;
}

export function scheduleView(schedule: StoredSnapshotSchedule): SnapshotScheduleView {
  return {
    enabled: schedule.enabled,
    timezone: schedule.timezone,
    localTime: schedule.localTime,
    weekdays: [1, 2, 3, 4, 5],
    revision: schedule.revision,
    updatedAt: schedule.updatedAt,
    triggerVerifiedAt: schedule.triggerVerifiedAt,
  };
}

export function runView(run: StoredAutomationRun): AutomationRunView {
  return {
    id: run.id,
    scheduledFor: run.scheduledFor,
    status: run.status,
    attemptCount: run.attemptCount,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    snapshotId: run.snapshotId,
    errorCode: run.errorCode,
  };
}
