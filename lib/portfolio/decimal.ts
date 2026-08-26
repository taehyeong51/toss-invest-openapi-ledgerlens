const DECIMAL_PATTERN = /^-?\d+(?:\.\d+)?$/;
const BIGINT_ZERO = BigInt(0);
const BIGINT_ONE = BigInt(1);
const BIGINT_TWO = BigInt(2);
const BIGINT_TEN = BigInt(10);

interface DecimalParts {
  units: bigint;
  scale: number;
}

function powerOfTen(exponent: number): bigint {
  if (!Number.isSafeInteger(exponent) || exponent < 0 || exponent > 100) {
    throw new RangeError("Decimal scale is outside the supported range.");
  }
  return BIGINT_TEN ** BigInt(exponent);
}

function parseDecimal(value: string): DecimalParts {
  if (typeof value !== "string" || value.length > 100 || !DECIMAL_PATTERN.test(value)) {
    throw new TypeError("Expected a plain decimal string.");
  }

  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [integer, fraction = ""] = unsigned.split(".");
  const digits = `${integer}${fraction}`.replace(/^0+(?=\d)/, "");
  const units = BigInt(digits || "0") * (negative ? -BIGINT_ONE : BIGINT_ONE);

  return { units, scale: fraction.length };
}

function formatDecimal(parts: DecimalParts): string {
  let { units, scale } = parts;

  while (scale > 0 && units % BIGINT_TEN === BIGINT_ZERO) {
    units /= BIGINT_TEN;
    scale -= 1;
  }

  const negative = units < BIGINT_ZERO;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, "0");
  const value =
    scale === 0
      ? digits
      : `${digits.slice(0, digits.length - scale)}.${digits.slice(digits.length - scale)}`;

  return negative && units !== BIGINT_ZERO ? `-${value}` : value;
}

function align(left: DecimalParts, right: DecimalParts): [bigint, bigint, number] {
  const scale = Math.max(left.scale, right.scale);
  return [
    left.units * powerOfTen(scale - left.scale),
    right.units * powerOfTen(scale - right.scale),
    scale,
  ];
}

export function isDecimalString(value: unknown): value is string {
  return typeof value === "string" && value.length <= 100 && DECIMAL_PATTERN.test(value);
}

export function decimalAdd(...values: string[]): string {
  if (values.length === 0) return "0";

  let total = parseDecimal(values[0]);
  for (const value of values.slice(1)) {
    const next = parseDecimal(value);
    const [leftUnits, rightUnits, scale] = align(total, next);
    total = { units: leftUnits + rightUnits, scale };
  }

  return formatDecimal(total);
}

export function decimalSubtract(left: string, right: string): string {
  const parsedRight = parseDecimal(right);
  return decimalAdd(left, formatDecimal({ units: -parsedRight.units, scale: parsedRight.scale }));
}

export function decimalMultiply(left: string, right: string): string {
  const leftParts = parseDecimal(left);
  const rightParts = parseDecimal(right);
  return formatDecimal({
    units: leftParts.units * rightParts.units,
    scale: leftParts.scale + rightParts.scale,
  });
}

/**
 * Divide two decimal strings and round half away from zero. The result is
 * capped to `precision` fractional digits and then normalized.
 */
export function decimalDivide(left: string, right: string, precision = 8): string {
  if (!Number.isSafeInteger(precision) || precision < 0 || precision > 30) {
    throw new RangeError("Decimal division precision is outside the supported range.");
  }

  const numeratorParts = parseDecimal(left);
  const denominatorParts = parseDecimal(right);
  if (denominatorParts.units === BIGINT_ZERO) {
    throw new RangeError("Cannot divide by zero.");
  }

  const numerator =
    numeratorParts.units * powerOfTen(denominatorParts.scale + precision);
  const denominator = denominatorParts.units * powerOfTen(numeratorParts.scale);
  let quotient = numerator / denominator;
  const remainder = numerator % denominator;

  const absoluteRemainder = remainder < BIGINT_ZERO ? -remainder : remainder;
  const absoluteDenominator = denominator < BIGINT_ZERO ? -denominator : denominator;
  if (absoluteRemainder * BIGINT_TWO >= absoluteDenominator) {
    quotient +=
      (numerator < BIGINT_ZERO) === (denominator < BIGINT_ZERO) ? BIGINT_ONE : -BIGINT_ONE;
  }

  return formatDecimal({ units: quotient, scale: precision });
}

export function decimalSum(values: Iterable<string>): string {
  return decimalAdd(...Array.from(values));
}

export function decimalIsZero(value: string): boolean {
  return parseDecimal(value).units === BIGINT_ZERO;
}

export function decimalCompare(left: string, right: string): number {
  const [leftUnits, rightUnits] = align(parseDecimal(left), parseDecimal(right));
  return leftUnits > rightUnits ? 1 : leftUnits < rightUnits ? -1 : 0;
}

export function decimalAbsolute(value: string): string {
  const parts = parseDecimal(value);
  return formatDecimal({
    units: parts.units < BIGINT_ZERO ? -parts.units : parts.units,
    scale: parts.scale,
  });
}
