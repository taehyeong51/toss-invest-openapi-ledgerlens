import {
  CapitalPlanRevisionConflictError,
  CapitalPlanStorageError,
  getCapitalPlan,
  saveCapitalPlan,
} from "@/lib/planning/storage";
import { capitalPlanView, type CapitalPlanResponse } from "@/lib/planning/types";
import { CapitalPlanValidationError, parseCapitalPlan } from "@/lib/planning/validation";
import {
  HistoryIdentityError,
  resolveHistoryAccountKey,
  resolveHistoryOwner,
} from "@/lib/history/identity";
import { getPortfolioEnvironment } from "@/lib/portfolio/environment";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 2048;
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

function authorizeWrite(request: Request): Response | null {
  if (request.headers.get("X-LedgerLens-Intent") !== "update-capital-plan") {
    return errorResponse(428, "capital-plan-intent-required", "자본 계획 수정 의도를 명시해 주세요.");
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

async function readBoundedJson(request: Request): Promise<unknown | Response> {
  const mediaType = request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    return errorResponse(415, "json-required", "Content-Type은 application/json이어야 합니다.");
  }
  const length = request.headers.get("Content-Length");
  if (length && /^\d+$/.test(length) && Number(length) > MAX_BODY_BYTES) {
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
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return errorResponse(400, "invalid-json", "올바른 JSON 요청 본문이 필요합니다.");
  }
}

export async function GET(request: Request): Promise<Response> {
  if (new URL(request.url).search !== "") {
    return errorResponse(400, "query-not-allowed", "자본 계획 조회에는 쿼리 문자열을 사용할 수 없습니다.");
  }
  if (getPortfolioEnvironment().source === "demo") {
    const body: CapitalPlanResponse = { status: "demo", plan: null };
    return jsonResponse(body);
  }
  try {
    const ownerId = resolveHistoryOwner(request);
    const accountKey = await resolveHistoryAccountKey();
    const plan = await getCapitalPlan(ownerId, accountKey);
    const body: CapitalPlanResponse = {
      status: plan ? "ready" : "unconfigured",
      plan: plan ? capitalPlanView(plan) : null,
    };
    return jsonResponse(body);
  } catch (error) {
    if (error instanceof HistoryIdentityError) {
      return errorResponse(error.status, error.code, error.message);
    }
    return errorResponse(503, "capital-plan-unavailable", "자본 계획을 불러오지 못했습니다.");
  }
}

export async function PUT(request: Request): Promise<Response> {
  const authorizationError = authorizeWrite(request);
  if (authorizationError) return authorizationError;
  if (new URL(request.url).search !== "") {
    return errorResponse(400, "query-not-allowed", "자본 계획 수정에는 쿼리 문자열을 사용할 수 없습니다.");
  }
  if (getPortfolioEnvironment().source === "demo") {
    return errorResponse(409, "live-portfolio-required", "실계좌 연결 상태에서 자본 계획을 저장할 수 있습니다.");
  }
  const body = await readBoundedJson(request);
  if (body instanceof Response) return body;
  try {
    const plan = parseCapitalPlan(body);
    const ownerId = resolveHistoryOwner(request);
    const accountKey = await resolveHistoryAccountKey();
    const result = await saveCapitalPlan({ ownerId, accountKey, plan });
    return jsonResponse({ plan: capitalPlanView(result.plan), updated: result.updated });
  } catch (error) {
    if (error instanceof HistoryIdentityError) {
      return errorResponse(error.status, error.code, error.message);
    }
    if (error instanceof CapitalPlanValidationError) {
      return errorResponse(400, error.code, error.message);
    }
    if (error instanceof CapitalPlanRevisionConflictError) {
      return errorResponse(409, "revision-conflict", "자본 계획이 다른 요청에서 변경되었습니다. 새로고침 후 다시 저장해 주세요.");
    }
    if (error instanceof CapitalPlanStorageError) {
      return errorResponse(503, "capital-plan-storage-unavailable", "자본 계획을 저장하지 못했습니다.");
    }
    return errorResponse(503, "capital-plan-unavailable", "자본 계획을 변경하지 못했습니다.");
  }
}
