import {
  findReviewByIdempotency,
  listReviews,
  recordReview,
  ReviewIdempotencyConflictError,
  ReviewRevisionConflictError,
  ReviewStorageError,
  reviewPayloadMatches,
  updateReviewStatus,
} from "@/lib/review/storage";
import type {
  ReviewJournalCreateResponse,
  ReviewJournalListResponse,
} from "@/lib/review/types";
import {
  parseNewReviewJournalEntry,
  parseReviewStatusUpdate,
  ReviewValidationError,
} from "@/lib/review/validation";
import {
  HistoryIdentityError,
  resolveHistoryAccountKey,
  resolveHistoryOwner,
} from "@/lib/history/identity";
import { getPortfolioEnvironment } from "@/lib/portfolio/environment";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 4096;
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
  const values = new URL(request.url).searchParams.getAll("limit");
  if (values.length > 1) return errorResponse(400, "invalid-limit", "limit은 한 번만 지정할 수 있습니다.");
  const raw = values[0];
  if (raw === undefined) return 12;
  if (!/^(?:[1-9]|[1-4]\d|50)$/.test(raw)) {
    return errorResponse(400, "invalid-limit", "limit은 1에서 50 사이의 정수여야 합니다.");
  }
  return Number(raw);
}

function authorizeWrite(request: Request, intent: "record-review" | "update-review"): Response | null {
  if (request.headers.get("X-LedgerLens-Intent") !== intent) {
    return errorResponse(428, "review-intent-required", "검토 기록 변경 의도를 명시해 주세요.");
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

function parseIdempotencyKey(request: Request): string | Response {
  const key = request.headers.get("Idempotency-Key")?.trim() ?? "";
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
    return errorResponse(400, "invalid-idempotency-key", "8~128자의 유효한 Idempotency-Key가 필요합니다.");
  }
  return key;
}

async function readJson(request: Request): Promise<unknown | Response> {
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
  const limit = parseLimit(request);
  if (limit instanceof Response) return limit;
  try {
    if (getPortfolioEnvironment().source === "demo") {
      const body: ReviewJournalListResponse = { status: "demo", reviews: [], count: 0 };
      return jsonResponse(body);
    }
    const ownerId = resolveHistoryOwner(request);
    const accountKey = await resolveHistoryAccountKey();
    const reviews = await listReviews(ownerId, accountKey, limit);
    const body: ReviewJournalListResponse = { status: "ready", reviews, count: reviews.length };
    return jsonResponse(body);
  } catch (error) {
    if (error instanceof HistoryIdentityError) return errorResponse(error.status, error.code, error.message);
    return errorResponse(503, "review-storage-unavailable", "검토 기록을 불러오지 못했습니다.");
  }
}

export async function POST(request: Request): Promise<Response> {
  const authorization = authorizeWrite(request, "record-review");
  if (authorization) return authorization;
  const idempotencyKey = parseIdempotencyKey(request);
  if (idempotencyKey instanceof Response) return idempotencyKey;
  if (getPortfolioEnvironment().source === "demo") {
    return errorResponse(409, "live-portfolio-required", "실계좌 연결 상태에서 검토 기록을 저장할 수 있습니다.");
  }
  const body = await readJson(request);
  if (body instanceof Response) return body;
  try {
    const input = parseNewReviewJournalEntry(body);
    const ownerId = resolveHistoryOwner(request);
    const accountKey = await resolveHistoryAccountKey();
    const existing = await findReviewByIdempotency(ownerId, accountKey, idempotencyKey);
    if (existing) {
      if (!reviewPayloadMatches(existing, input)) {
        return errorResponse(409, "idempotency-conflict", "같은 키가 다른 검토 내용에 이미 사용되었습니다.");
      }
      const response: ReviewJournalCreateResponse = { review: existing, created: false };
      return jsonResponse(response);
    }
    const result = await recordReview(input, { ownerId, accountKey, idempotencyKey });
    const response: ReviewJournalCreateResponse = result;
    return jsonResponse(response, result.created ? 201 : 200);
  } catch (error) {
    if (error instanceof HistoryIdentityError) return errorResponse(error.status, error.code, error.message);
    if (error instanceof ReviewValidationError) return errorResponse(400, error.code, error.message);
    if (error instanceof ReviewIdempotencyConflictError) {
      return errorResponse(409, "idempotency-conflict", "같은 키가 다른 검토 내용에 이미 사용되었습니다.");
    }
    if (error instanceof ReviewStorageError) {
      return errorResponse(503, "review-storage-unavailable", "검토 기록을 저장하지 못했습니다.");
    }
    return errorResponse(503, "review-unavailable", "검토 기록을 저장하지 못했습니다.");
  }
}

export async function PATCH(request: Request): Promise<Response> {
  const authorization = authorizeWrite(request, "update-review");
  if (authorization) return authorization;
  if (getPortfolioEnvironment().source === "demo") {
    return errorResponse(409, "live-portfolio-required", "실계좌 연결 상태에서 검토 상태를 변경할 수 있습니다.");
  }
  const body = await readJson(request);
  if (body instanceof Response) return body;
  try {
    const input = parseReviewStatusUpdate(body);
    const ownerId = resolveHistoryOwner(request);
    const accountKey = await resolveHistoryAccountKey();
    const review = await updateReviewStatus({ ownerId, accountKey, ...input });
    return jsonResponse({ review });
  } catch (error) {
    if (error instanceof HistoryIdentityError) return errorResponse(error.status, error.code, error.message);
    if (error instanceof ReviewValidationError) return errorResponse(400, error.code, error.message);
    if (error instanceof ReviewRevisionConflictError) {
      return errorResponse(409, "revision-conflict", "검토 기록이 다른 요청에서 변경되었습니다. 새로고침 후 다시 시도해 주세요.");
    }
    if (error instanceof ReviewStorageError) {
      return errorResponse(503, "review-storage-unavailable", "검토 상태를 변경하지 못했습니다.");
    }
    return errorResponse(503, "review-unavailable", "검토 상태를 변경하지 못했습니다.");
  }
}
