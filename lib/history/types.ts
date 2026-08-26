import type { DecimalString } from "../toss/types";

export interface PortfolioSnapshotSummary {
  id: string;
  capturedAt: string;
  equityValueKrw: DecimalString;
  profitLossKrw: DecimalString;
  buyingPowerKrw: DecimalString;
  totalTrackedValueKrw: DecimalString;
  usdKrwRate: DecimalString;
  holdingCount: number;
}

export interface PortfolioHistoryResponse {
  snapshots: PortfolioSnapshotSummary[];
  count: number;
}

export interface PortfolioCaptureResponse {
  snapshot: PortfolioSnapshotSummary;
  created: boolean;
}

export interface PortfolioHoldingHistoryIdentity {
  symbol: string;
  name: string;
  marketCountry: string;
  currency: string;
}

export type PortfolioHoldingHistorySelector = Omit<
  PortfolioHoldingHistoryIdentity,
  "name"
>;

/** One exact, immutable holding value copied from its parent portfolio snapshot. */
export interface PortfolioHoldingHistoryPoint {
  snapshotId: string;
  capturedAt: string;
  quantity: DecimalString;
  lastPrice: DecimalString;
  averagePurchasePrice: DecimalString;
  marketValueNative: DecimalString;
  marketValueKrw: DecimalString;
  profitLossNative: DecimalString;
  profitLossRate: DecimalString;
  dailyProfitLossNative: DecimalString;
  dailyProfitLossRate: DecimalString;
  usdKrwRate: DecimalString;
}

export type PortfolioHoldingHistoryStatus = "demo" | "not-found" | "ready";

export interface PortfolioHoldingHistoryResponse {
  status: PortfolioHoldingHistoryStatus;
  holding: PortfolioHoldingHistoryIdentity | null;
  /** Newest snapshot first, matching the portfolio history endpoint. */
  points: PortfolioHoldingHistoryPoint[];
  count: number;
}
