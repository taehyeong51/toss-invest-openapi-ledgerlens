import type { CashFlowRecord } from "../cashflow/types";
import type { PortfolioSnapshotSummary } from "../history/types";
import {
  decimalAdd,
  decimalDivide,
  decimalIsZero,
  decimalMultiply,
  decimalSubtract,
  isDecimalString,
} from "../portfolio/decimal";
import type { ModifiedDietzMetrics } from "./types";

export class AnalyticsCalculationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalyticsCalculationError";
  }
}

function timestamp(value: string, field: string): number {
  const parsed = new Date(value);
  const milliseconds = parsed.getTime();
  if (!Number.isFinite(milliseconds) || parsed.toISOString() !== value) {
    throw new AnalyticsCalculationError(`${field} contains an invalid timestamp.`);
  }
  return milliseconds;
}

function decimal(value: unknown, field: string): string {
  if (!isDecimalString(value)) {
    throw new AnalyticsCalculationError(`${field} contains an invalid decimal.`);
  }
  return value;
}

function negative(value: string): string {
  return decimalSubtract("0", value);
}

function isPositive(value: string): boolean {
  return !decimalIsZero(value) && !value.startsWith("-");
}

/**
 * Calculates a cash-flow-adjusted Modified Dietz estimate using exact decimal
 * string operations. Time-weighting remains an integer ratio until the single
 * final division, avoiding floating-point and intermediate rounding.
 */
export function calculateModifiedDietzMetrics(
  snapshots: readonly PortfolioSnapshotSummary[],
  cashFlows: readonly CashFlowRecord[],
): ModifiedDietzMetrics {
  if (snapshots.length < 2) {
    throw new AnalyticsCalculationError("At least two snapshots are required.");
  }

  const orderedSnapshots = [...snapshots].sort(
    (left, right) =>
      timestamp(left.capturedAt, "snapshot.capturedAt") -
        timestamp(right.capturedAt, "snapshot.capturedAt") ||
      left.id.localeCompare(right.id),
  );
  const start = orderedSnapshots[0];
  const end = orderedSnapshots[orderedSnapshots.length - 1];
  const startedAtMs = timestamp(start.capturedAt, "start.capturedAt");
  const endedAtMs = timestamp(end.capturedAt, "end.capturedAt");
  const durationMs = endedAtMs - startedAtMs;

  const startTrackedValueKrw = decimal(
    start.totalTrackedValueKrw,
    "start.totalTrackedValueKrw",
  );
  const endTrackedValueKrw = decimal(
    end.totalTrackedValueKrw,
    "end.totalTrackedValueKrw",
  );
  const grossChangeKrw = decimalSubtract(endTrackedValueKrw, startTrackedValueKrw);

  let contributionsKrw = "0";
  let withdrawalsKrw = "0";
  let weightedSignedFlowsKrwMs = "0";
  let flowCount = 0;

  for (const flow of cashFlows) {
    const occurredAtMs = timestamp(flow.occurredAt, "cashFlow.occurredAt");
    // The route queries this boundary in SQL; retaining it here makes the pure
    // function safe for direct callers and deterministic tests.
    if (occurredAtMs <= startedAtMs || occurredAtMs > endedAtMs) continue;
    const amountKrw = decimal(flow.amountKrw, "cashFlow.amountKrw");
    if (!isPositive(amountKrw)) {
      throw new AnalyticsCalculationError("Cash-flow amounts must be positive.");
    }
    if (flow.kind === "contribution") {
      contributionsKrw = decimalAdd(contributionsKrw, amountKrw);
    } else if (flow.kind === "withdrawal") {
      withdrawalsKrw = decimalAdd(withdrawalsKrw, amountKrw);
    } else {
      throw new AnalyticsCalculationError("Cash flow contains an invalid kind.");
    }

    const signedAmount = flow.kind === "contribution" ? amountKrw : negative(amountKrw);
    const remainingMs = endedAtMs - occurredAtMs;
    weightedSignedFlowsKrwMs = decimalAdd(
      weightedSignedFlowsKrwMs,
      decimalMultiply(signedAmount, String(remainingMs)),
    );
    flowCount += 1;
  }

  const netCashFlowKrw = decimalSubtract(contributionsKrw, withdrawalsKrw);
  const adjustedGainKrw = decimalSubtract(grossChangeKrw, netCashFlowKrw);

  let modifiedDietzReturn: string | null = null;
  if (durationMs > 0) {
    // R = gain / (start + sum(weight_i * signed_flow_i)). Multiplying both
    // numerator and denominator by duration keeps all math exact until here.
    const numeratorKrwMs = decimalMultiply(adjustedGainKrw, String(durationMs));
    const denominatorKrwMs = decimalAdd(
      decimalMultiply(startTrackedValueKrw, String(durationMs)),
      weightedSignedFlowsKrwMs,
    );
    if (isPositive(denominatorKrwMs)) {
      modifiedDietzReturn = decimalDivide(numeratorKrwMs, denominatorKrwMs, 12);
    }
  }

  return {
    startTrackedValueKrw,
    endTrackedValueKrw,
    grossChangeKrw,
    contributionsKrw,
    withdrawalsKrw,
    netCashFlowKrw,
    adjustedGainKrw,
    modifiedDietzReturn,
    flowCount,
  };
}
