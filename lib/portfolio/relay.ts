import { isDecimalString } from "./decimal";
import type {
  PortfolioAllocation,
  PortfolioHolding,
  PortfolioResponse,
} from "./types";

const MAX_HOLDINGS = 2_000;
const MAX_RELAY_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RELAY_AGE_MS = 5 * 60 * 1_000;
const MAX_RELAY_FUTURE_SKEW_MS = 60 * 1_000;
const MAX_RETRY_AFTER_SECONDS = 3_600;
const MASKED_ACCOUNT_PATTERN = /^(?:[•*xX]{2,})[ -]?[0-9]{4}$/u;

export class PortfolioRelayError extends Error {
  readonly code: string;
  readonly upstreamStatus: number | null;
  readonly retryAfterSeconds?: number;

  constructor(
    code: string,
    message: string,
    upstreamStatus: number | null,
    options?: ErrorOptions & { retryAfterSeconds?: number },
  ) {
    super(message, options);
    this.name = "PortfolioRelayError";
    this.code = code;
    this.upstreamStatus = upstreamStatus;
    this.retryAfterSeconds = options?.retryAfterSeconds;
  }
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PortfolioRelayError("invalid-relay-response", `Invalid relay field: ${field}.`, 502);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, maxLength = 500): string {
  const containsControlCharacter =
    typeof value === "string" &&
    Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    });
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    containsControlCharacter
  ) {
    throw new PortfolioRelayError("invalid-relay-response", `Invalid relay field: ${field}.`, 502);
  }
  return value;
}

function maskedAccountNumber(value: unknown): string {
  const maskedNumber = text(value, "account.maskedNumber", 100);
  if (!MASKED_ACCOUNT_PATTERN.test(maskedNumber)) {
    throw new PortfolioRelayError(
      "invalid-relay-response",
      "Relay account number must contain only a mask and the final four digits.",
      502,
    );
  }
  return maskedNumber;
}

function decimal(value: unknown, field: string): string {
  if (!isDecimalString(value)) {
    throw new PortfolioRelayError("invalid-relay-response", `Invalid relay decimal: ${field}.`, 502);
  }
  return value;
}

function parseHolding(value: unknown, index: number): PortfolioHolding {
  const item = object(value, `holdings.${index}`);
  return {
    symbol: text(item.symbol, `holdings.${index}.symbol`, 32),
    name: text(item.name, `holdings.${index}.name`),
    marketCountry: text(item.marketCountry, `holdings.${index}.marketCountry`, 30),
    currency: text(item.currency, `holdings.${index}.currency`, 10),
    quantity: decimal(item.quantity, `holdings.${index}.quantity`),
    lastPrice: decimal(item.lastPrice, `holdings.${index}.lastPrice`),
    averagePurchasePrice: decimal(
      item.averagePurchasePrice,
      `holdings.${index}.averagePurchasePrice`,
    ),
    marketValueNative: decimal(item.marketValueNative, `holdings.${index}.marketValueNative`),
    marketValueKrw: decimal(item.marketValueKrw, `holdings.${index}.marketValueKrw`),
    profitLossNative: decimal(item.profitLossNative, `holdings.${index}.profitLossNative`),
    profitLossRate: decimal(item.profitLossRate, `holdings.${index}.profitLossRate`),
    dailyProfitLossNative: decimal(
      item.dailyProfitLossNative,
      `holdings.${index}.dailyProfitLossNative`,
    ),
    dailyProfitLossRate: decimal(
      item.dailyProfitLossRate,
      `holdings.${index}.dailyProfitLossRate`,
    ),
  };
}

function parseAllocation(value: unknown, index: number): PortfolioAllocation {
  const item = object(value, `allocation.${index}`);
  const key = text(item.key, `allocation.${index}.key`, 10);
  if (key !== "KR" && key !== "US" && key !== "CASH") {
    throw new PortfolioRelayError("invalid-relay-response", "Invalid relay allocation key.", 502);
  }
  return {
    key,
    label: text(item.label, `allocation.${index}.label`, 100),
    valueKrw: decimal(item.valueKrw, `allocation.${index}.valueKrw`),
    weight: decimal(item.weight, `allocation.${index}.weight`),
    targetWeight: decimal(item.targetWeight, `allocation.${index}.targetWeight`),
  };
}

/**
 * Parse and copy only the public portfolio contract. Unknown relay fields are
 * intentionally discarded so a relay can never pass credentials through to
 * the browser accidentally.
 */
export function parseRelayPortfolio(
  value: unknown,
  options: { now?: () => number } = {},
): PortfolioResponse {
  const body = object(value, "response");
  if (body.mode !== "live") {
    throw new PortfolioRelayError("invalid-relay-response", "Relay must return live portfolio data.", 502);
  }
  const account = object(body.account, "account");
  const summary = object(body.summary, "summary");
  if (!Array.isArray(body.holdings) || body.holdings.length > MAX_HOLDINGS) {
    throw new PortfolioRelayError("invalid-relay-response", "Invalid relay holdings list.", 502);
  }
  if (!Array.isArray(body.allocation) || body.allocation.length !== 3) {
    throw new PortfolioRelayError("invalid-relay-response", "Invalid relay allocation list.", 502);
  }
  if (!Array.isArray(body.notices) || body.notices.length > 20) {
    throw new PortfolioRelayError("invalid-relay-response", "Invalid relay notices list.", 502);
  }

  const asOf = text(body.asOf, "asOf", 100);
  const asOfMs = Date.parse(asOf);
  if (!Number.isFinite(asOfMs) || new Date(asOfMs).toISOString() !== asOf) {
    throw new PortfolioRelayError("invalid-relay-response", "Invalid relay asOf timestamp.", 502);
  }
  const nowMs = (options.now ?? Date.now)();
  if (!Number.isFinite(nowMs)) {
    throw new TypeError("Relay clock must return a finite timestamp.");
  }
  if (asOfMs < nowMs - MAX_RELAY_AGE_MS) {
    throw new PortfolioRelayError("stale-relay-response", "Relay portfolio data is stale.", 502);
  }
  if (asOfMs > nowMs + MAX_RELAY_FUTURE_SKEW_MS) {
    throw new PortfolioRelayError(
      "future-relay-response",
      "Relay portfolio timestamp is too far in the future.",
      502,
    );
  }

  const allocation = body.allocation.map(parseAllocation);
  const allocationKeys = new Set(allocation.map((entry) => entry.key));
  if (
    allocationKeys.size !== 3 ||
    !allocationKeys.has("KR") ||
    !allocationKeys.has("US") ||
    !allocationKeys.has("CASH")
  ) {
    throw new PortfolioRelayError(
      "invalid-relay-response",
      "Relay allocation must contain exactly one KR, US, and CASH entry.",
      502,
    );
  }

  return {
    mode: "live",
    asOf,
    account: {
      maskedNumber: maskedAccountNumber(account.maskedNumber),
      type: text(account.type, "account.type", 100),
    },
    summary: {
      equityValueKrw: decimal(summary.equityValueKrw, "summary.equityValueKrw"),
      purchaseValueKrw: decimal(summary.purchaseValueKrw, "summary.purchaseValueKrw"),
      profitLossKrw: decimal(summary.profitLossKrw, "summary.profitLossKrw"),
      profitLossRate: decimal(summary.profitLossRate, "summary.profitLossRate"),
      dailyProfitLossKrw: decimal(summary.dailyProfitLossKrw, "summary.dailyProfitLossKrw"),
      dailyProfitLossRate: decimal(summary.dailyProfitLossRate, "summary.dailyProfitLossRate"),
      buyingPowerKrw: decimal(summary.buyingPowerKrw, "summary.buyingPowerKrw"),
      buyingPowerUsd: decimal(summary.buyingPowerUsd, "summary.buyingPowerUsd"),
      usdKrwRate: decimal(summary.usdKrwRate, "summary.usdKrwRate"),
    },
    allocation,
    holdings: body.holdings.map(parseHolding),
    notices: body.notices.map((notice, index) => text(notice, `notices.${index}`, 1_000)),
    connection: { configured: true, missing: [] },
  };
}

function retryAfterSeconds(value: string | null, nowMs: number): number | undefined {
  if (!value) return undefined;
  if (/^(?:0|[1-9]\d{0,9})$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) ? Math.min(seconds, MAX_RETRY_AFTER_SECONDS) : undefined;
  }

  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt)) return undefined;
  const seconds = Math.max(0, Math.ceil((retryAt - nowMs) / 1_000));
  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}

function requireJsonContentType(response: Response): void {
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new PortfolioRelayError(
      "invalid-relay-response",
      "Relay must return application/json.",
      502,
    );
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength)) {
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > MAX_RELAY_RESPONSE_BYTES) {
      throw new PortfolioRelayError(
        "relay-response-too-large",
        "Relay response exceeds the size limit.",
        502,
      );
    }
  }

  if (!response.body) {
    throw new PortfolioRelayError("invalid-relay-response", "Relay returned an empty response.", 502);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RELAY_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new PortfolioRelayError(
          "relay-response-too-large",
          "Relay response exceeds the size limit.",
          502,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    if (error instanceof PortfolioRelayError) throw error;
    throw new PortfolioRelayError("invalid-relay-response", "Relay returned invalid JSON.", 502, {
      cause: error,
    });
  }
}

export async function fetchPortfolioFromRelay(
  configuration: { url: string; token: string; accountKey: string },
  options: { fetchImplementation?: typeof fetch; timeoutMs?: number; now?: () => number } = {},
): Promise<PortfolioResponse> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImplementation(configuration.url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${configuration.token}`,
      },
      cache: "no-store",
      // Do not follow relay redirects with the bearer credential attached.
      redirect: "manual",
      signal: controller.signal,
    });
    if (!response.ok) {
      const nowMs = (options.now ?? Date.now)();
      throw new PortfolioRelayError(
        response.status === 401 || response.status === 403
          ? "relay-authentication-failed"
          : response.status >= 300 && response.status < 400
            ? "relay-redirect-rejected"
            : response.status === 429 || response.status >= 500
              ? "relay-unavailable"
              : "relay-request-failed",
        "Portfolio relay request failed.",
        response.status,
        { retryAfterSeconds: retryAfterSeconds(response.headers.get("retry-after"), nowMs) },
      );
    }

    if (response.headers.get("X-LedgerLens-Account-Ref") !== configuration.accountKey) {
      throw new PortfolioRelayError(
        "relay-account-mismatch",
        "Relay account identity did not match the configured account.",
        502,
      );
    }
    requireJsonContentType(response);
    const body = await readBoundedJson(response);
    return parseRelayPortfolio(body, { now: options.now });
  } catch (error) {
    if (error instanceof PortfolioRelayError) throw error;
    throw new PortfolioRelayError(
      controller.signal.aborted ? "relay-timeout" : "relay-network-error",
      controller.signal.aborted ? "Portfolio relay timed out." : "Portfolio relay network request failed.",
      null,
      { cause: error },
    );
  } finally {
    clearTimeout(timeout);
  }
}
