import type { CashFlowRecord } from "../cashflow/types";
import type { PortfolioSnapshotSummary } from "../history/types";
import {
  decimalAbsolute,
  decimalAdd,
  decimalCompare,
  decimalDivide,
  decimalMultiply,
  decimalSubtract,
} from "../portfolio/decimal";

const DAY_MS = 24 * 60 * 60 * 1_000;
const AVERAGE_MONTH_MS = 2_629_800_000;

export type CashFlowConfirmation = "complete" | "incomplete" | "unknown";
export type ReviewReadiness = "ready" | "check" | "blocked";

export interface PlanPaceInput {
  startAssetKrw: string;
  targetAssetKrw: string;
  currentAssetKrw: string;
  startDate: string;
  targetDate: string;
  asOf: string;
}

export interface PlanPaceResult {
  status: "before-start" | "active" | "target-date-reached";
  plannedAssetKrw: string;
  paceDifferenceKrw: string;
  targetGapKrw: string;
  requiredMonthlyContributionKrw: string | null;
  elapsedRatio: string;
  remainingDays: number;
  remainingMonths: string;
}

export interface ReviewAttributionResult {
  grossChangeKrw: string;
  netCashFlowKrw: string;
  holdingValueChangeKrw: string;
  cashAndSettlementResidualKrw: string;
  unrealizedProfitLossChangeKrw: string;
  usdKrwRateChange: string | null;
  dominant: "cash-flow" | "holding-value" | "cash-residual";
  flowCount: number;
}

export interface ReviewReliabilityInput {
  snapshotTimestamps: readonly string[];
  startedAt: string;
  endedAt: string;
  planConfigured: boolean;
  cashFlowConfirmation: CashFlowConfirmation;
}

export interface ReviewReliabilityResult {
  readiness: ReviewReadiness;
  latestSnapshotAt: string | null;
  snapshotCount: number;
  observationDays: number;
  periodDays: number;
  densityRatio: number;
  largestGapDays: number;
  gapCount: number;
  limitations: string[];
}

function kstBoundary(date: string): number {
  const timestamp = Date.parse(`${date}T00:00:00+09:00`);
  if (!Number.isFinite(timestamp)) throw new TypeError("Plan date is invalid.");
  return timestamp;
}

function isoTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new TypeError("Timestamp is invalid.");
  return timestamp;
}

function nonNegative(value: string): string {
  return decimalCompare(value, "0") > 0 ? value : "0";
}

export function calculatePlanPace(input: PlanPaceInput): PlanPaceResult {
  const startedAt = kstBoundary(input.startDate);
  const targetAt = kstBoundary(input.targetDate);
  const currentAt = isoTimestamp(input.asOf);
  if (targetAt <= startedAt) throw new RangeError("Plan target date must follow its start date.");
  if (decimalCompare(input.targetAssetKrw, input.startAssetKrw) <= 0) {
    throw new RangeError("Plan target assets must exceed starting assets.");
  }

  const clampedAt = Math.min(targetAt, Math.max(startedAt, currentAt));
  const elapsedMs = clampedAt - startedAt;
  const durationMs = targetAt - startedAt;
  const elapsedRatio = decimalDivide(String(elapsedMs), String(durationMs), 12);
  const plannedIncrease = decimalMultiply(
    decimalSubtract(input.targetAssetKrw, input.startAssetKrw),
    elapsedRatio,
  );
  const plannedAssetKrw = decimalAdd(input.startAssetKrw, plannedIncrease);
  const paceDifferenceKrw = decimalSubtract(input.currentAssetKrw, plannedAssetKrw);
  const targetGapKrw = nonNegative(decimalSubtract(input.targetAssetKrw, input.currentAssetKrw));
  const remainingMs = Math.max(0, targetAt - currentAt);
  const remainingDays = Math.ceil(remainingMs / DAY_MS);
  const remainingMonths = decimalDivide(String(remainingMs), String(AVERAGE_MONTH_MS), 6);
  const requiredMonthlyContributionKrw = remainingMs > 0 && decimalCompare(targetGapKrw, "0") > 0
    ? decimalDivide(targetGapKrw, remainingMonths, 8)
    : null;

  return {
    status: currentAt < startedAt
      ? "before-start"
      : currentAt >= targetAt
        ? "target-date-reached"
        : "active",
    plannedAssetKrw,
    paceDifferenceKrw,
    targetGapKrw,
    requiredMonthlyContributionKrw,
    elapsedRatio,
    remainingDays,
    remainingMonths,
  };
}

function signedCashFlow(flow: CashFlowRecord): string {
  return flow.kind === "contribution" ? flow.amountKrw : decimalSubtract("0", flow.amountKrw);
}

export function calculateReviewAttribution(
  snapshots: readonly PortfolioSnapshotSummary[],
  cashFlows: readonly CashFlowRecord[],
): ReviewAttributionResult {
  if (snapshots.length < 2) throw new RangeError("At least two snapshots are required.");
  const ordered = [...snapshots].sort(
    (left, right) => isoTimestamp(left.capturedAt) - isoTimestamp(right.capturedAt),
  );
  const start = ordered[0];
  const end = ordered[ordered.length - 1];
  const startedAt = isoTimestamp(start.capturedAt);
  const endedAt = isoTimestamp(end.capturedAt);
  const periodFlows = cashFlows.filter((flow) => {
    const occurredAt = isoTimestamp(flow.occurredAt);
    return occurredAt > startedAt && occurredAt <= endedAt;
  });
  const netCashFlowKrw = periodFlows.reduce(
    (sum, flow) => decimalAdd(sum, signedCashFlow(flow)),
    "0",
  );
  const grossChangeKrw = decimalSubtract(
    end.totalTrackedValueKrw,
    start.totalTrackedValueKrw,
  );
  const holdingValueChangeKrw = decimalSubtract(end.equityValueKrw, start.equityValueKrw);
  const cashAndSettlementResidualKrw = decimalSubtract(
    decimalSubtract(grossChangeKrw, holdingValueChangeKrw),
    netCashFlowKrw,
  );
  const unrealizedProfitLossChangeKrw = decimalSubtract(end.profitLossKrw, start.profitLossKrw);
  const usdKrwRateChange = decimalCompare(start.usdKrwRate, "0") > 0
    ? decimalDivide(
      decimalSubtract(end.usdKrwRate, start.usdKrwRate),
      start.usdKrwRate,
      12,
    )
    : null;
  const candidates = [
    { key: "cash-flow" as const, value: decimalAbsolute(netCashFlowKrw) },
    { key: "holding-value" as const, value: decimalAbsolute(holdingValueChangeKrw) },
    { key: "cash-residual" as const, value: decimalAbsolute(cashAndSettlementResidualKrw) },
  ];
  const dominant = candidates.reduce((largest, candidate) => (
    decimalCompare(candidate.value, largest.value) > 0 ? candidate : largest
  )).key;

  return {
    grossChangeKrw,
    netCashFlowKrw,
    holdingValueChangeKrw,
    cashAndSettlementResidualKrw,
    unrealizedProfitLossChangeKrw,
    usdKrwRateChange,
    dominant,
    flowCount: periodFlows.length,
  };
}

function calendarDay(timestamp: number): string {
  return new Date(timestamp + 9 * 60 * 60 * 1_000).toISOString().slice(0, 10);
}

export function calculateReviewReliability(
  input: ReviewReliabilityInput,
): ReviewReliabilityResult {
  const startedAt = isoTimestamp(input.startedAt);
  const endedAt = isoTimestamp(input.endedAt);
  if (endedAt < startedAt) throw new RangeError("Review period is invalid.");
  const points = input.snapshotTimestamps
    .map(isoTimestamp)
    .filter((timestamp) => timestamp >= startedAt && timestamp <= endedAt)
    .sort((left, right) => left - right);
  const observationDays = new Set(points.map(calendarDay)).size;
  const periodDays = Math.max(1, Math.ceil((endedAt - startedAt) / DAY_MS));
  const boundaries = [startedAt, ...points, endedAt];
  const gaps = boundaries.slice(1).map((value, index) => (value - boundaries[index]) / DAY_MS);
  const largestGapDays = gaps.length ? Math.max(...gaps) : periodDays;
  const gapCount = gaps.filter((days) => days > 3).length;
  const limitations: string[] = [];
  if (points.length < 2) limitations.push("비교 가능한 저장 시점이 2개 미만입니다.");
  if (input.cashFlowConfirmation === "unknown") {
    limitations.push("선택 기간의 외부 입출금 기록 완전성을 아직 확인하지 않았습니다.");
  }
  if (input.cashFlowConfirmation === "incomplete") {
    limitations.push("누락된 외부 입출금이 있어 원인 분석을 확정할 수 없습니다.");
  }
  if (!input.planConfigured) limitations.push("저장된 계획 기준이 없어 계획 페이스를 계산할 수 없습니다.");
  if (largestGapDays > 14) limitations.push("관측 사이에 14일을 넘는 저장 공백이 있습니다.");
  const readiness: ReviewReadiness = points.length < 2
    ? "blocked"
    : limitations.length
      ? "check"
      : "ready";

  return {
    readiness,
    latestSnapshotAt: points.length ? new Date(points[points.length - 1]).toISOString() : null,
    snapshotCount: points.length,
    observationDays,
    periodDays,
    densityRatio: observationDays / periodDays,
    largestGapDays,
    gapCount,
    limitations,
  };
}
