import type { DecimalString } from "../toss/types";
import {
  decimalAdd,
  decimalCompare,
  decimalDivide,
  decimalIsZero,
} from "../portfolio/decimal";
import type { ExternalAssetRecord } from "./types";

export const EXTERNAL_ASSET_STALE_AFTER_DAYS = 45;
export const EXTERNAL_ASSET_MATURITY_WINDOW_DAYS = 30;

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const KOREA_STANDARD_TIME_OFFSET_MS = 9 * 60 * 60 * 1_000;
const CASH_LIKE_KINDS = new Set(["cash", "deposit", "savings"]);

export type ExternalAssetDiagnosticCode =
  | "maturity-overdue"
  | "maturity-due-soon"
  | "valuation-stale";

export type ExternalAssetDiagnosticSeverity = "warning" | "attention";

export interface ExternalAssetDiagnosticIssue {
  code: ExternalAssetDiagnosticCode;
  severity: ExternalAssetDiagnosticSeverity;
  assetId: string;
  assetName: string;
  message: string;
  valuedAt: string;
  dueDate: string | null;
  daysSinceValuation: number | null;
  daysUntilMaturity: number | null;
}

export interface LargestExternalAssetFact {
  assetId: string;
  name: string;
  valueKrw: DecimalString;
  /** Rounded half away from zero to at most 12 fractional digits. */
  share: DecimalString;
}

export interface ExternalAssetDiagnostics {
  asOf: string;
  staleAfterDays: number;
  maturityWindowDays: number;
  analyzedCount: number;
  assetCount: number;
  activeAssetCount: number;
  staleCount: number;
  maturityDueSoonCount: number;
  maturityOverdueCount: number;
  totalValueKrw: DecimalString;
  cashLikeValueKrw: DecimalString;
  usdValueKrw: DecimalString;
  largestAsset: LargestExternalAssetFact | null;
  issues: ExternalAssetDiagnosticIssue[];
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leapYear ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function assertCalendarDate(value: string, label: string): [number, number, number] {
  const match = value.match(CALENDAR_DATE);
  if (!match) {
    throw new TypeError(`${label} must be a YYYY-MM-DD calendar date.`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month)
  ) {
    throw new TypeError(`${label} must be a real YYYY-MM-DD calendar date.`);
  }
  return [year, month, day];
}

/**
 * Maps a civil date to a monotonically increasing day number without invoking
 * the host timezone. This keeps all freshness and maturity boundaries based on
 * Korean calendar dates rather than elapsed 24-hour windows.
 */
function calendarDayNumber(value: string, label: string): number {
  const [year, month, day] = assertCalendarDate(value, label);
  const adjustedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const adjustedMonth = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * adjustedMonth + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 +
    Math.floor(yearOfEra / 4) -
    Math.floor(yearOfEra / 100) +
    dayOfYear;
  return era * 146_097 + dayOfEra;
}

function koreaCalendarDate(now: Date | string): string {
  if (typeof now === "string" && CALENDAR_DATE.test(now)) {
    assertCalendarDate(now, "now");
    return now;
  }

  const instant = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(instant.getTime())) {
    throw new TypeError("now must be a valid instant or YYYY-MM-DD calendar date.");
  }
  return new Date(instant.getTime() + KOREA_STANDARD_TIME_OFFSET_MS)
    .toISOString()
    .slice(0, 10);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareLargestCandidate(
  left: ExternalAssetRecord,
  right: ExternalAssetRecord,
): number {
  const valueOrder = decimalCompare(right.valueKrw, left.valueKrw);
  if (valueOrder !== 0) return valueOrder;
  return compareText(left.name, right.name) || compareText(left.id, right.id);
}

const ISSUE_ORDER: Record<ExternalAssetDiagnosticCode, number> = {
  "maturity-overdue": 0,
  "maturity-due-soon": 1,
  "valuation-stale": 2,
};

function compareIssues(
  left: ExternalAssetDiagnosticIssue,
  right: ExternalAssetDiagnosticIssue,
): number {
  const codeOrder = ISSUE_ORDER[left.code] - ISSUE_ORDER[right.code];
  if (codeOrder !== 0) return codeOrder;

  const leftDate = left.dueDate ?? left.valuedAt;
  const rightDate = right.dueDate ?? right.valuedAt;
  return (
    compareText(leftDate, rightDate) ||
    compareText(left.assetName, right.assetName) ||
    compareText(left.assetId, right.assetId)
  );
}

/**
 * Derives review facts from the latest external-asset ledger state.
 * Zero-value revisions are treated as closed assets: they remain in counts and
 * totals but do not create stale-valuation or maturity follow-ups.
 */
export function calculateExternalAssetDiagnostics(
  assets: ExternalAssetRecord[],
  now: Date | string = new Date(),
): ExternalAssetDiagnostics {
  const asOfDate = koreaCalendarDate(now);
  const asOfDay = calendarDayNumber(asOfDate, "now");
  const activeAssets = assets.filter((asset) => !decimalIsZero(asset.valueKrw));

  const totalValueKrw = decimalAdd(...assets.map((asset) => asset.valueKrw));
  const cashLikeValueKrw = decimalAdd(
    ...assets
      .filter((asset) => CASH_LIKE_KINDS.has(asset.kind))
      .map((asset) => asset.valueKrw),
  );
  const usdValueKrw = decimalAdd(
    ...assets
      .filter((asset) => asset.currency === "USD")
      .map((asset) => asset.valueKrw),
  );

  const issues: ExternalAssetDiagnosticIssue[] = [];
  for (const asset of activeAssets) {
    const valuedAtDay = calendarDayNumber(asset.valuedAt, "asset.valuedAt");
    const daysSinceValuation = asOfDay - valuedAtDay;
    if (daysSinceValuation > EXTERNAL_ASSET_STALE_AFTER_DAYS) {
      issues.push({
        code: "valuation-stale",
        severity: "attention",
        assetId: asset.id,
        assetName: asset.name,
        message: `${asset.name}의 평가액이 ${daysSinceValuation}일 전에 확인되었습니다.`,
        valuedAt: asset.valuedAt,
        dueDate: null,
        daysSinceValuation,
        daysUntilMaturity: null,
      });
    }

    if (asset.maturityDate) {
      const daysUntilMaturity =
        calendarDayNumber(asset.maturityDate, "asset.maturityDate") - asOfDay;
      if (daysUntilMaturity < 0) {
        issues.push({
          code: "maturity-overdue",
          severity: "warning",
          assetId: asset.id,
          assetName: asset.name,
          message: `${asset.name}의 만기일이 ${Math.abs(daysUntilMaturity)}일 지났습니다.`,
          valuedAt: asset.valuedAt,
          dueDate: asset.maturityDate,
          daysSinceValuation: null,
          daysUntilMaturity,
        });
      } else if (daysUntilMaturity <= EXTERNAL_ASSET_MATURITY_WINDOW_DAYS) {
        issues.push({
          code: "maturity-due-soon",
          severity: "attention",
          assetId: asset.id,
          assetName: asset.name,
          message:
            daysUntilMaturity === 0
              ? `${asset.name}의 만기일이 오늘입니다.`
              : `${asset.name}의 만기일까지 ${daysUntilMaturity}일 남았습니다.`,
          valuedAt: asset.valuedAt,
          dueDate: asset.maturityDate,
          daysSinceValuation: null,
          daysUntilMaturity,
        });
      }
    }
  }
  issues.sort(compareIssues);

  const largest = activeAssets.slice().sort(compareLargestCandidate)[0] ?? null;
  const largestAsset = largest && !decimalIsZero(totalValueKrw)
    ? {
        assetId: largest.id,
        name: largest.name,
        valueKrw: largest.valueKrw,
        share: decimalDivide(largest.valueKrw, totalValueKrw, 12),
      }
    : null;

  return {
    asOf: asOfDate,
    staleAfterDays: EXTERNAL_ASSET_STALE_AFTER_DAYS,
    maturityWindowDays: EXTERNAL_ASSET_MATURITY_WINDOW_DAYS,
    analyzedCount: activeAssets.length,
    assetCount: assets.length,
    activeAssetCount: activeAssets.length,
    staleCount: issues.filter((issue) => issue.code === "valuation-stale").length,
    maturityDueSoonCount: issues.filter((issue) => issue.code === "maturity-due-soon").length,
    maturityOverdueCount: issues.filter((issue) => issue.code === "maturity-overdue").length,
    totalValueKrw,
    cashLikeValueKrw,
    usdValueKrw,
    largestAsset,
    issues,
  };
}
