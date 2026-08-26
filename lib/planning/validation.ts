import type { CapitalPlanInput } from "./types";

const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_MONEY_LENGTH = 24;
const MAX_WEIGHT_LENGTH = 12;

export class CapitalPlanValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CapitalPlanValidationError";
    this.code = code;
  }
}

function canonicalDecimal(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.length > maxLength || !DECIMAL.test(value)) {
    throw new CapitalPlanValidationError(
      "invalid-capital-plan",
      `${field} 값은 0 이상의 정규화된 십진 문자열이어야 합니다.`,
    );
  }
  const [integer, fraction = ""] = value.split(".");
  const normalizedFraction = fraction.replace(/0+$/, "");
  return normalizedFraction ? `${integer}.${normalizedFraction}` : integer;
}

function decimalParts(value: string): { scaled: bigint; scale: number } {
  const [integer, fraction = ""] = value.split(".");
  return { scaled: BigInt(`${integer}${fraction}`), scale: fraction.length };
}

function compareDecimal(left: string, right: string): number {
  const a = decimalParts(left);
  const b = decimalParts(right);
  const scale = Math.max(a.scale, b.scale);
  const scaledA = a.scaled * BigInt(`1${"0".repeat(scale - a.scale)}`);
  const scaledB = b.scaled * BigInt(`1${"0".repeat(scale - b.scale)}`);
  return scaledA > scaledB ? 1 : scaledA < scaledB ? -1 : 0;
}

function exactWeightSum(values: string[]): bigint {
  const parts = values.map(decimalParts);
  const scale = Math.max(...parts.map((part) => part.scale));
  const total = parts.reduce(
    (sum, part) => sum + part.scaled * BigInt(`1${"0".repeat(scale - part.scale)}`),
    BigInt(0),
  );
  return total === BigInt(`1${"0".repeat(scale)}`) ? BigInt(1) : BigInt(0);
}

function canonicalDate(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new CapitalPlanValidationError("invalid-capital-plan", `${field} 날짜가 필요합니다.`);
  }
  const matched = DATE.exec(value);
  if (!matched) {
    throw new CapitalPlanValidationError("invalid-capital-plan", `${field} 날짜 형식이 올바르지 않습니다.`);
  }
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new CapitalPlanValidationError("invalid-capital-plan", `${field} 날짜가 존재하지 않습니다.`);
  }
  return value;
}

export function parseCapitalPlan(
  value: unknown,
  options: { allowMissingStartAsset?: boolean } = {},
): CapitalPlanInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CapitalPlanValidationError("invalid-capital-plan", "자본 계획 형식이 올바르지 않습니다.");
  }
  const body = value as Record<string, unknown>;
  const expectedKeys = [
    "expectedRevision",
    "monthlyContributionKrw",
    "startAssetKrw",
    "startDate",
    "targetAssetKrw",
    "targetCashWeight",
    "targetDate",
    "targetKrWeight",
    "targetUsWeight",
  ];
  if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(expectedKeys)) {
    throw new CapitalPlanValidationError("invalid-capital-plan", "자본 계획 필드를 확인해 주세요.");
  }
  if (
    !Number.isSafeInteger(body.expectedRevision) ||
    Number(body.expectedRevision) < 0 ||
    Number(body.expectedRevision) > 2_147_483_647
  ) {
    throw new CapitalPlanValidationError("invalid-capital-plan", "계획 revision이 올바르지 않습니다.");
  }
  const startAssetKrw = canonicalDecimal(body.startAssetKrw, "계획 시작 자산", MAX_MONEY_LENGTH);
  const targetAssetKrw = canonicalDecimal(body.targetAssetKrw, "목표 자산", MAX_MONEY_LENGTH);
  const monthlyContributionKrw = canonicalDecimal(
    body.monthlyContributionKrw,
    "월 투자금",
    MAX_MONEY_LENGTH,
  );
  if (compareDecimal(targetAssetKrw, "0") === 0) {
    throw new CapitalPlanValidationError("invalid-capital-plan", "목표 자산은 0보다 커야 합니다.");
  }
  if (compareDecimal(startAssetKrw, "0") === 0 && !options.allowMissingStartAsset) {
    throw new CapitalPlanValidationError(
      "invalid-capital-plan",
      "계획 시작 자산은 0보다 커야 합니다.",
    );
  }
  if (compareDecimal(targetAssetKrw, startAssetKrw) <= 0) {
    throw new CapitalPlanValidationError(
      "invalid-capital-plan",
      "목표 자산은 계획 시작 자산보다 커야 합니다.",
    );
  }
  const startDate = canonicalDate(body.startDate, "시작");
  const targetDate = canonicalDate(body.targetDate, "목표");
  if (startDate > targetDate) {
    throw new CapitalPlanValidationError("invalid-capital-plan", "목표일은 시작일 이후여야 합니다.");
  }
  const targetKrWeight = canonicalDecimal(body.targetKrWeight, "국내 목표 비중", MAX_WEIGHT_LENGTH);
  const targetUsWeight = canonicalDecimal(body.targetUsWeight, "미국 목표 비중", MAX_WEIGHT_LENGTH);
  const targetCashWeight = canonicalDecimal(body.targetCashWeight, "현금 목표 비중", MAX_WEIGHT_LENGTH);
  for (const weight of [targetKrWeight, targetUsWeight, targetCashWeight]) {
    if (compareDecimal(weight, "1") > 0) {
      throw new CapitalPlanValidationError("invalid-capital-plan", "각 목표 비중은 100% 이하여야 합니다.");
    }
  }
  if (exactWeightSum([targetKrWeight, targetUsWeight, targetCashWeight]) !== BigInt(1)) {
    throw new CapitalPlanValidationError("invalid-capital-plan", "목표 비중의 합은 정확히 100%여야 합니다.");
  }
  return {
    startAssetKrw,
    targetAssetKrw,
    startDate,
    targetDate,
    monthlyContributionKrw,
    targetKrWeight,
    targetUsWeight,
    targetCashWeight,
    expectedRevision: Number(body.expectedRevision),
  };
}
