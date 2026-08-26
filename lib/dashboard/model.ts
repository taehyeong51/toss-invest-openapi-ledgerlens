import {
  decimalAdd,
  decimalCompare,
  decimalMultiply,
  decimalSubtract,
} from "../portfolio/decimal";

export type DashboardAssetBucketKey =
  | "cash"
  | "deposits"
  | "pensionInsurance"
  | "equities"
  | "other";

export type DashboardExternalAssetKind =
  | "cash"
  | "deposit"
  | "savings"
  | "pension"
  | "insurance"
  | "property"
  | "crypto"
  | "other";

export interface DashboardAssetBucket {
  key: DashboardAssetBucketKey;
  valueKrw: string;
}

export interface DashboardAssetBreakdown {
  totalValueKrw: string;
  brokerageCashKrw: string;
  externalValueKrw: string;
  buckets: DashboardAssetBucket[];
}

interface WholeAssetGrowthReadinessInput {
  wholeAssetHistoryStatus: string;
  externalAssetsStatus: string;
  pointCount: number;
}

export function canShowWholeAssetGrowth(
  input: WholeAssetGrowthReadinessInput,
): boolean {
  return input.wholeAssetHistoryStatus === "ready"
    && input.externalAssetsStatus === "ready"
    && input.pointCount >= 2;
}

interface DashboardAssetBreakdownInput {
  portfolio: {
    equityValueKrw: string;
    buyingPowerKrw: string;
    buyingPowerUsd: string;
    usdKrwRate: string;
  };
  externalAssets: Array<{
    kind: DashboardExternalAssetKind;
    valueKrw: string;
  }>;
  externalTotalValueKrw?: string;
}

function sumExternalByKind(
  assets: DashboardAssetBreakdownInput["externalAssets"],
  kinds: ReadonlySet<DashboardExternalAssetKind>,
): string {
  return decimalAdd(
    ...assets
      .filter((asset) => kinds.has(asset.kind))
      .map((asset) => asset.valueKrw),
  );
}

export function buildDashboardAssetBreakdown(
  input: DashboardAssetBreakdownInput,
): DashboardAssetBreakdown {
  const brokerageCashKrw = decimalAdd(
    input.portfolio.buyingPowerKrw,
    decimalMultiply(
      input.portfolio.buyingPowerUsd,
      input.portfolio.usdKrwRate,
    ),
  );
  const externalCashKrw = sumExternalByKind(
    input.externalAssets,
    new Set(["cash"]),
  );
  const depositsKrw = sumExternalByKind(
    input.externalAssets,
    new Set(["deposit", "savings"]),
  );
  const pensionInsuranceKrw = sumExternalByKind(
    input.externalAssets,
    new Set(["pension", "insurance"]),
  );
  const listedOtherKrw = sumExternalByKind(
    input.externalAssets,
    new Set(["property", "crypto", "other"]),
  );
  const listedExternalValueKrw = decimalAdd(
    ...input.externalAssets.map((asset) => asset.valueKrw),
  );
  const externalValueKrw = input.externalTotalValueKrw ?? listedExternalValueKrw;
  const unlistedExternalValueKrw = decimalCompare(
    externalValueKrw,
    listedExternalValueKrw,
  ) > 0
    ? decimalSubtract(externalValueKrw, listedExternalValueKrw)
    : "0";
  const otherKrw = decimalAdd(listedOtherKrw, unlistedExternalValueKrw);
  const buckets: DashboardAssetBucket[] = [
    { key: "cash", valueKrw: decimalAdd(brokerageCashKrw, externalCashKrw) },
    { key: "deposits", valueKrw: depositsKrw },
    { key: "pensionInsurance", valueKrw: pensionInsuranceKrw },
    { key: "equities", valueKrw: input.portfolio.equityValueKrw },
    { key: "other", valueKrw: otherKrw },
  ];

  return {
    totalValueKrw: decimalAdd(...buckets.map((bucket) => bucket.valueKrw)),
    brokerageCashKrw,
    externalValueKrw,
    buckets,
  };
}
