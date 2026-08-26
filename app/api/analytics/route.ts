import {
  AnalyticsCalculationError,
  calculateModifiedDietzMetrics,
} from "@/lib/analytics/calculate";
import type { AnalyticsResponse } from "@/lib/analytics/types";
import {
  CashFlowStorageError,
  listCashFlowsForPeriod,
} from "@/lib/cashflow/storage";
import {
  HistoryIdentityError,
  resolveHistoryAccountKey,
  resolveHistoryOwner,
} from "@/lib/history/identity";
import { HistoryStorageError, listPortfolioSnapshots } from "@/lib/history/storage";
import { getPortfolioEnvironment } from "@/lib/portfolio/environment";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "Cloudflare-CDN-Cache-Control": "no-store",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
} as const;

const BASE_WARNINGS = [
  "이 수익률은 계좌로 들어오거나 나간 모든 자금을 수동으로 빠짐없이 기록했을 때만 유효한 추정치입니다.",
  "현금 흐름은 계좌 밖에서 들어오거나 계좌 밖으로 나간 자금만 뜻합니다. 매매와 환전은 현금 흐름으로 기록하지 마세요.",
  "총 추적 자산에는 주문 가능 금액이 포함되며, 주문 가능 금액을 실제 현금 잔액과 같다고 볼 수 없습니다.",
] as const;

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
  if (!/^(?:[2-9]|[1-9]\d|[1-2]\d{2}|3[0-5]\d|36[0-5])$/.test(raw)) {
    return errorResponse(400, "invalid-limit", "limit은 2에서 365 사이의 정수여야 합니다.");
  }
  return Number(raw);
}

function orderedPeriod(snapshots: Awaited<ReturnType<typeof listPortfolioSnapshots>>) {
  const ordered = [...snapshots].sort(
    (left, right) =>
      new Date(left.capturedAt).getTime() - new Date(right.capturedAt).getTime() ||
      left.id.localeCompare(right.id),
  );
  return {
    startedAt: ordered[0].capturedAt,
    endedAt: ordered[ordered.length - 1].capturedAt,
    snapshotCount: ordered.length,
  };
}

export async function GET(request: Request): Promise<Response> {
  const limit = parseLimit(request);
  if (limit instanceof Response) return limit;

  if (getPortfolioEnvironment().source === "demo") {
    const body: AnalyticsResponse = {
      status: "demo",
      period: null,
      metrics: null,
      warnings: [...BASE_WARNINGS],
    };
    return jsonResponse(body);
  }

  try {
    const ownerId = resolveHistoryOwner(request);
    const accountKey = await resolveHistoryAccountKey();
    const snapshots = await listPortfolioSnapshots(ownerId, accountKey, limit);
    if (snapshots.length < 2) {
      const body: AnalyticsResponse = {
        status: "insufficient-history",
        period: null,
        metrics: null,
        warnings: [
          ...BASE_WARNINGS,
          "수익률을 계산하려면 서로 다른 시점의 포트폴리오 스냅샷이 두 개 이상 필요합니다.",
        ],
      };
      return jsonResponse(body);
    }

    const period = orderedPeriod(snapshots);
    const cashFlows = await listCashFlowsForPeriod(
      ownerId,
      accountKey,
      period.startedAt,
      period.endedAt,
    );
    const metrics = calculateModifiedDietzMetrics(snapshots, cashFlows);
    const warnings: string[] = [...BASE_WARNINGS];
    if (metrics.modifiedDietzReturn === null) {
      warnings.push(
        "기간이 0이거나 가중 평균 투자원금이 0 이하라 수정 Dietz 수익률을 계산할 수 없습니다.",
      );
    }
    const body: AnalyticsResponse = {
      status: "ready",
      period,
      metrics,
      warnings,
    };
    return jsonResponse(body);
  } catch (error) {
    if (error instanceof HistoryIdentityError) {
      return errorResponse(error.status, error.code, error.message);
    }
    if (
      error instanceof HistoryStorageError ||
      error instanceof CashFlowStorageError ||
      error instanceof AnalyticsCalculationError
    ) {
      return errorResponse(
        503,
        "analytics-unavailable",
        "현금 흐름 조정 성과를 계산할 수 없습니다.",
      );
    }
    return errorResponse(503, "analytics-unavailable", "성과 분석을 사용할 수 없습니다.");
  }
}
