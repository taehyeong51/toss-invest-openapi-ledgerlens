export type DecimalValue = string | number | null | undefined;

export interface AllocationItem {
  key: "KR" | "US" | "CASH" | string;
  label: string;
  valueKrw: DecimalValue;
  weight: DecimalValue;
  targetWeight: DecimalValue;
}

export interface HoldingItem {
  symbol: string;
  name: string;
  marketCountry: string;
  currency: string;
  quantity: DecimalValue;
  lastPrice: DecimalValue;
  averagePurchasePrice: DecimalValue;
  marketValueNative: DecimalValue;
  marketValueKrw: DecimalValue;
  profitLossNative: DecimalValue;
  profitLossRate: DecimalValue;
  dailyProfitLossNative: DecimalValue;
  dailyProfitLossRate: DecimalValue;
}

export interface PortfolioPayload {
  mode: "demo" | "live" | "relay";
  asOf: string;
  account: { maskedNumber: string; type: string };
  summary: {
    equityValueKrw: DecimalValue;
    purchaseValueKrw: DecimalValue;
    profitLossKrw: DecimalValue;
    profitLossRate: DecimalValue;
    dailyProfitLossKrw: DecimalValue;
    dailyProfitLossRate: DecimalValue;
    buyingPowerKrw: DecimalValue;
    buyingPowerUsd: DecimalValue;
    usdKrwRate: DecimalValue;
  };
  allocation: AllocationItem[];
  holdings: HoldingItem[];
  notices: string[];
  connection: { configured: boolean; missing: string[] };
}

export interface HistorySnapshot {
  id: string | number;
  capturedAt: string;
  equityValueKrw: DecimalValue;
  profitLossKrw: DecimalValue;
  buyingPowerKrw: DecimalValue;
  totalTrackedValueKrw: DecimalValue;
  usdKrwRate: DecimalValue;
  holdingCount: number;
}

export interface HistoryPayload {
  snapshots: HistorySnapshot[];
  count: number;
}

export interface HoldingHistoryPoint {
  snapshotId: string;
  capturedAt: string;
  quantity: string;
  lastPrice: string;
  averagePurchasePrice: string;
  marketValueNative: string;
  marketValueKrw: string;
  profitLossNative: string;
  profitLossRate: string;
  dailyProfitLossNative: string;
  dailyProfitLossRate: string;
  usdKrwRate: string;
}

export interface HoldingHistoryPayload {
  status: "demo" | "not-found" | "ready";
  holding: { symbol: string; name: string; marketCountry: string; currency: string } | null;
  points: HoldingHistoryPoint[];
  count: number;
}

export type CashFlowKind = "contribution" | "withdrawal";

export interface CashFlowEntry {
  id: string;
  occurredAt: string;
  createdAt: string;
  kind: CashFlowKind;
  amountKrw: string;
  note: string | null;
}

export interface CashFlowsPayload {
  cashFlows: CashFlowEntry[];
  count: number;
}

export type ExternalAssetKind =
  | "cash"
  | "deposit"
  | "savings"
  | "pension"
  | "insurance"
  | "property"
  | "crypto"
  | "other";

export interface ExternalAssetItem {
  id: string;
  kind: ExternalAssetKind;
  name: string;
  institution: string;
  currency: string;
  balance: string;
  valueKrw: string;
  valuedAt: string;
  maturityDate: string | null;
  annualRatePercent: string | null;
  note: string;
  source: "manual";
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalAssetsPayload {
  status: "demo" | "ready" | "unavailable";
  assets: ExternalAssetItem[];
  count: number;
  totalValueKrw: string;
  lastUpdatedAt: string | null;
}

export interface AnalyticsMetrics {
  startTrackedValueKrw: string;
  endTrackedValueKrw: string;
  grossChangeKrw: string;
  contributionsKrw: string;
  withdrawalsKrw: string;
  netCashFlowKrw: string;
  adjustedGainKrw: string;
  modifiedDietzReturn: string | null;
  flowCount: number;
}

export interface AnalyticsPayload {
  status: "demo" | "insufficient-history" | "ready";
  period: { startedAt: string; endedAt: string; snapshotCount: number } | null;
  metrics: AnalyticsMetrics | null;
  warnings: string[];
}

export type AutomationStatus =
  | "demo"
  | "manual-only"
  | "ready"
  | "awaiting-trigger"
  | "scheduled"
  | "degraded";

export interface AutomationRun {
  id: string;
  scheduledFor: string;
  status: "running" | "succeeded" | "retryable-failure" | "terminal-failure" | "skipped";
  attemptCount: number;
  startedAt: string;
  finishedAt: string | null;
  snapshotId: string | null;
  errorCode: string | null;
}

export interface AutomationSchedule {
  enabled: boolean;
  timezone: "Asia/Seoul";
  localTime: "07:10";
  weekdays: number[];
  revision: number;
  updatedAt: string;
  triggerVerifiedAt: string | null;
}

export interface AutomationPayload {
  source: "demo" | "direct" | "relay";
  status: AutomationStatus;
  relay: { configured: boolean; accountBound: boolean };
  canManageSchedule: boolean;
  schedule: AutomationSchedule | null;
  recentRuns: AutomationRun[];
  lastSuccessfulRun: AutomationRun | null;
}

export interface CapitalPlanView {
  id: string;
  startAssetKrw: string | null;
  targetAssetKrw: string;
  startDate: string;
  targetDate: string;
  monthlyContributionKrw: string;
  targetKrWeight: string;
  targetUsWeight: string;
  targetCashWeight: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface CapitalPlanPayload {
  status: "demo" | "unconfigured" | "ready";
  plan: CapitalPlanView | null;
}

export type ReviewCashFlowConfirmation = "complete" | "incomplete";
export type ReviewActionStatus = "open" | "resolved";

export interface ReviewJournalEntry {
  id: string;
  periodStartedAt: string;
  periodEndedAt: string;
  cashFlowConfirmation: ReviewCashFlowConfirmation;
  action: string;
  status: ReviewActionStatus;
  snapshotCount: number;
  planRevision: number | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface ReviewJournalPayload {
  status: "demo" | "ready";
  reviews: ReviewJournalEntry[];
  count: number;
}
