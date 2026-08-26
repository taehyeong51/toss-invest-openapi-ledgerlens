import { getPortfolioEnvironment } from "@/lib/portfolio/environment";
import { loadCurrentPortfolio } from "@/lib/portfolio/loader";
import { parseRelayPortfolio, PortfolioRelayError } from "@/lib/portfolio/relay";
import { PortfolioBuildError } from "@/lib/portfolio/service";
import type { PortfolioErrorResponse } from "@/lib/portfolio/types";
import { TossApiError } from "@/lib/toss/errors";

export const dynamic = "force-dynamic";

const ACCOUNT_REF_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const MIN_SHARED_TOKEN_LENGTH = 32;
const MAX_SHARED_TOKEN_LENGTH = 512;
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

function relayError(
  status: number,
  code: string,
  message: string,
  retryable = false,
  extraHeaders?: HeadersInit,
): Response {
  const body: PortfolioErrorResponse = {
    error: { code, message, retryable },
  };
  return jsonResponse(body, status, extraHeaders);
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([digest(left), digest(right)]);
  let difference = 0;
  for (let index = 0; index < leftDigest.length; index += 1) {
    difference |= leftDigest[index] ^ rightDigest[index];
  }
  return difference === 0;
}

async function isAuthorized(request: Request): Promise<boolean> {
  const authorization = request.headers.get("Authorization") ?? "";
  const separator = authorization.indexOf(" ");
  const scheme = separator >= 0 ? authorization.slice(0, separator) : "";
  const candidate = separator >= 0 ? authorization.slice(separator + 1) : "";
  const expected = process.env.LEDGERLENS_RELAY_SHARED_TOKEN ?? "";

  const candidateIsValid =
    scheme.toLowerCase() === "bearer" &&
    candidate.length >= MIN_SHARED_TOKEN_LENGTH &&
    candidate.length <= MAX_SHARED_TOKEN_LENGTH &&
    !/\s/u.test(candidate);
  const expectedIsValid =
    expected.length >= MIN_SHARED_TOKEN_LENGTH &&
    expected.length <= MAX_SHARED_TOKEN_LENGTH &&
    !/\s/u.test(expected);

  const candidateForComparison = candidateIsValid ? candidate : "invalid-presented-token";
  const expectedForComparison = expectedIsValid ? expected : "invalid-configured-token";
  const matches = await constantTimeEqual(candidateForComparison, expectedForComparison);
  return candidateIsValid && expectedIsValid && matches;
}

function safeRetryAfter(error: TossApiError): string | undefined {
  const seconds = error.retryAfterSeconds;
  return Number.isSafeInteger(seconds) && seconds !== undefined && seconds >= 0 && seconds <= 3_600
    ? String(seconds)
    : undefined;
}

function mappedPortfolioError(error: unknown): Response {
  if (error instanceof TossApiError) {
    if (error.code === "timeout") {
      return relayError(504, "toss-timeout", "The Toss API timed out.", true);
    }
    if (error.code === "network-error") {
      return relayError(503, "toss-network-error", "The Toss API is temporarily unreachable.", true);
    }
    if (error.upstreamStatus === 401) {
      return relayError(424, "toss-authentication-failed", "The Toss API rejected relay authentication.");
    }
    if (error.upstreamStatus === 403) {
      return relayError(424, "toss-ip-not-allowed", "The Toss API rejected the relay network origin.");
    }
    if (error.upstreamStatus === 429) {
      const retryAfter = safeRetryAfter(error);
      return relayError(
        503,
        "toss-rate-limited",
        "The Toss API rate limit was reached.",
        true,
        retryAfter ? { "Retry-After": retryAfter } : undefined,
      );
    }
    if ((error.upstreamStatus ?? 0) >= 500) {
      const retryAfter = safeRetryAfter(error);
      return relayError(
        503,
        "toss-unavailable",
        "The Toss API is temporarily unavailable.",
        true,
        retryAfter ? { "Retry-After": retryAfter } : undefined,
      );
    }
    return relayError(424, "toss-request-failed", "The Toss API request failed.");
  }

  if (error instanceof PortfolioBuildError || error instanceof PortfolioRelayError) {
    return relayError(424, "invalid-portfolio-response", "The portfolio response was invalid.");
  }

  if (error instanceof TypeError || error instanceof RangeError) {
    return relayError(422, "relay-configuration-error", "The relay is not configured correctly.");
  }

  return relayError(503, "relay-unavailable", "The relay is temporarily unavailable.", true);
}

export async function GET(request: Request): Promise<Response> {
  // Authentication deliberately precedes every request and configuration
  // check so unauthenticated callers cannot probe relay state.
  if (!(await isAuthorized(request))) {
    return relayError(
      401,
      "relay-authentication-required",
      "A valid relay bearer credential is required.",
      false,
      { "WWW-Authenticate": 'Bearer realm="ledgerlens-relay"' },
    );
  }

  if (new URL(request.url).search !== "") {
    return relayError(400, "relay-query-not-allowed", "This relay endpoint does not accept query parameters.");
  }

  try {
    const configuration = getPortfolioEnvironment();
    if (configuration.source !== "direct") {
      return relayError(
        422,
        "relay-direct-mode-required",
        "The relay must be connected directly to the Toss API.",
      );
    }

    const accountRef = process.env.LEDGERLENS_RELAY_ACCOUNT_REF ?? "";
    if (!ACCOUNT_REF_PATTERN.test(accountRef)) {
      return relayError(
        422,
        "relay-account-ref-required",
        "The relay account identity is not configured correctly.",
      );
    }

    const portfolio = await loadCurrentPortfolio();
    if (portfolio.mode !== "live") {
      return relayError(424, "relay-live-data-required", "The relay could not load live portfolio data.");
    }

    // Re-parse the normalized public contract before crossing the relay
    // boundary. This strips unknown fields and rejects unmasked account data.
    const publicPortfolio = parseRelayPortfolio(portfolio);
    return jsonResponse(publicPortfolio, 200, {
      "X-LedgerLens-Account-Ref": accountRef,
    });
  } catch (error) {
    return mappedPortfolioError(error);
  }
}
