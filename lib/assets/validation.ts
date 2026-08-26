import { decimalCompare, decimalIsZero, isDecimalString } from "../portfolio/decimal";
import {
  EXTERNAL_ASSET_KINDS,
  type ExternalAssetInput,
  type ExternalAssetKind,
  type ExternalAssetUpdateInput,
} from "./types";

const CANONICAL_NONNEGATIVE_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/;
const CURRENCY_CODE = /^(?:KRW|USD)$/;
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const EXTERNAL_ASSET_ID = /^ea_[a-f0-9]{40}$/;
const MAX_DECIMAL_LENGTH = 40;
const MAX_NAME_LENGTH = 80;
const MAX_INSTITUTION_LENGTH = 120;
const MAX_NOTE_LENGTH = 200;
const MAX_REVISION = 2_147_483_647;

export class ExternalAssetValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ExternalAssetValidationError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasDisallowedControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      (codePoint < 32 && codePoint !== 9 && codePoint !== 10 && codePoint !== 13) ||
      codePoint === 127
    );
  });
}

function parseKind(value: unknown): ExternalAssetKind {
  if (
    typeof value !== "string" ||
    !EXTERNAL_ASSET_KINDS.includes(value as ExternalAssetKind)
  ) {
    throw new ExternalAssetValidationError(
      "invalid-kind",
      "지원하지 않는 외부 자산 종류입니다.",
    );
  }
  return value as ExternalAssetKind;
}

function parseText(
  value: unknown,
  field: "name" | "institution" | "note",
  maximumLength: number,
  required: boolean,
): string {
  if (value === undefined && !required) return "";
  if (typeof value !== "string") {
    throw new ExternalAssetValidationError(
      `invalid-${field}`,
      `${field}는 문자열이어야 합니다.`,
    );
  }
  const normalized = value.trim();
  if (
    (required && normalized.length === 0) ||
    normalized.length > maximumLength ||
    hasDisallowedControl(normalized)
  ) {
    throw new ExternalAssetValidationError(
      `invalid-${field}`,
      `${field}의 길이 또는 문자를 확인해 주세요.`,
    );
  }
  return normalized;
}

function parseCurrency(value: unknown): string {
  if (typeof value !== "string" || !CURRENCY_CODE.test(value)) {
    throw new ExternalAssetValidationError(
      "invalid-currency",
      "currency는 KRW 또는 USD여야 합니다.",
    );
  }
  return value as string;
}

function parseAssetDecimal(
  value: unknown,
  field: "balance" | "valueKrw",
  allowZero: boolean,
): string {
  if (
    typeof value !== "string" ||
    value.length > MAX_DECIMAL_LENGTH ||
    !isDecimalString(value) ||
    !CANONICAL_NONNEGATIVE_DECIMAL.test(value) ||
    (!allowZero && decimalIsZero(value))
  ) {
    throw new ExternalAssetValidationError(
      field === "valueKrw" ? "invalid-value-krw" : "invalid-balance",
      `${field}는 ${allowZero ? "0 이상" : "0보다 큰"} 정규화된 십진수 문자열이어야 합니다.`,
    );
  }
  return value;
}

function parseAnnualRate(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (
    typeof value !== "string" ||
    value.length > MAX_DECIMAL_LENGTH ||
    !isDecimalString(value) ||
    !CANONICAL_NONNEGATIVE_DECIMAL.test(value) ||
    decimalCompare(value, "100") > 0
  ) {
    throw new ExternalAssetValidationError(
      "invalid-annual-rate",
      "annualRatePercent는 0부터 100까지의 정규화된 십진수 문자열이어야 합니다.",
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

function parseDate(value: unknown, field: "valuedAt" | "maturityDate"): string {
  const code = field === "valuedAt" ? "invalid-valued-at" : "invalid-maturity-date";
  const match = typeof value === "string" ? value.match(CALENDAR_DATE) : null;
  if (!match) {
    throw new ExternalAssetValidationError(
      code,
      `${field}은 YYYY-MM-DD 형식의 실제 날짜여야 합니다.`,
    );
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
    throw new ExternalAssetValidationError(
      code,
      `${field}은 YYYY-MM-DD 형식의 실제 날짜여야 합니다.`,
    );
  }
  return value;
}

function parseMaturityDate(value: unknown, valuedAt: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  const maturityDate = parseDate(value, "maturityDate");
  if (maturityDate < valuedAt) {
    throw new ExternalAssetValidationError(
      "invalid-maturity-date",
      "maturityDate는 valuedAt보다 빠를 수 없습니다.",
    );
  }
  return maturityDate;
}

function parseInputFields(
  value: Record<string, unknown>,
  allowZero: boolean,
): ExternalAssetInput {
  const valuedAt = parseDate(value.valuedAt, "valuedAt");
  const balance = parseAssetDecimal(value.balance, "balance", allowZero);
  const valueKrw = parseAssetDecimal(value.valueKrw, "valueKrw", allowZero);
  if (allowZero && decimalIsZero(balance) !== decimalIsZero(valueKrw)) {
    throw new ExternalAssetValidationError(
      "invalid-zero-balance",
      "종료된 자산은 잔액과 원화 평가액을 모두 0으로 입력해야 합니다.",
    );
  }
  return {
    kind: parseKind(value.kind),
    name: parseText(value.name, "name", MAX_NAME_LENGTH, true),
    institution: parseText(
      value.institution,
      "institution",
      MAX_INSTITUTION_LENGTH,
      false,
    ),
    currency: parseCurrency(value.currency),
    balance,
    valueKrw,
    valuedAt,
    maturityDate: parseMaturityDate(value.maturityDate, valuedAt),
    annualRatePercent: parseAnnualRate(value.annualRatePercent),
    note: parseText(value.note, "note", MAX_NOTE_LENGTH, false),
  };
}

const INPUT_FIELDS = new Set([
  "kind",
  "name",
  "institution",
  "currency",
  "balance",
  "valueKrw",
  "valuedAt",
  "maturityDate",
  "annualRatePercent",
  "note",
]);

export function parseExternalAssetInput(value: unknown): ExternalAssetInput {
  if (!isRecord(value)) {
    throw new ExternalAssetValidationError("invalid-body", "JSON 객체가 필요합니다.");
  }
  if (Object.keys(value).some((key) => !INPUT_FIELDS.has(key))) {
    throw new ExternalAssetValidationError(
      "invalid-body",
      "지원하지 않는 외부 자산 필드가 포함되어 있습니다.",
    );
  }
  return parseInputFields(value, false);
}

/** Validates a persisted revision, including a deliberately closed zero-value asset. */
export function parseStoredExternalAssetInput(value: unknown): ExternalAssetInput {
  if (!isRecord(value)) {
    throw new ExternalAssetValidationError("invalid-body", "JSON 객체가 필요합니다.");
  }
  if (Object.keys(value).some((key) => !INPUT_FIELDS.has(key))) {
    throw new ExternalAssetValidationError(
      "invalid-body",
      "지원하지 않는 외부 자산 필드가 포함되어 있습니다.",
    );
  }
  return parseInputFields(value, true);
}

export function parseExternalAssetUpdate(value: unknown): ExternalAssetUpdateInput {
  if (!isRecord(value)) {
    throw new ExternalAssetValidationError("invalid-body", "JSON 객체가 필요합니다.");
  }
  const allowed = new Set([...INPUT_FIELDS, "id", "expectedRevision"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new ExternalAssetValidationError(
      "invalid-body",
      "지원하지 않는 외부 자산 수정 필드가 포함되어 있습니다.",
    );
  }
  if (typeof value.id !== "string" || !EXTERNAL_ASSET_ID.test(value.id)) {
    throw new ExternalAssetValidationError("invalid-id", "유효한 외부 자산 id가 필요합니다.");
  }
  if (
    !Number.isInteger(value.expectedRevision) ||
    (value.expectedRevision as number) < 1 ||
    (value.expectedRevision as number) >= MAX_REVISION
  ) {
    throw new ExternalAssetValidationError(
      "invalid-revision",
      "expectedRevision은 유효한 양의 정수여야 합니다.",
    );
  }
  return {
    id: value.id,
    expectedRevision: value.expectedRevision as number,
    ...parseInputFields(value, true),
  };
}
