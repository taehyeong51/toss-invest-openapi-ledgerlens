import type { DecimalString } from "../toss/types";
import { decimalAdd, decimalMultiply } from "./decimal";

export interface TrackedValueSummary {
  equityValueKrw: DecimalString;
  buyingPowerKrw: DecimalString;
  buyingPowerUsd: DecimalString;
  usdKrwRate: DecimalString;
}

/** One exact definition shared by live views and immutable history snapshots. */
export function calculateTotalTrackedValueKrw(summary: TrackedValueSummary): DecimalString {
  return decimalAdd(
    summary.equityValueKrw,
    summary.buyingPowerKrw,
    decimalMultiply(summary.buyingPowerUsd, summary.usdKrwRate),
  );
}
