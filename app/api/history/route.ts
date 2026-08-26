import {
  capturePortfolioSnapshot,
  findPortfolioSnapshot,
  HistoryStorageError,
  listPortfolioSnapshots,
} from "@/lib/history/storage";
import {
  HistoryIdentityError,
  resolveHistoryAccountKey,
  resolveHistoryOwner,
} from "@/lib/history/identity";
import { loadCurrentPortfolio } from "@/lib/portfolio/loader";
import { getPortfolioEnvironment } from "@/lib/portfolio/environment";
import type { PortfolioHistoryResponse } from "@/lib/history/types";

export const dynamic = "force-dynamic";

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
  const limits = new URL(request.url).searchParams.getAll("limit");
  if (limits.length > 1) {
    return errorResponse(400, "invalid-limit", "limit은 한 번만 지정할 수 있습니다.");
  }
  const rawLimit = limits[0] ?? null;
  if (rawLimit === null) return 30;
  if (!/^(?:[1-9]|[1-9]\d|[1-2]\d{2}|3[0-5]\d|36[0-5])$/.test(rawLimit)) {
    return errorResponse(400, "invalid-limit", "limit은 1에서 365 사이의 정수여야 합니다.");
  }
  return Number(rawLimit);
}

function authorizeCapture(request: Request): Response | null {
  if (request.headers.get("X-LedgerLens-Intent") !== "capture") {
    return errorResponse(
      428,
      "capture-intent-required",
      "스냅샷 저장에는 명시적인 capture 요청이 필요합니다.",
    );
  }

  const origin = request.headers.get("Origin");
  let originMatches = false;
  try {
    originMatches = origin !== null && new URL(origin).origin === new URL(request.url).origin;
  } catch {
    originMatches = false;
  }
  if (!originMatches || request.headers.get("Sec-Fetch-Site") === "cross-site") {
    return errorResponse(403, "same-origin-required", "동일 출처 요청만 허용됩니다.");
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

export async function GET(request: Request): Promise<Response> {
  const limit = parseLimit(request);
  if (limit instanceof Response) return limit;

  // Public Demo reads contain no user data and must work without enabling the
  // owner-only history boundary or touching D1.
  if (getPortfolioEnvironment().source === "demo") {
    const body: PortfolioHistoryResponse = { snapshots: [], count: 0 };
    return jsonResponse(body);
  }

  try {
    const ownerId = resolveHistoryOwner(request);
    const accountKey = await resolveHistoryAccountKey();
    const snapshots = await listPortfolioSnapshots(ownerId, accountKey, limit);
    const body: PortfolioHistoryResponse = { snapshots, count: snapshots.length };
    return jsonResponse(body);
  } catch (error) {
    if (error instanceof HistoryIdentityError) {
      return errorResponse(error.status, error.code, error.message);
    }
    return errorResponse(
      503,
      "history-storage-unavailable",
      "포트폴리오 기록 저장소를 사용할 수 없습니다.",
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  const authorizationError = authorizeCapture(request);
  if (authorizationError) return authorizationError;
  const idempotencyKey = parseIdempotencyKey(request);
  if (idempotencyKey instanceof Response) return idempotencyKey;

  if (getPortfolioEnvironment().source === "demo") {
    return errorResponse(
      409,
      "live-portfolio-required",
      "실계좌 연결 상태에서만 스냅샷을 저장할 수 있습니다.",
    );
  }

  try {
    const ownerId = resolveHistoryOwner(request);
    const existing = await findPortfolioSnapshot(ownerId, idempotencyKey);
    if (existing) return jsonResponse({ snapshot: existing, created: false });

    // Load first so direct mode remembers the exact server-selected account;
    // this avoids a second account-list request and keeps partitioning aligned.
    const portfolio = await loadCurrentPortfolio();
    if (portfolio.mode !== "live") {
      return errorResponse(
        409,
        "live-portfolio-required",
        "실계좌 연결 상태에서만 스냅샷을 저장할 수 있습니다.",
      );
    }
    const accountKey = await resolveHistoryAccountKey();

    const result = await capturePortfolioSnapshot(portfolio, {
      ownerId,
      accountKey,
      idempotencyKey,
    });
    return jsonResponse(result, result.created ? 201 : 200);
  } catch (error) {
    if (error instanceof HistoryIdentityError) {
      return errorResponse(error.status, error.code, error.message);
    }
    if (error instanceof HistoryStorageError) {
      return errorResponse(
        503,
        "history-storage-unavailable",
        "포트폴리오 스냅샷을 저장하지 못했습니다.",
      );
    }
    return errorResponse(
      503,
      "portfolio-capture-unavailable",
      "현재 포트폴리오를 불러오지 못해 스냅샷을 저장하지 않았습니다.",
    );
  }
}
