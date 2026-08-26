import type { DecimalString } from "../toss/types";

export type PortfolioMode = "demo" | "live";

export interface PortfolioAccount {
  maskedNumber: string;
  type: string;
}

export interface PortfolioSummary {
  equityValueKrw: DecimalString;
  purchaseValueKrw: DecimalString;
  profitLossKrw: DecimalString;
  /** Decimal ratio: 0.1 means 10%. */
  profitLossRate: DecimalString;
  dailyProfitLossKrw: DecimalString;
  /** Decimal ratio: 0.01 means 1%. */
  dailyProfitLossRate: DecimalString;
  buyingPowerKrw: DecimalString;
  buyingPowerUsd: DecimalString;
  /** Toss reference mid-rate, not the executable order exchange rate. */
  usdKrwRate: DecimalString;
}

export interface PortfolioAllocation {
  key: "KR" | "US" | "CASH";
  label: string;
  valueKrw: DecimalString;
  /** Decimal ratio of equity plus buying power. */
  weight: DecimalString;
  /** User target expressed as a decimal ratio. */
  targetWeight: DecimalString;
}

export interface PortfolioHolding {
  symbol: string;
  name: string;
  marketCountry: string;
  currency: string;
  quantity: DecimalString;
  lastPrice: DecimalString;
  averagePurchasePrice: DecimalString;
  marketValueNative: DecimalString;
  marketValueKrw: DecimalString;
  profitLossNative: DecimalString;
  /** Decimal ratio. */
  profitLossRate: DecimalString;
  dailyProfitLossNative: DecimalString;
  /** Decimal ratio. */
  dailyProfitLossRate: DecimalString;
}

export interface PortfolioConnection {
  configured: boolean;
  missing: string[];
}

export interface PortfolioResponse {
  mode: PortfolioMode;
  asOf: string;
  account: PortfolioAccount;
  summary: PortfolioSummary;
  allocation: PortfolioAllocation[];
  holdings: PortfolioHolding[];
  notices: string[];
  connection: PortfolioConnection;
}

export interface PortfolioErrorResponse {
  error: {
    code: string;
    message: string;
    requestId?: string;
    retryable: boolean;
  };
}
