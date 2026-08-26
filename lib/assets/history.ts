import type { PortfolioSnapshotSummary } from "../history/types";
import { decimalAdd, decimalCompare } from "../portfolio/decimal";
import type { DecimalString } from "../toss/types";
import type { ExternalAssetSnapshotRecord } from "./storage";

const KST_OFFSET_MS = 9 * 60 * 60 * 1_000;

export interface WholeAssetHistoryPoint {
  month: string;
  /** The portfolio observation used for this month. */
  observedAt: string;
  portfolioValueKrw: DecimalString;
  externalValueKrw: DecimalString;
  totalRegisteredValueKrw: DecimalString;
  activeExternalAssetCount: number;
  latestExternalValuedAt: string | null;
  portfolioCarriedForward: boolean;
}

export type WholeAssetHistoryStatus = "demo" | "insufficient-history" | "ready";

export interface WholeAssetHistoryPayload {
  status: WholeAssetHistoryStatus;
  points: WholeAssetHistoryPoint[];
  count: number;
  scope: {
    performanceIncluded: false;
    historicalScope: "registered-as-of-observation";
  };
  warnings: string[];
}

const HISTORY_SCOPE = {
  performanceIncluded: false,
  historicalScope: "registered-as-of-observation",
} as const;

function kstMonthFromTimestamp(value: string): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    throw new TypeError("Portfolio history contains an invalid timestamp.");
  }
  return new Date(timestamp + KST_OFFSET_MS).toISOString().slice(0, 7);
}

function parseMonth(month: string): { year: number; monthIndex: number } {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) {
    throw new TypeError("Asset history contains an invalid month.");
  }
  return {
    year: Number(month.slice(0, 4)),
    monthIndex: Number(month.slice(5, 7)) - 1,
  };
}

function formatMonth(year: number, monthIndex: number): string {
  return `${year.toString().padStart(4, "0")}-${(monthIndex + 1)
    .toString()
    .padStart(2, "0")}`;
}

function nextMonth(month: string): string {
  const parsed = parseMonth(month);
  const next = new Date(Date.UTC(parsed.year, parsed.monthIndex + 1, 1));
  return formatMonth(next.getUTCFullYear(), next.getUTCMonth());
}

function monthEndExclusiveUtc(month: string): number {
  const parsed = parseMonth(month);
  return Date.UTC(parsed.year, parsed.monthIndex + 1, 1) - KST_OFFSET_MS;
}

function lastCalendarDate(month: string): string {
  const parsed = parseMonth(month);
  const last = new Date(Date.UTC(parsed.year, parsed.monthIndex + 1, 0));
  return `${month}-${last.getUTCDate().toString().padStart(2, "0")}`;
}

function listMonths(first: string, last: string): string[] {
  if (first > last) return [];
  const months: string[] = [];
  let current = first;
  while (current <= last) {
    months.push(current);
    current = nextMonth(current);
  }
  return months;
}

function selectPortfolioSnapshot(
  snapshots: PortfolioSnapshotSummary[],
  month: string,
): PortfolioSnapshotSummary | null {
  const cutoff = monthEndExclusiveUtc(month);
  let selected: PortfolioSnapshotSummary | null = null;
  let selectedTime = Number.NEGATIVE_INFINITY;
  for (const snapshot of snapshots) {
    const timestamp = new Date(snapshot.capturedAt).getTime();
    if (!Number.isFinite(timestamp)) {
      throw new TypeError("Portfolio history contains an invalid timestamp.");
    }
    if (
      timestamp < cutoff &&
      (timestamp > selectedTime ||
        (timestamp === selectedTime && selected !== null && snapshot.id > selected.id))
    ) {
      selected = snapshot;
      selectedTime = timestamp;
    }
  }
  return selected;
}

function isLaterExternalRevision(
  candidate: ExternalAssetSnapshotRecord,
  selected: ExternalAssetSnapshotRecord,
): boolean {
  if (candidate.valuedAt !== selected.valuedAt) {
    return candidate.valuedAt > selected.valuedAt;
  }
  if (candidate.revision !== selected.revision) {
    return candidate.revision > selected.revision;
  }
  return candidate.capturedAt > selected.capturedAt;
}

function selectExternalSnapshots(
  snapshots: ExternalAssetSnapshotRecord[],
  month: string,
): ExternalAssetSnapshotRecord[] {
  const lastDate = lastCalendarDate(month);
  const cutoff = monthEndExclusiveUtc(month);
  const selectedByAsset = new Map<string, ExternalAssetSnapshotRecord>();
  for (const snapshot of snapshots) {
    const capturedAt = new Date(snapshot.capturedAt).getTime();
    if (!Number.isFinite(capturedAt)) {
      throw new TypeError("External-asset history contains an invalid timestamp.");
    }
    if (snapshot.valuedAt > lastDate || capturedAt >= cutoff) continue;
    const selected = selectedByAsset.get(snapshot.assetId);
    if (!selected || isLaterExternalRevision(snapshot, selected)) {
      selectedByAsset.set(snapshot.assetId, snapshot);
    }
  }
  return [...selectedByAsset.values()];
}

function uniqueWarnings(warnings: string[]): string[] {
  return [...new Set(warnings)];
}

export function createDemoWholeAssetHistory(): WholeAssetHistoryPayload {
  return {
    status: "demo",
    points: [],
    count: 0,
    scope: HISTORY_SCOPE,
    warnings: ["데모 모드에서는 개인 자산 이력을 저장하지 않습니다."],
  };
}

/**
 * Reconstructs monthly registered assets without treating the result as
 * investment performance. Portfolio values are carried forward only after a
 * real portfolio observation. Manual assets must have both been captured and
 * valued by month-end, so a later-entered correction never rewrites what the
 * app knew in a closed month. Among revisions known at that point, a later
 * valuation date wins and an equal date uses the higher revision.
 */
export function buildWholeAssetHistory(
  portfolioSnapshots: PortfolioSnapshotSummary[],
  externalSnapshots: ExternalAssetSnapshotRecord[],
  months: number,
  additionalWarnings: string[] = [],
): WholeAssetHistoryPayload {
  if (!Number.isInteger(months) || months < 1 || months > 60) {
    throw new RangeError("Whole-asset history months must be between 1 and 60.");
  }

  const warnings = [
    "등록 자산 추이는 입력된 평가액과 등록 범위의 변화를 보여 주며 투자 수익률이 아닙니다.",
    ...additionalWarnings,
  ];

  if (portfolioSnapshots.length === 0) {
    warnings.push("전체 자산 추이를 시작하려면 포트폴리오 스냅샷이 필요합니다.");
    return {
      status: "insufficient-history",
      points: [],
      count: 0,
      scope: HISTORY_SCOPE,
      warnings: uniqueWarnings(warnings),
    };
  }

  const portfolioMonths = portfolioSnapshots.map((snapshot) =>
    kstMonthFromTimestamp(snapshot.capturedAt),
  );
  const firstMonth = portfolioMonths.reduce((earliest, month) =>
    month < earliest ? month : earliest,
  );
  const lastPortfolioMonth = portfolioMonths.reduce((latest, month) =>
    month > latest ? month : latest,
  );
  const lastExternalMonth = externalSnapshots.reduce((latest, snapshot) => {
    const month = kstMonthFromTimestamp(snapshot.capturedAt);
    return month > latest ? month : latest;
  }, firstMonth);
  const lastMonth = lastExternalMonth > lastPortfolioMonth
    ? lastExternalMonth
    : lastPortfolioMonth;
  const selectedMonths = listMonths(firstMonth, lastMonth).slice(-months);

  const points: WholeAssetHistoryPoint[] = [];
  for (const month of selectedMonths) {
    const portfolio = selectPortfolioSnapshot(portfolioSnapshots, month);
    if (!portfolio) continue;

    const external = selectExternalSnapshots(externalSnapshots, month);
    const externalValueKrw = external.reduce(
      (total, snapshot) => decimalAdd(total, snapshot.valueKrw),
      "0",
    );
    const latestExternalValuedAt = external.reduce<string | null>(
      (latest, snapshot) =>
        latest === null || snapshot.valuedAt > latest ? snapshot.valuedAt : latest,
      null,
    );
    points.push({
      month,
      observedAt: portfolio.capturedAt,
      portfolioValueKrw: portfolio.totalTrackedValueKrw,
      externalValueKrw,
      totalRegisteredValueKrw: decimalAdd(
        portfolio.totalTrackedValueKrw,
        externalValueKrw,
      ),
      activeExternalAssetCount: external.filter(
        (snapshot) => decimalCompare(snapshot.valueKrw, "0") !== 0,
      ).length,
      latestExternalValuedAt,
      portfolioCarriedForward: kstMonthFromTimestamp(portfolio.capturedAt) !== month,
    });
  }

  if (points.some((point) => point.portfolioCarriedForward)) {
    warnings.push("일부 월의 증권 자산은 직전 포트폴리오 스냅샷을 이월했습니다.");
  }
  if (points.length < 2) {
    warnings.push("월별 비교에는 두 개 이상의 관측 월이 필요합니다.");
  }

  return {
    status: points.length >= 2 ? "ready" : "insufficient-history",
    points,
    count: points.length,
    scope: HISTORY_SCOPE,
    warnings: uniqueWarnings(warnings),
  };
}
