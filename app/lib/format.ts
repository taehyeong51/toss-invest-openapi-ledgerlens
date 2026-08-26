import type { DecimalValue } from "./ui-types";

/** HTML pattern source for canonical non-negative decimal inputs. */
export const DECIMAL_INPUT_PATTERN = String.raw`(?:0|[1-9]\d*)(?:\.\d+)?`;

export function decimalText(value: DecimalValue): string {
  if (value === null || value === undefined || value === "") return "0";
  return String(value).replace(/,/g, "");
}

function groupedInteger(value: string): string {
  const clean = value.replace(/^0+(?=\d)/, "") || "0";
  return clean.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function formatDecimal(value: DecimalValue, fractionDigits = 0): string {
  const matched = decimalText(value).match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!matched) return "—";
  const [, sign, integer, fraction = ""] = matched;
  const scaleDifference = fraction.length - fractionDigits;
  if (scaleDifference <= 0) {
    const visibleFraction = fractionDigits > 0 ? fraction.padEnd(fractionDigits, "0") : "";
    return `${sign}${groupedInteger(integer)}${visibleFraction ? `.${visibleFraction}` : ""}`;
  }
  const divisor = BigInt(`1${"0".repeat(scaleDifference)}`);
  const scaled = BigInt(`${integer}${fraction}`);
  const rounded = (scaled + divisor / BigInt(2)) / divisor;
  const digits = rounded.toString().padStart(fractionDigits + 1, "0");
  const whole = fractionDigits > 0 ? digits.slice(0, -fractionDigits) : digits;
  const visibleFraction = fractionDigits > 0 ? digits.slice(-fractionDigits) : "";
  const visibleSign = sign === "-" && rounded !== BigInt(0) ? "-" : "";
  return `${visibleSign}${groupedInteger(whole)}${visibleFraction ? `.${visibleFraction}` : ""}`;
}

export function exactDecimalParts(value: DecimalValue): { scaled: bigint; scale: number } | null {
  const matched = decimalText(value).match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!matched) return null;
  const [, sign, integer, fraction = ""] = matched;
  const digits = `${integer}${fraction}`.replace(/^0+(?=\d)/, "") || "0";
  return {
    scaled: BigInt(digits) * (sign === "-" ? BigInt(-1) : BigInt(1)),
    scale: fraction.length,
  };
}

export function exactDifference(left: DecimalValue, right: DecimalValue): string {
  const a = exactDecimalParts(left);
  const b = exactDecimalParts(right);
  if (!a || !b) return "0";
  const scale = Math.max(a.scale, b.scale);
  const result =
    a.scaled * BigInt(`1${"0".repeat(scale - a.scale)}`) -
    b.scaled * BigInt(`1${"0".repeat(scale - b.scale)}`);
  return scaledToText(result, scale);
}

export function exactSum(...values: DecimalValue[]): string {
  const parts = values.map(exactDecimalParts);
  if (parts.some((value) => value === null)) return "0";
  const valid = parts as Array<{ scaled: bigint; scale: number }>;
  const scale = Math.max(0, ...valid.map((value) => value.scale));
  const result = valid.reduce(
    (sum, value) => sum + value.scaled * BigInt(`1${"0".repeat(scale - value.scale)}`),
    BigInt(0),
  );
  return scaledToText(result, scale);
}

function scaledToText(value: bigint, scale: number): string {
  const negative = value < BigInt(0);
  const absolute = (negative ? -value : value).toString().padStart(scale + 1, "0");
  const whole = scale ? absolute.slice(0, -scale) || "0" : absolute;
  const fraction = scale ? absolute.slice(-scale).replace(/0+$/, "") : "";
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export function compareDecimal(left: DecimalValue, right: DecimalValue): number {
  const a = exactDecimalParts(left);
  const b = exactDecimalParts(right);
  if (!a || !b) return 0;
  const scale = Math.max(a.scale, b.scale);
  const scaledA = a.scaled * BigInt(`1${"0".repeat(scale - a.scale)}`);
  const scaledB = b.scaled * BigInt(`1${"0".repeat(scale - b.scale)}`);
  return scaledA > scaledB ? 1 : scaledA < scaledB ? -1 : 0;
}

export function numeric(value: DecimalValue): number {
  const number = Number(decimalText(value));
  return Number.isFinite(number) ? number : 0;
}

export function formatKrw(value: DecimalValue): string {
  return `${formatDecimal(value)}원`;
}

export function formatCompactKrw(value: DecimalValue): string {
  const number = numeric(value);
  const absolute = Math.abs(number);
  if (absolute >= 100_000_000) return `${formatDecimal(number / 100_000_000, 1)}억원`;
  if (absolute >= 10_000) return `${formatDecimal(number / 10_000, 0)}만원`;
  return formatKrw(value);
}

export function signedKrw(value: DecimalValue): string {
  const raw = decimalText(value);
  if (raw.startsWith("-")) return `-${formatKrw(raw.slice(1))}`;
  if (/^0(?:\.0*)?$/.test(raw)) return formatKrw(raw);
  return `+${formatKrw(raw)}`;
}

export function signedClass(value: DecimalValue): "positive" | "negative" | "neutral" {
  const parts = exactDecimalParts(value);
  if (!parts || parts.scaled === BigInt(0)) return "neutral";
  return parts.scaled > BigInt(0) ? "positive" : "negative";
}

export function formatPercent(value: DecimalValue): string {
  const parsed = exactDecimalParts(value);
  if (!parsed) return "—%";
  const negative = parsed.scaled < BigInt(0);
  const absolute = negative ? -parsed.scaled : parsed.scaled;
  let hundredths: bigint;
  if (parsed.scale <= 4) {
    hundredths = absolute * BigInt(`1${"0".repeat(4 - parsed.scale)}`);
  } else {
    const divisor = BigInt(`1${"0".repeat(parsed.scale - 4)}`);
    hundredths = absolute / divisor + ((absolute % divisor) * BigInt(2) >= divisor ? BigInt(1) : BigInt(0));
  }
  const digits = hundredths.toString().padStart(3, "0");
  return `${negative && hundredths !== BigInt(0) ? "-" : ""}${groupedInteger(digits.slice(0, -2) || "0")}.${digits.slice(-2)}%`;
}

export function formatDate(value: string, withTime = false): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "short",
    day: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}),
    timeZone: "Asia/Seoul",
  }).format(date);
}

export function formatAsOf(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Seoul",
  }).format(date);
}

export function apiErrorMessage(value: unknown, fallback: string): string {
  if (!value || typeof value !== "object" || !("error" in value)) return fallback;
  const error = (value as { error?: unknown }).error;
  if (!error || typeof error !== "object" || !("message" in error)) return fallback;
  return typeof (error as { message?: unknown }).message === "string"
    ? String((error as { message: string }).message)
    : fallback;
}
