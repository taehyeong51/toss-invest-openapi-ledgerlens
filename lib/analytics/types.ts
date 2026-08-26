import type { DecimalString } from "../toss/types";

export type AnalyticsStatus = "demo" | "insufficient-history" | "ready";

export interface AnalyticsPeriod {
  startedAt: string;
  endedAt: string;
  snapshotCount: number;
}

export interface ModifiedDietzMetrics {
  startTrackedValueKrw: DecimalString;
  endTrackedValueKrw: DecimalString;
  grossChangeKrw: DecimalString;
  contributionsKrw: DecimalString;
  withdrawalsKrw: DecimalString;
  netCashFlowKrw: DecimalString;
  adjustedGainKrw: DecimalString;
  /** Decimal ratio: `0.05` represents a 5% estimated return. */
  modifiedDietzReturn: DecimalString | null;
  flowCount: number;
}

export interface AnalyticsResponse {
  status: AnalyticsStatus;
  period: AnalyticsPeriod | null;
  metrics: ModifiedDietzMetrics | null;
  warnings: string[];
}
