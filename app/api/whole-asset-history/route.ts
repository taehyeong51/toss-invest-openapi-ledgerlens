import {
  buildWholeAssetHistory,
  createDemoWholeAssetHistory,
} from "@/lib/assets/history";
import {
  ExternalAssetStorageError,
  listExternalAssetSnapshots,
} from "@/lib/assets/storage";
import {
  HistoryIdentityError,
  resolveHistoryAccountKey,
  resolveHistoryOwner,
} from "@/lib/history/identity";
import {
  HistoryStorageError,
  listPortfolioSnapshots,
} from "@/lib/history/storage";
import { getPortfolioEnvironment } from "@/lib/portfolio/environment";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "Cloudflare-CDN-Cache-Control": "no-store",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
} as const;
const DEFAULT_MONTHS = 24;
const MAX_SOURCE_ROWS = 10_000;

function jsonResponse<T>(body: T, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE_HEADERS });
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse(
    { error: { code, message, retryable: status >= 500 } },
    status,
  );
}

function parseMonths(request: Request): number | Response {
  const values = new URL(request.url).searchParams.getAll("months");
  if (values.length > 1) {
    return errorResponse(
      400,
      "invalid-months",
      "months는 한 번만 지정할 수 있습니다.",
    );
  }
  const raw = values[0];
  if (raw === undefined) return DEFAULT_MONTHS;
  if (!/^(?:[1-9]|[1-5]\d|60)$/.test(raw)) {
    return errorResponse(
      400,
      "invalid-months",
      "months는 1에서 60 사이의 정수여야 합니다.",
    );
  }
  return Number(raw);
}

export async function GET(request: Request): Promise<Response> {
  const months = parseMonths(request);
  if (months instanceof Response) return months;

  try {
    if (getPortfolioEnvironment().source === "demo") {
      return jsonResponse(createDemoWholeAssetHistory());
    }

    const ownerId = resolveHistoryOwner(request);
    const accountKey = await resolveHistoryAccountKey();
    const [portfolioRows, externalRows] = await Promise.all([
      listPortfolioSnapshots(ownerId, accountKey, MAX_SOURCE_ROWS + 1),
      listExternalAssetSnapshots(ownerId, accountKey, MAX_SOURCE_ROWS + 1),
    ]);
    const warnings: string[] = [];
    if (portfolioRows.length > MAX_SOURCE_ROWS) {
      warnings.push(
        "포트폴리오 원본 이력이 조회 한도에 도달해 가장 오래된 일부 기록을 제외했습니다.",
      );
    }
    if (externalRows.length > MAX_SOURCE_ROWS) {
      warnings.push(
        "외부 자산 원본 이력이 조회 한도에 도달해 가장 오래된 일부 기록을 제외했습니다.",
      );
    }

    return jsonResponse(
      buildWholeAssetHistory(
        portfolioRows.slice(0, MAX_SOURCE_ROWS),
        externalRows.slice(0, MAX_SOURCE_ROWS),
        months,
        warnings,
      ),
    );
  } catch (error) {
    if (error instanceof HistoryIdentityError) {
      return errorResponse(error.status, error.code, error.message);
    }
    if (
      error instanceof HistoryStorageError ||
      error instanceof ExternalAssetStorageError
    ) {
      return errorResponse(
        503,
        "whole-asset-history-storage-unavailable",
        "전체 자산 이력 저장소를 읽을 수 없습니다.",
      );
    }
    return errorResponse(
      503,
      "whole-asset-history-unavailable",
      "전체 자산 이력을 계산하지 못했습니다.",
    );
  }
}
