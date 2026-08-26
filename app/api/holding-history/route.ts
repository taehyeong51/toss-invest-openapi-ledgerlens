import {
  HistoryIdentityError,
  resolveHistoryAccountKey,
  resolveHistoryOwner,
} from "@/lib/history/identity";
import {
  HistoryStorageError,
  listPortfolioHoldingHistory,
} from "@/lib/history/storage";
import type {
  PortfolioHoldingHistoryResponse,
  PortfolioHoldingHistorySelector,
} from "@/lib/history/types";
import { getPortfolioEnvironment } from "@/lib/portfolio/environment";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "Cloudflare-CDN-Cache-Control": "no-store",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
} as const;

const ALLOWED_QUERY_PARAMETERS = new Set([
  "symbol",
  "marketCountry",
  "currency",
  "limit",
]);

function jsonResponse<T>(body: T, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE_HEADERS });
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message, retryable: status >= 500 } }, status);
}

type ParsedHoldingHistoryQuery = {
  selector: PortfolioHoldingHistorySelector;
  limit: number;
};

function parseQuery(request: Request): ParsedHoldingHistoryQuery | Response {
  const parameters = new URL(request.url).searchParams;
  for (const key of parameters.keys()) {
    if (!ALLOWED_QUERY_PARAMETERS.has(key)) {
      return errorResponse(400, "invalid-query", "지원하지 않는 조회 조건입니다.");
    }
  }

  const symbols = parameters.getAll("symbol");
  if (symbols.length !== 1 || !/^[A-Za-z0-9.-]{1,32}$/.test(symbols[0])) {
    return errorResponse(400, "invalid-symbol", "유효한 종목 코드가 하나 필요합니다.");
  }

  const marketCountries = parameters.getAll("marketCountry");
  if (
    marketCountries.length !== 1 ||
    !/^[A-Z][A-Z0-9_-]{0,29}$/.test(marketCountries[0])
  ) {
    return errorResponse(400, "invalid-market-country", "유효한 시장 국가가 하나 필요합니다.");
  }

  const currencies = parameters.getAll("currency");
  if (
    currencies.length !== 1 ||
    !/^[A-Z][A-Z0-9_-]{0,9}$/.test(currencies[0])
  ) {
    return errorResponse(400, "invalid-currency", "유효한 통화 코드가 하나 필요합니다.");
  }

  const limits = parameters.getAll("limit");
  if (limits.length > 1) {
    return errorResponse(400, "invalid-limit", "limit은 한 번만 지정할 수 있습니다.");
  }
  const rawLimit = limits[0];
  if (
    rawLimit !== undefined &&
    !/^(?:[1-9]|[1-9]\d|[1-2]\d{2}|3[0-5]\d|36[0-5])$/.test(rawLimit)
  ) {
    return errorResponse(400, "invalid-limit", "limit은 1에서 365 사이의 정수여야 합니다.");
  }

  return {
    selector: {
      symbol: symbols[0],
      marketCountry: marketCountries[0],
      currency: currencies[0],
    },
    limit: rawLimit === undefined ? 90 : Number(rawLimit),
  };
}

export async function GET(request: Request): Promise<Response> {
  const query = parseQuery(request);
  if (query instanceof Response) return query;

  try {
    const ownerId = resolveHistoryOwner(request);
    if (getPortfolioEnvironment().source === "demo") {
      const body: PortfolioHoldingHistoryResponse = {
        status: "demo",
        holding: null,
        points: [],
        count: 0,
      };
      return jsonResponse(body);
    }

    const accountKey = await resolveHistoryAccountKey();
    const history = await listPortfolioHoldingHistory(
      ownerId,
      accountKey,
      query.selector,
      query.limit,
    );
    const body: PortfolioHoldingHistoryResponse = {
      status: history.holding ? "ready" : "not-found",
      holding: history.holding,
      points: history.points,
      count: history.points.length,
    };
    return jsonResponse(body);
  } catch (error) {
    if (error instanceof HistoryIdentityError) {
      return errorResponse(error.status, error.code, error.message);
    }
    if (error instanceof HistoryStorageError) {
      return errorResponse(
        503,
        "holding-history-unavailable",
        "보유 종목 히스토리 저장소를 조회할 수 없습니다.",
      );
    }
    return errorResponse(
      503,
      "holding-history-unavailable",
      "현재 보유 종목 히스토리를 사용할 수 없습니다.",
    );
  }
}
