import { TossApiError, tossErrorFromResponse } from "./errors";
import type {
  Currency,
  TossAccount,
  TossApiEnvelope,
  TossBuyingPower,
  TossExchangeRate,
  TossHoldingsOverview,
  TossOAuthTokenResponse,
  TossPrice,
} from "./types";

export const TOSS_OPEN_API_BASE_URL = "https://openapi.tossinvest.com";
const MAX_PRICE_SYMBOLS = 200;
const MAX_TOTAL_PRICE_SYMBOLS = 2_000;
const MAX_SYMBOL_LENGTH = 32;
const SYMBOL_PATTERN = /^[A-Za-z0-9.-]+$/;

type FetchImplementation = typeof fetch;

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
  refreshLeewayMs: number;
}

interface TokenSlot {
  token: CachedToken | null;
  refreshPromise: Promise<CachedToken> | null;
}

interface ClientTokenSlot {
  clientSecret: string;
  slot: TokenSlot;
}

// Toss permits one valid token per client. Sharing this slot by client ID
// prevents concurrent refreshes inside one server runtime from invalidating
// each other. Multi-instance deployments still need a distributed token
// manager; the recommended deployment is a single fixed-egress relay.
const tokenSlots = new Map<string, ClientTokenSlot>();

export interface TossClientOptions {
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
  fetchImplementation?: FetchImplementation;
  timeoutMs?: number;
  now?: () => number;
}

function validateBaseUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  const officialOrigin = new URL(TOSS_OPEN_API_BASE_URL).origin;
  if (url.origin !== officialOrigin && !localHttp) {
    throw new TypeError("Toss API base URL must use the official origin (or loopback for tests). ");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function requireCredential(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} is required.`);
  }
  return value;
}

function requireAccountSeq(accountSeq: number): string {
  if (!Number.isSafeInteger(accountSeq) || accountSeq < 0) {
    throw new TypeError("accountSeq must be a non-negative safe integer.");
  }
  return String(accountSeq);
}

function requireCurrency(currency: "KRW" | "USD"): Currency {
  if (currency !== "KRW" && currency !== "USD") {
    throw new TypeError("currency must be KRW or USD.");
  }
  return currency;
}

function requireSymbol(symbol: string): string {
  if (
    typeof symbol !== "string" ||
    symbol.length === 0 ||
    symbol.length > MAX_SYMBOL_LENGTH ||
    !SYMBOL_PATTERN.test(symbol)
  ) {
    throw new TypeError("Invalid stock symbol.");
  }
  return symbol;
}

function getTokenSlot(clientId: string, clientSecret: string): TokenSlot {
  const existing = tokenSlots.get(clientId);
  if (existing?.clientSecret === clientSecret) return existing.slot;

  const slot: TokenSlot = { token: null, refreshPromise: null };
  tokenSlots.set(clientId, { clientSecret, slot });
  return slot;
}

function isTokenResponse(value: unknown): value is TossOAuthTokenResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<TossOAuthTokenResponse>;
  return (
    typeof candidate.access_token === "string" &&
    candidate.access_token.length > 0 &&
    typeof candidate.token_type === "string" &&
    candidate.token_type.toLowerCase() === "bearer" &&
    typeof candidate.expires_in === "number" &&
    Number.isFinite(candidate.expires_in) &&
    candidate.expires_in > 0
  );
}

function isEnvelope<T>(value: unknown): value is TossApiEnvelope<T> {
  return Boolean(value && typeof value === "object" && "result" in value);
}

export class TossClient {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly baseUrl: string;
  private readonly fetchImplementation: FetchImplementation;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly tokenSlot: TokenSlot;

  constructor(options: TossClientOptions) {
    this.clientId = requireCredential(options.clientId, "Toss client ID");
    this.clientSecret = requireCredential(options.clientSecret, "Toss client secret");
    this.baseUrl = validateBaseUrl(options.baseUrl ?? TOSS_OPEN_API_BASE_URL);
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.now = options.now ?? Date.now;
    this.tokenSlot = getTokenSlot(this.clientId, this.clientSecret);

    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 250 || this.timeoutMs > 60_000) {
      throw new RangeError("Toss request timeout must be between 250 and 60000 milliseconds.");
    }
  }

  async getAccounts(): Promise<TossAccount[]> {
    return this.get<TossAccount[]>("/api/v1/accounts");
  }

  async getHoldings(accountSeq: number, symbol?: string): Promise<TossHoldingsOverview> {
    const query = new URLSearchParams();
    if (symbol !== undefined) {
      query.set("symbol", requireSymbol(symbol));
    }

    return this.get<TossHoldingsOverview>(
      `/api/v1/holdings${query.size > 0 ? `?${query.toString()}` : ""}`,
      accountSeq,
    );
  }

  async getPrices(symbols: readonly string[]): Promise<TossPrice[]> {
    if (symbols.length > MAX_TOTAL_PRICE_SYMBOLS) {
      throw new RangeError(`A price request is limited to ${MAX_TOTAL_PRICE_SYMBOLS} total symbols.`);
    }
    const uniqueSymbols = Array.from(new Set(symbols));
    if (uniqueSymbols.length === 0) return [];
    for (const symbol of uniqueSymbols) {
      requireSymbol(symbol);
    }

    const chunks: string[][] = [];
    for (let index = 0; index < uniqueSymbols.length; index += MAX_PRICE_SYMBOLS) {
      chunks.push(uniqueSymbols.slice(index, index + MAX_PRICE_SYMBOLS));
    }

    // Keep chunks sequential. The endpoint allows 10 TPS, and a portfolio can
    // span multiple chunks; sequential requests avoid an unnecessary burst.
    const prices: TossPrice[] = [];
    for (const chunk of chunks) {
      const query = new URLSearchParams({ symbols: chunk.join(",") });
      prices.push(...(await this.get<TossPrice[]>(`/api/v1/prices?${query.toString()}`)));
    }
    return prices;
  }

  async getUsdKrwExchangeRate(dateTime?: string): Promise<TossExchangeRate> {
    const query = new URLSearchParams({ baseCurrency: "USD", quoteCurrency: "KRW" });
    if (dateTime !== undefined) {
      const parsed = Date.parse(dateTime);
      if (!Number.isFinite(parsed)) throw new TypeError("dateTime must be an ISO date-time.");
      query.set("dateTime", dateTime);
    }
    return this.get<TossExchangeRate>(`/api/v1/exchange-rate?${query.toString()}`);
  }

  async getBuyingPower(
    accountSeq: number,
    currency: "KRW" | "USD",
  ): Promise<TossBuyingPower> {
    const query = new URLSearchParams({ currency: requireCurrency(currency) });
    return this.get<TossBuyingPower>(`/api/v1/buying-power?${query.toString()}`, accountSeq);
  }

  private async get<T>(path: string, accountSeq?: number): Promise<T> {
    const token = await this.getAccessToken();
    let response = await this.fetchWithTimeout(new URL(path, this.baseUrl), {
      method: "GET",
      headers: this.requestHeaders(token, accountSeq),
      cache: "no-store",
      // Workers supports manual redirects but intentionally rejects `error`.
      // Manual mode also prevents forwarding credentials to another origin.
      redirect: "manual",
    });

    if (response.status === 401) {
      this.invalidateToken(token);
      const refreshedToken = await this.getAccessToken();
      response = await this.fetchWithTimeout(new URL(path, this.baseUrl), {
        method: "GET",
        headers: this.requestHeaders(refreshedToken, accountSeq),
        cache: "no-store",
        redirect: "manual",
      });
    }

    if (!response.ok) throw await tossErrorFromResponse(response);

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new TossApiError({
        code: "invalid-json",
        message: "Toss API returned invalid JSON.",
        upstreamStatus: response.status,
        cause: error,
      });
    }

    if (!isEnvelope<T>(body)) {
      throw new TossApiError({
        code: "invalid-response",
        message: "Toss API returned an invalid response envelope.",
        upstreamStatus: response.status,
      });
    }
    return body.result;
  }

  private requestHeaders(token: string, accountSeq?: number): Headers {
    const headers = new Headers({
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    });
    if (accountSeq !== undefined) {
      headers.set("X-Tossinvest-Account", requireAccountSeq(accountSeq));
    }
    return headers;
  }

  private invalidateToken(accessToken: string): void {
    if (this.tokenSlot.token?.accessToken === accessToken) {
      this.tokenSlot.token = null;
    }
  }

  private async getAccessToken(): Promise<string> {
    const cached = this.tokenSlot.token;
    if (cached && this.now() < cached.expiresAtMs - cached.refreshLeewayMs) {
      return cached.accessToken;
    }

    if (!this.tokenSlot.refreshPromise) {
      this.tokenSlot.refreshPromise = this.issueAccessToken();
    }

    try {
      const token = await this.tokenSlot.refreshPromise;
      this.tokenSlot.token = token;
      return token.accessToken;
    } finally {
      this.tokenSlot.refreshPromise = null;
    }
  }

  private async issueAccessToken(): Promise<CachedToken> {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });
    const response = await this.fetchWithTimeout(new URL("/oauth2/token", this.baseUrl), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      cache: "no-store",
      redirect: "manual",
    });

    if (!response.ok) throw await tossErrorFromResponse(response);

    let tokenResponse: unknown;
    try {
      tokenResponse = await response.json();
    } catch (error) {
      throw new TossApiError({
        code: "invalid-token-response",
        message: "Toss OAuth returned invalid JSON.",
        upstreamStatus: response.status,
        cause: error,
      });
    }
    if (!isTokenResponse(tokenResponse)) {
      throw new TossApiError({
        code: "invalid-token-response",
        message: "Toss OAuth returned an invalid token response.",
        upstreamStatus: response.status,
      });
    }

    const lifetimeMs = tokenResponse.expires_in * 1_000;
    const refreshLeewayMs = Math.min(60_000, Math.max(500, Math.floor(lifetimeMs * 0.1)));
    return {
      accessToken: tokenResponse.access_token,
      expiresAtMs: this.now() + lifetimeMs,
      refreshLeewayMs,
    };
  }

  private async fetchWithTimeout(input: URL, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      return await this.fetchImplementation(input, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new TossApiError({
          code: "timeout",
          message: "Toss API request timed out.",
          upstreamStatus: null,
          cause: error,
        });
      }
      throw new TossApiError({
        code: "network-error",
        message: "Toss API network request failed.",
        upstreamStatus: null,
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
