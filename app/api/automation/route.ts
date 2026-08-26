import {
  AutomationAccountMismatchError,
  AutomationRevisionConflictError,
  AutomationScheduleNotFoundError,
  AutomationStorageError,
  configureSnapshotSchedule,
  getLastSuccessfulAutomationRun,
  getSnapshotSchedule,
  listAutomationRuns,
} from "@/lib/automation/storage";
import {
  AUTOMATION_LOCAL_TIME,
  AUTOMATION_TIMEZONE,
  runView,
  scheduleView,
  type AutomationResponse,
  type AutomationStatus,
  type SnapshotScheduleView,
  type StoredAutomationRun,
  type StoredSnapshotSchedule,
} from "@/lib/automation/types";
import {
  HistoryIdentityError,
  resolveHistoryAccountKey,
  resolveHistoryOwner,
} from "@/lib/history/identity";
import { getPortfolioEnvironment } from "@/lib/portfolio/environment";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 1024;
const TRIGGER_LIVENESS_MS = 96 * 60 * 60 * 1_000;
const MAX_TRIGGER_FUTURE_SKEW_MS = 60 * 1_000;
const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "Cloudflare-CDN-Cache-Control": "no-store",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
} as const;

function jsonResponse<T>(body: T, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE_HEADERS });
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message, retryable: status >= 500 } }, status);
}

function parseLimit(request: Request): number | Response {
  const searchParams = new URL(request.url).searchParams;
  if (Array.from(searchParams.keys()).some((key) => key !== "limit")) {
    return errorResponse(400, "invalid-query", "지원하지 않는 쿼리 매개변수가 있습니다.");
  }
  const values = searchParams.getAll("limit");
  if (values.length > 1) {
    return errorResponse(400, "invalid-limit", "limit은 한 번만 지정할 수 있습니다.");
  }
  const value = values[0];
  if (value === undefined) return 10;
  if (!/^(?:[1-9]|[1-2]\d|30)$/.test(value)) {
    return errorResponse(400, "invalid-limit", "limit은 1에서 30 사이의 정수여야 합니다.");
  }
  return Number(value);
}

function authorizeConfiguration(request: Request): Response | null {
  if (request.headers.get("X-LedgerLens-Intent") !== "configure-snapshot-schedule") {
    return errorResponse(
      428,
      "automation-intent-required",
      "자동 기록 설정에는 명시적인 configure-snapshot-schedule 요청이 필요합니다.",
    );
  }
  const origin = request.headers.get("Origin");
  let sameOrigin = false;
  try {
    sameOrigin = origin !== null && new URL(origin).origin === new URL(request.url).origin;
  } catch {
    sameOrigin = false;
  }
  if (!sameOrigin || request.headers.get("Sec-Fetch-Site") === "cross-site") {
    return errorResponse(403, "same-origin-required", "동일 출처 요청만 허용합니다.");
  }
  return null;
}

async function readBoundedJson(request: Request): Promise<{ value: unknown } | Response> {
  const mediaType = request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    return errorResponse(415, "json-required", "Content-Type은 application/json이어야 합니다.");
  }
  const contentLength = request.headers.get("Content-Length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_BODY_BYTES) {
    return errorResponse(413, "body-too-large", "요청 본문이 너무 큽니다.");
  }
  if (!request.body) return errorResponse(400, "invalid-json", "JSON 요청 본문이 필요합니다.");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        return errorResponse(413, "body-too-large", "요청 본문이 너무 큽니다.");
      }
      chunks.push(value);
    }
  } catch {
    return errorResponse(400, "invalid-json", "JSON 요청 본문을 읽을 수 없습니다.");
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { value: JSON.parse(text) as unknown };
  } catch {
    return errorResponse(400, "invalid-json", "올바른 JSON 요청 본문이 필요합니다.");
  }
}

function parseConfigurationBody(value: unknown):
  | { enabled: boolean; expectedRevision: number }
  | Response {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return errorResponse(400, "invalid-automation-request", "자동 기록 설정 형식이 올바르지 않습니다.");
  }
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "enabled" ||
    keys[1] !== "expectedRevision" ||
    typeof body.enabled !== "boolean" ||
    !Number.isSafeInteger(body.expectedRevision) ||
    Number(body.expectedRevision) < 0 ||
    Number(body.expectedRevision) > 2_147_483_647
  ) {
    return errorResponse(400, "invalid-automation-request", "자동 기록 설정 형식이 올바르지 않습니다.");
  }
  return { enabled: body.enabled, expectedRevision: Number(body.expectedRevision) };
}

function virtualSchedule(now: Date = new Date()): SnapshotScheduleView {
  return {
    enabled: false,
    timezone: AUTOMATION_TIMEZONE,
    localTime: AUTOMATION_LOCAL_TIME,
    weekdays: [1, 2, 3, 4, 5],
    revision: 0,
    updatedAt: now.toISOString(),
    triggerVerifiedAt: null,
  };
}

function statusFor(input: {
  source: "demo" | "direct" | "relay";
  accountKey: string | null;
  schedule: StoredSnapshotSchedule | null;
  runs: StoredAutomationRun[];
  nowMs?: number;
}): AutomationStatus {
  if (input.source === "demo") return "demo";
  if (input.source === "direct") return "manual-only";
  if (!input.accountKey) return "degraded";
  if (!input.schedule || !input.schedule.enabled) return "ready";
  if (input.schedule.accountKey !== input.accountKey) return "degraded";
  const latest = input.runs[0];
  if (
    latest &&
    (latest.status === "retryable-failure" || latest.status === "terminal-failure" || latest.status === "skipped")
  ) {
    return "degraded";
  }
  if (!input.schedule.triggerVerifiedAt) return "awaiting-trigger";
  const nowMs = input.nowMs ?? Date.now();
  const triggerMs = Date.parse(input.schedule.triggerVerifiedAt);
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(triggerMs) ||
    new Date(triggerMs).toISOString() !== input.schedule.triggerVerifiedAt ||
    triggerMs > nowMs + MAX_TRIGGER_FUTURE_SKEW_MS ||
    nowMs - triggerMs > TRIGGER_LIVENESS_MS
  ) {
    return "degraded";
  }
  return "scheduled";
}

export async function GET(request: Request): Promise<Response> {
  const limit = parseLimit(request);
  if (limit instanceof Response) return limit;

  const configuration = getPortfolioEnvironment();
  if (configuration.source === "demo") {
    const body: AutomationResponse = {
      source: "demo",
      status: "demo",
      relay: { configured: false, accountBound: false },
      canManageSchedule: false,
      schedule: null,
      recentRuns: [],
      lastSuccessfulRun: null,
    };
    return jsonResponse(body);
  }

  try {
    const ownerId = resolveHistoryOwner(request);
    // Demo and Direct cannot enable automation, but an existing schedule must
    // remain visible so its owner can disable it safely after a mode change.
    if (configuration.source !== "relay") {
      const schedule = await getSnapshotSchedule(ownerId);
      const [runs, lastSuccessful] = schedule
        ? await Promise.all([
            listAutomationRuns(ownerId, schedule.accountKey, limit),
            getLastSuccessfulAutomationRun(ownerId, schedule.accountKey),
          ])
        : [[], null];
      const body: AutomationResponse = {
        source: configuration.source,
        status: configuration.source === "demo" ? "demo" : "manual-only",
        relay: { configured: false, accountBound: false },
        canManageSchedule: false,
        schedule: schedule ? scheduleView(schedule) : null,
        recentRuns: runs.map(runView),
        lastSuccessfulRun: lastSuccessful ? runView(lastSuccessful) : null,
      };
      return jsonResponse(body);
    }
    const accountKey = await resolveHistoryAccountKey();
    const schedule = await getSnapshotSchedule(ownerId);
    const [runs, lastSuccessful] = schedule
      ? await Promise.all([
          listAutomationRuns(ownerId, schedule.accountKey, limit),
          getLastSuccessfulAutomationRun(ownerId, schedule.accountKey),
        ])
      : [[], null];
    const canManageSchedule = true;
    const body: AutomationResponse = {
      source: configuration.source,
      status: statusFor({ source: configuration.source, accountKey, schedule, runs }),
      relay: {
        configured: true,
        accountBound: true,
      },
      canManageSchedule,
      schedule:
        schedule !== null
          ? scheduleView(schedule)
          : configuration.source === "relay"
            ? virtualSchedule()
            : null,
      recentRuns: runs.map(runView),
      lastSuccessfulRun: lastSuccessful ? runView(lastSuccessful) : null,
    };
    return jsonResponse(body);
  } catch (error) {
    if (error instanceof HistoryIdentityError) {
      return errorResponse(error.status, error.code, error.message);
    }
    if (error instanceof AutomationStorageError) {
      return errorResponse(503, "automation-storage-unavailable", "자동 기록 상태를 불러오지 못했습니다.");
    }
    return errorResponse(503, "automation-unavailable", "자동 기록 상태를 확인하지 못했습니다.");
  }
}

export async function PUT(request: Request): Promise<Response> {
  const authorizationError = authorizeConfiguration(request);
  if (authorizationError) return authorizationError;
  if (new URL(request.url).search !== "") {
    return errorResponse(400, "query-not-allowed", "자동 기록 설정에는 쿼리 문자열을 사용할 수 없습니다.");
  }
  const parsedBody = await readBoundedJson(request);
  if (parsedBody instanceof Response) return parsedBody;
  const input = parseConfigurationBody(parsedBody.value);
  if (input instanceof Response) return input;

  const configuration = getPortfolioEnvironment();
  if (input.enabled && configuration.source !== "relay") {
    return errorResponse(
      409,
      "relay-required",
      "자동 기록을 켜려면 고정 IP 릴레이 연결이 필요합니다.",
    );
  }

  try {
    const ownerId = resolveHistoryOwner(request);
    let accountKey: string | null = null;
    if (input.enabled) {
      accountKey = await resolveHistoryAccountKey();
    }
    const result = await configureSnapshotSchedule({
      ownerId,
      accountKey,
      enabled: input.enabled,
      expectedRevision: input.expectedRevision,
    });
    return jsonResponse({ schedule: scheduleView(result.schedule), updated: result.updated });
  } catch (error) {
    if (error instanceof HistoryIdentityError) {
      return errorResponse(error.status, error.code, error.message);
    }
    if (error instanceof AutomationRevisionConflictError) {
      return errorResponse(409, "revision-conflict", "자동 기록 설정이 다른 요청에서 변경되었습니다.");
    }
    if (error instanceof AutomationScheduleNotFoundError) {
      return errorResponse(404, "schedule-not-found", "끄도록 요청한 자동 기록 설정이 없습니다.");
    }
    if (error instanceof AutomationAccountMismatchError) {
      return errorResponse(409, "automation-account-mismatch", "자동 기록 설정의 계좌 연결을 확인해 주세요.");
    }
    if (error instanceof AutomationStorageError) {
      return errorResponse(503, "automation-storage-unavailable", "자동 기록 설정을 저장하지 못했습니다.");
    }
    return errorResponse(503, "automation-unavailable", "자동 기록 설정을 변경하지 못했습니다.");
  }
}
