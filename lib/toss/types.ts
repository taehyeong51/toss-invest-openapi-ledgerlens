/**
 * Toss OpenAPI 1.2.14 represents monetary values, quantities, prices, and
 * rates as JSON strings. Keep them as strings at the transport boundary so
 * JavaScript binary floating point never silently changes an account value.
 */
export type DecimalString = string;

/** Toss asks clients to tolerate future enum values. */
export type Currency = "KRW" | "USD" | (string & {});
export type MarketCountry = "KR" | "US" | (string & {});
export type AccountType =
  | "BROKERAGE"
  | "OVERSEAS_DERIVATIVES"
  | "PENSION_SAVINGS"
  | "RESHORING_INVESTMENT"
  | (string & {});

export interface TossApiEnvelope<T> {
  result: T;
}

export interface TossApiErrorBody {
  error?: {
    requestId?: unknown;
    code?: unknown;
    message?: unknown;
    data?: unknown;
  };
}

export interface TossOAuthErrorBody {
  error?: unknown;
  error_description?: unknown;
}

export interface TossOAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export interface TossAccount {
  accountNo: string;
  accountSeq: number;
  accountType: AccountType;
}

export interface TossPriceByCurrency {
  krw: DecimalString;
  usd?: DecimalString | null;
}

export interface TossOverviewMarketValue {
  amount: TossPriceByCurrency;
  amountAfterCost: TossPriceByCurrency;
}

export interface TossOverviewProfitLoss {
  amount: TossPriceByCurrency;
  amountAfterCost: TossPriceByCurrency;
  /** Decimal ratio: 0.1516 means 15.16%. */
  rate: DecimalString;
  /** Decimal ratio after estimated costs. */
  rateAfterCost: DecimalString;
}

export interface TossOverviewDailyProfitLoss {
  amount: TossPriceByCurrency;
  /** Decimal ratio: 0.0185 means 1.85%. */
  rate: DecimalString;
}

export interface TossMarketValue {
  purchaseAmount: DecimalString;
  amount: DecimalString;
  amountAfterCost: DecimalString;
}

export interface TossProfitLoss {
  amount: DecimalString;
  amountAfterCost: DecimalString;
  /** Decimal ratio. */
  rate: DecimalString;
  /** Decimal ratio after estimated costs. */
  rateAfterCost: DecimalString;
}

export interface TossDailyProfitLoss {
  amount: DecimalString;
  /** Decimal ratio. */
  rate: DecimalString;
}

export interface TossCost {
  commission: DecimalString;
  tax?: DecimalString | null;
}

export interface TossHolding {
  symbol: string;
  name: string;
  marketCountry: MarketCountry;
  currency: Currency;
  quantity: DecimalString;
  lastPrice: DecimalString;
  averagePurchasePrice: DecimalString;
  marketValue: TossMarketValue;
  profitLoss: TossProfitLoss;
  dailyProfitLoss: TossDailyProfitLoss;
  cost: TossCost;
}

export interface TossHoldingsOverview {
  totalPurchaseAmount: TossPriceByCurrency;
  marketValue: TossOverviewMarketValue;
  profitLoss: TossOverviewProfitLoss;
  dailyProfitLoss: TossOverviewDailyProfitLoss;
  items: TossHolding[];
}

export interface TossPrice {
  symbol: string;
  timestamp?: string | null;
  lastPrice: DecimalString;
  currency: Currency;
}

export interface TossExchangeRate {
  baseCurrency: Currency;
  quoteCurrency: Currency;
  /** Customer buy rate. */
  rate: DecimalString;
  /** Interbank reference rate used for portfolio normalization. */
  midRate: DecimalString;
  basisPoint: DecimalString;
  rateChangeType: "UP" | "EQUAL" | "DOWN" | (string & {});
  validFrom: string;
  validUntil: string;
}

export interface TossBuyingPower {
  currency: Currency;
  /** Cash-based buying power; this is not an account cash ledger. */
  cashBuyingPower: DecimalString;
}
