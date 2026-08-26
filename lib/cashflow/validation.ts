import { decimalIsZero, isDecimalString } from "../portfolio/decimal";
import type { CashFlowKind, NewManualCashFlow } from "./types";

const CANONICAL_POSITIVE_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/;
const ISO_TIMESTAMP_WITH_ZONE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/i;
const MAX_NOTE_LENGTH = 200;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
export const MAX_MANUAL_CASH_FLOW_AMOUNT_LENGTH = 40;

export class CashFlowValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CashFlowValidationError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseKind(value: unknown): CashFlowKind {
  if (value !== "contribution" && value !== "withdrawal") {
    throw new CashFlowValidationError(
      "invalid-kind",
      "kind는 contribution 또는 withdrawal이어야 합니다.",
    );
  }
  return value;
}

function parseAmount(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > MAX_MANUAL_CASH_FLOW_AMOUNT_LENGTH ||
    !isDecimalString(value) ||
    !CANONICAL_POSITIVE_DECIMAL.test(value) ||
    decimalIsZero(value)
  ) {
    throw new CashFlowValidationError(
      "invalid-amount",
      "amountKrw는 0보다 큰 정규화된 십진수 문자열이어야 합니다.",
    );
  }
  return value;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leapYear ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function hasValidCalendarAndTime(match: RegExpMatchArray): boolean {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const zone = match[8]?.toUpperCase();
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);

  return (
    Number.isInteger(year) &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    hour >= 0 &&
    hour <= 23 &&
    minute >= 0 &&
    minute <= 59 &&
    second >= 0 &&
    second <= 59 &&
    (zone === "Z" ||
      (offsetHour >= 0 &&
        offsetHour <= 14 &&
        offsetMinute >= 0 &&
        offsetMinute <= 59 &&
        (offsetHour < 14 || offsetMinute === 0)))
  );
}

function parseOccurredAt(value: unknown, now: Date): string {
  const match = typeof value === "string" ? value.match(ISO_TIMESTAMP_WITH_ZONE) : null;
  if (
    typeof value !== "string" ||
    value.length > 40 ||
    match === null ||
    !hasValidCalendarAndTime(match)
  ) {
    throw new CashFlowValidationError(
      "invalid-occurred-at",
      "occurredAt은 ISO 8601 날짜·시간이어야 합니다.",
    );
  }
  const parsed = new Date(value);
  const timestamp = parsed.getTime();
  if (!Number.isFinite(timestamp)) {
    throw new CashFlowValidationError(
      "invalid-occurred-at",
      "occurredAt은 ISO 8601 날짜·시간이어야 합니다.",
    );
  }
  const canonical = parsed.toISOString();
  if (timestamp > now.getTime() + MAX_FUTURE_SKEW_MS) {
    throw new CashFlowValidationError(
      "occurred-at-in-future",
      "occurredAt은 현재보다 지나치게 미래일 수 없습니다.",
    );
  }
  return canonical;
}

function parseNote(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string") {
    throw new CashFlowValidationError("invalid-note", "note는 문자열이어야 합니다.");
  }
  const note = value.trim();
  const containsDisallowedControl = Array.from(note).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (codePoint < 32 && codePoint !== 9 && codePoint !== 10 && codePoint !== 13) || codePoint === 127;
  });
  if (note.length > MAX_NOTE_LENGTH || containsDisallowedControl) {
    throw new CashFlowValidationError(
      "invalid-note",
      "note는 제어 문자를 제외한 200자 이하여야 합니다.",
    );
  }
  return note;
}

export function parseManualCashFlow(
  value: unknown,
  now: Date = new Date(),
): NewManualCashFlow {
  if (!Number.isFinite(now.getTime())) {
    throw new CashFlowValidationError("invalid-clock", "서버 시간을 확인할 수 없습니다.");
  }
  if (!isRecord(value)) {
    throw new CashFlowValidationError("invalid-body", "JSON 객체가 필요합니다.");
  }

  const allowed = new Set(["kind", "amountKrw", "occurredAt", "note"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new CashFlowValidationError(
      "invalid-body",
      "지원하지 않는 현금 흐름 필드가 포함되어 있습니다.",
    );
  }

  return {
    kind: parseKind(value.kind),
    amountKrw: parseAmount(value.amountKrw),
    occurredAt: parseOccurredAt(value.occurredAt, now),
    note: parseNote(value.note),
  };
}
