import {
  CashFlowIdempotencyConflictError,
  CashFlowStorageError,
  cashFlowPayloadMatches,
  findCashFlow,
  listCashFlows,
  recordCashFlow,
} from "@/lib/cashflow/storage";
import type {
  CashFlowCreateResponse,
  CashFlowListResponse,
} from "@/lib/cashflow/types";
import {
  CashFlowValidationError,
  parseManualCashFlow,
} from "@/lib/cashflow/validation";
import {
  HistoryIdentityError,
  resolveHistoryAccountKey,
  resolveHistoryOwner,
} from "@/lib/history/identity";
import { getPortfolioEnvironment } from "@/lib/portfolio/environment";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "Cloudflare-CDN-Cache-Control": "no-store",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
} as const;
const MAX_BODY_BYTES = 4096;

function jsonResponse<T>(body: T, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE_HEADERS });
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message, retryable: status >= 500 } }, status);
}

function parseLimit(request: Request): number | Response {
  const limits = new URL(request.url).searchParams.getAll("limit");
  if (limits.length > 1) {
    return errorResponse(400, "invalid-limit", "limit은 한 번만 지정할 수 있습니다.");
  }
  const raw = limits[0];
  if (raw === undefined) return 30;
  if (!/^(?:[1-9]|[1-9]\d|[1-2]\d{2}|3[0-5]\d|36[0-5])$/.test(raw)) {
    return errorResponse(400, "invalid-limit", "limit은 1에서 365 사이의 정수여야 합니다.");
  }
  return Number(raw);
}

function authorizeWrite(request: Request): Response | null {
  if (request.headers.get("X-LedgerLens-Intent") !== "record-cash-flow") {
    return errorResponse(
      428,
      "cash-flow-intent-required",
      "현금 흐름 기록에는 명시적인 record-cash-flow 요청이 필요합니다.",
    );
  }

  const suppliedOrigin = request.headers.get("Origin");
  let sameOrigin = false;
  try {
    sameOrigin =
      suppliedOrigin !== null &&
      new URL(suppliedOrigin).origin === new URL(request.url).origin;
  } catch {
    sameOrigin = false;
  }
  if (!sameOrigin || request.headers.get("Sec-Fetch-Site") === "cross-site") {
    return errorResponse(403, "same-origin-required", "동일 출처 요청만 허용합니다.");
  }
  return null;
}

function parseIdempotencyKey(request: Request): string | Response {
  const key = request.headers.get("Idempotency-Key")?.trim() ?? "";
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
    return errorResponse(
      400,
      "invalid-idempotency-key",
      "8~128자의 유효한 Idempotency-Key가 필요합니다.",
    );
  }
  return key;
}

async function readJsonBody(request: Request): Promise<{ value: unknown } | Response> {
  const mediaType = request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    return errorResponse(415, "json-required", "Content-Type은 application/json이어야 합니다.");
  }

  const contentLength = request.headers.get("Content-Length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_BODY_BYTES) {
    return errorResponse(413, "body-too-large", "요청 본문이 너무 큽니다.");
  }
  if (!request.body) {
    return errorResponse(400, "invalid-json", "JSON 요청 본문이 필요합니다.");
  }

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

export async function GET(request: Request): Promise<Response> {
  const limit = parseLimit(request);
  if (limit instanceof Response) return limit;

  if (getPortfolioEnvironment().source === "demo") {
    const body: CashFlowListResponse = { cashFlows: [], count: 0 };
    return jsonResponse(body);
  }

  try {
    const ownerId = resolveHistoryOwner(request);
    const accountKey = await resolveHistoryAccountKey();
    const cashFlows = await listCashFlows(ownerId, accountKey, limit);
    const body: CashFlowListResponse = { cashFlows, count: cashFlows.length };
    return jsonResponse(body);
  } catch (error) {
    if (error instanceof HistoryIdentityError) {
      return errorResponse(error.status, error.code, error.message);
    }
    return errorResponse(
      503,
      "cash-flow-storage-unavailable",
      "현금 흐름 저장소를 사용할 수 없습니다.",
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  const authorizationError = authorizeWrite(request);
  if (authorizationError) return authorizationError;
  const idempotencyKey = parseIdempotencyKey(request);
  if (idempotencyKey instanceof Response) return idempotencyKey;

  if (getPortfolioEnvironment().source === "demo") {
    return errorResponse(
      409,
      "live-portfolio-required",
      "실계좌 연결 상태에서만 현금 흐름을 기록할 수 있습니다.",
    );
  }

  try {
    const ownerId = resolveHistoryOwner(request);
    const parsedBody = await readJsonBody(request);
    if (parsedBody instanceof Response) return parsedBody;
    const input = parseManualCashFlow(parsedBody.value);
    const accountKey = await resolveHistoryAccountKey();
    const existing = await findCashFlow(ownerId, accountKey, idempotencyKey);
    if (existing) {
      if (!cashFlowPayloadMatches(existing, input)) {
        return errorResponse(
          409,
          "idempotency-conflict",
          "같은 Idempotency-Key가 다른 현금 흐름 내용에 이미 사용되었습니다.",
        );
      }
      const body: CashFlowCreateResponse = { cashFlow: existing, created: false };
      return jsonResponse(body);
    }

    const result = await recordCashFlow(input, {
      ownerId,
      accountKey,
      idempotencyKey,
    });
    const body: CashFlowCreateResponse = result;
    return jsonResponse(body, result.created ? 201 : 200);
  } catch (error) {
    if (error instanceof HistoryIdentityError) {
      return errorResponse(error.status, error.code, error.message);
    }
    if (error instanceof CashFlowValidationError) {
      return errorResponse(400, error.code, error.message);
    }
    if (error instanceof CashFlowIdempotencyConflictError) {
      return errorResponse(
        409,
        "idempotency-conflict",
        "같은 Idempotency-Key가 다른 현금 흐름 내용에 이미 사용되었습니다.",
      );
    }
    if (error instanceof CashFlowStorageError) {
      return errorResponse(
        503,
        "cash-flow-storage-unavailable",
        "현금 흐름을 저장하지 못했습니다.",
      );
    }
    return errorResponse(503, "cash-flow-unavailable", "현금 흐름을 기록하지 못했습니다.");
  }
}
