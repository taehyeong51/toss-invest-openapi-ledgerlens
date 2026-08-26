import { TossApiError } from "@/lib/toss/errors";
import { loadCurrentPortfolio } from "@/lib/portfolio/loader";
import { getPortfolioEnvironment } from "@/lib/portfolio/environment";
import { PortfolioRelayError } from "@/lib/portfolio/relay";
import { PortfolioBuildError } from "@/lib/portfolio/service";
import type { PortfolioErrorResponse } from "@/lib/portfolio/types";
import { HistoryIdentityError, resolveHistoryOwner } from "@/lib/history/identity";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "Cloudflare-CDN-Cache-Control": "no-store",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
} as const;

function jsonResponse<T>(body: T, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(NO_STORE_HEADERS);
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  }
  return Response.json(body, { status, headers });
}

function errorResponse(error: unknown): Response {
  let status = 500;
  let code = "portfolio-unavailable";
  let message = "포트폴리오를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.";
  let retryable = false;
  let requestId: string | undefined;
  let retryAfterSeconds: number | undefined;

  if (error instanceof TossApiError) {
    requestId = error.requestId;
    retryAfterSeconds = error.retryAfterSeconds;
    if (error.code === "timeout") {
      status = 504;
      code = "toss-timeout";
      message = "토스증권 응답 시간이 초과되었습니다.";
      retryable = true;
    } else if (error.code === "network-error") {
      status = 503;
      code = "toss-network-error";
      message = "토스증권에 연결할 수 없습니다.";
      retryable = true;
    } else if (error.upstreamStatus === 401) {
      status = 502;
      code = "toss-authentication-failed";
      message = "토스증권 API 인증을 확인해 주세요.";
    } else if (error.upstreamStatus === 403) {
      status = 502;
      code = "toss-ip-not-allowed";
      message = "이 서버의 고정 IP가 토스증권 허용 목록에 등록되어 있는지 확인해 주세요.";
    } else if (error.upstreamStatus === 429) {
      status = 503;
      code = "toss-rate-limited";
      message = "토스증권 조회 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.";
      retryable = true;
    } else if ((error.upstreamStatus ?? 0) >= 500) {
      status = 503;
      code = "toss-unavailable";
      retryable = true;
    } else {
      status = 502;
      code = "toss-request-failed";
    }
  } else if (error instanceof PortfolioRelayError) {
    status = error.code === "relay-timeout" ? 504 : 503;
    code = error.code;
    retryAfterSeconds = error.retryAfterSeconds;
    message =
      error.code === "relay-authentication-failed"
        ? "포트폴리오 릴레이 인증을 확인해 주세요."
        : "안전한 포트폴리오 릴레이에 연결할 수 없습니다.";
    retryable = ["relay-timeout", "relay-network-error", "relay-unavailable"].includes(error.code);
  } else if (error instanceof PortfolioBuildError) {
    status = error.status;
    code = error.code;
    message =
      error.status === 404
        ? "조회 가능한 토스증권 계좌를 찾지 못했습니다."
        : "토스증권 응답을 안전하게 해석하지 못했습니다.";
  } else if (error instanceof HistoryIdentityError) {
    status = error.status;
    code = "portfolio-owner-required";
    message = "인증된 개인 배포에서만 실계좌 포트폴리오를 볼 수 있습니다.";
  } else if (error instanceof TypeError || error instanceof RangeError) {
    code = "server-configuration-error";
    message = "서버의 포트폴리오 연결 설정을 확인해 주세요.";
  }

  const body: PortfolioErrorResponse = {
    error: { code, message, retryable, ...(requestId ? { requestId } : {}) },
  };
  const retryHeaders =
    retryable && retryAfterSeconds !== undefined
      ? { "Retry-After": String(retryAfterSeconds) }
      : undefined;
  return jsonResponse(body, status, retryHeaders);
}

export async function GET(request: Request): Promise<Response> {
  try {
    const configuration = getPortfolioEnvironment();
    if (configuration.source !== "demo") void resolveHistoryOwner(request);
    return jsonResponse(await loadCurrentPortfolio());
  } catch (error) {
    return errorResponse(error);
  }
}
