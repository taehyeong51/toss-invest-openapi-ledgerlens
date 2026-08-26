import { decimalSum } from "../portfolio/decimal";
import {
  EXTERNAL_ASSET_KINDS,
  type ExternalAssetInput,
  type ExternalAssetKind,
  type ExternalAssetRecord,
} from "./types";
import {
  ExternalAssetValidationError,
  parseStoredExternalAssetInput,
} from "./validation";

export const EXTERNAL_ASSET_CSV_COLUMNS = [
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
] as const;

export const EXTERNAL_ASSET_CSV_MAX_ROWS = 250;
export const EXTERNAL_ASSET_CSV_MAX_BYTES = 256 * 1024;

type ExternalAssetCsvColumn = (typeof EXTERNAL_ASSET_CSV_COLUMNS)[number];

export interface ExternalAssetCsvImportRow {
  rowNumber: number;
  input: ExternalAssetInput;
  canonicalContent: string;
  occurrence: number;
}

export interface ExternalAssetCsvPreview {
  rows: ExternalAssetCsvImportRow[];
  rowCount: number;
  totalValueKrw: string;
  kindCounts: Record<ExternalAssetKind, number>;
  warnings: string[];
}

export class ExternalAssetCsvError extends Error {
  readonly code: string;
  readonly rowNumber: number | null;

  constructor(
    code: string,
    message: string,
    options?: { rowNumber?: number; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ExternalAssetCsvError";
    this.code = code;
    this.rowNumber = options?.rowNumber ?? null;
  }
}

function createKindCounts(): Record<ExternalAssetKind, number> {
  return Object.fromEntries(
    EXTERNAL_ASSET_KINDS.map((kind) => [kind, 0]),
  ) as Record<ExternalAssetKind, number>;
}

function quoteCsvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * Spreadsheet programs may execute a cell beginning with =, +, -, or @.
 * Prefixing an apostrophe makes those values textual. Existing apostrophes
 * are doubled as well, which gives the importer an unambiguous inverse.
 */
function protectSpreadsheetText(value: string): string {
  return /^['=+\-@]/.test(value) ? `'${value}` : value;
}

function restoreSpreadsheetText(value: string): { value: string; restored: boolean } {
  if (value.startsWith("''") || /^'[=+\-@]/.test(value)) {
    return { value: value.slice(1), restored: true };
  }
  return { value, restored: false };
}

function valueForColumn(
  asset: ExternalAssetInput,
  column: ExternalAssetCsvColumn,
): string {
  const value = asset[column];
  return value === null ? "" : value;
}

export function serializeExternalAssetsCsv(
  assets: Array<ExternalAssetRecord | ExternalAssetInput>,
): string {
  const header = EXTERNAL_ASSET_CSV_COLUMNS.map(quoteCsvCell).join(",");
  const lines = assets.map((asset) =>
    EXTERNAL_ASSET_CSV_COLUMNS.map((column) => {
      const value = valueForColumn(asset, column);
      const protectedValue = ["name", "institution", "note"].includes(column)
        ? protectSpreadsheetText(value)
        : value;
      return quoteCsvCell(protectedValue);
    }).join(","),
  );
  return `\uFEFF${[header, ...lines].join("\r\n")}\r\n`;
}

function parseCsvRecords(text: string): string[][] {
  if (text.includes("\u0000")) {
    throw new ExternalAssetCsvError(
      "csv-nul-character",
      "CSV에는 NUL 문자를 포함할 수 없습니다.",
    );
  }

  const source = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let fieldStarted = false;
  let inQuotes = false;
  let closedQuote = false;

  const finishField = (): void => {
    record.push(field);
    field = "";
    fieldStarted = false;
    closedQuote = false;
  };
  const finishRecord = (): void => {
    finishField();
    records.push(record);
    record = [];
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];

    if (inQuotes) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
          closedQuote = true;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (closedQuote) {
      if (character === ",") {
        finishField();
        continue;
      }
      if (character === "\n") {
        finishRecord();
        continue;
      }
      if (character === "\r" && source[index + 1] === "\n") {
        finishRecord();
        index += 1;
        continue;
      }
      throw new ExternalAssetCsvError(
        "malformed-csv",
        "닫는 따옴표 뒤에는 쉼표 또는 줄바꿈만 올 수 있습니다.",
      );
    }

    if (character === '"') {
      if (fieldStarted || field.length > 0) {
        throw new ExternalAssetCsvError(
          "malformed-csv",
          "따옴표 필드는 셀의 첫 문자에서 시작해야 합니다.",
        );
      }
      inQuotes = true;
      fieldStarted = true;
      continue;
    }
    if (character === ",") {
      finishField();
      continue;
    }
    if (character === "\n") {
      finishRecord();
      continue;
    }
    if (character === "\r") {
      if (source[index + 1] !== "\n") {
        throw new ExternalAssetCsvError(
          "malformed-csv",
          "따옴표 밖의 줄바꿈은 LF 또는 CRLF여야 합니다.",
        );
      }
      finishRecord();
      index += 1;
      continue;
    }
    field += character;
    fieldStarted = true;
  }

  if (inQuotes) {
    throw new ExternalAssetCsvError(
      "malformed-csv",
      "닫히지 않은 따옴표 필드가 있습니다.",
    );
  }
  if (closedQuote || fieldStarted || field.length > 0 || record.length > 0) {
    finishRecord();
  }
  return records;
}

function canonicalExternalAssetContent(input: ExternalAssetInput): string {
  return JSON.stringify(
    EXTERNAL_ASSET_CSV_COLUMNS.map((column) => valueForColumn(input, column)),
  );
}

function todayInKorea(now: Date): string {
  if (!Number.isFinite(now.getTime())) {
    throw new ExternalAssetCsvError(
      "invalid-clock",
      "CSV 검증 시계를 확인할 수 없습니다.",
    );
  }
  return new Date(now.getTime() + 9 * 60 * 60 * 1_000)
    .toISOString()
    .slice(0, 10);
}

export function parseExternalAssetsCsv(
  text: string,
  now: Date = new Date(),
): ExternalAssetCsvPreview {
  const records = parseCsvRecords(text);
  const header = records[0];
  if (!header) {
    throw new ExternalAssetCsvError("empty-csv", "CSV 헤더가 필요합니다.");
  }
  if (new Set(header).size !== header.length) {
    throw new ExternalAssetCsvError(
      "duplicate-csv-header",
      "CSV 헤더에 중복 열이 있습니다.",
    );
  }
  if (
    header.length !== EXTERNAL_ASSET_CSV_COLUMNS.length ||
    header.some((column, index) => column !== EXTERNAL_ASSET_CSV_COLUMNS[index])
  ) {
    throw new ExternalAssetCsvError(
      "invalid-csv-header",
      `CSV 헤더는 ${EXTERNAL_ASSET_CSV_COLUMNS.join(",")} 순서와 정확히 일치해야 합니다.`,
    );
  }

  const rows: ExternalAssetCsvImportRow[] = [];
  const occurrences = new Map<string, number>();
  const kindCounts = createKindCounts();
  let restoredFormulaCells = 0;
  let repeatedRows = 0;
  let closedRows = 0;
  const today = todayInKorea(now);

  for (let index = 1; index < records.length; index += 1) {
    const cells = records[index];
    const rowNumber = index + 1;
    if (cells.length === 1 && cells[0] === "") continue;
    if (cells.length !== EXTERNAL_ASSET_CSV_COLUMNS.length) {
      throw new ExternalAssetCsvError(
        "invalid-csv-column-count",
        `CSV ${rowNumber}행의 열 수가 헤더와 다릅니다.`,
        { rowNumber },
      );
    }
    if (cells.every((cell) => cell === "")) continue;
    if (rows.length >= EXTERNAL_ASSET_CSV_MAX_ROWS) {
      throw new ExternalAssetCsvError(
        "csv-row-limit-exceeded",
        `CSV는 비어 있지 않은 데이터 행을 최대 ${EXTERNAL_ASSET_CSV_MAX_ROWS}개까지 가져올 수 있습니다.`,
        { rowNumber },
      );
    }

    const values = Object.fromEntries(
      EXTERNAL_ASSET_CSV_COLUMNS.map((column, columnIndex) => [
        column,
        cells[columnIndex],
      ]),
    ) as Record<ExternalAssetCsvColumn, string>;
    for (const column of ["name", "institution", "note"] as const) {
      const restored = restoreSpreadsheetText(values[column]);
      values[column] = restored.value;
      if (restored.restored) restoredFormulaCells += 1;
    }

    let input: ExternalAssetInput;
    try {
      input = parseStoredExternalAssetInput({
        ...values,
        maturityDate: values.maturityDate === "" ? null : values.maturityDate,
        annualRatePercent:
          values.annualRatePercent === "" ? null : values.annualRatePercent,
      });
    } catch (error) {
      if (error instanceof ExternalAssetValidationError) {
        throw new ExternalAssetCsvError(
          "invalid-csv-row",
          `CSV ${rowNumber}행: ${error.message}`,
          { rowNumber, cause: error },
        );
      }
      throw error;
    }
    if (input.valuedAt > today) {
      throw new ExternalAssetCsvError(
        "future-valued-at",
        `CSV ${rowNumber}행: valuedAt은 오늘 이후 날짜일 수 없습니다.`,
        { rowNumber },
      );
    }

    const canonicalContent = canonicalExternalAssetContent(input);
    const occurrence = (occurrences.get(canonicalContent) ?? 0) + 1;
    occurrences.set(canonicalContent, occurrence);
    if (occurrence > 1) repeatedRows += 1;
    if (input.balance === "0" && input.valueKrw === "0") closedRows += 1;
    kindCounts[input.kind] += 1;
    rows.push({ rowNumber, input, canonicalContent, occurrence });
  }

  const warnings: string[] = [];
  if (restoredFormulaCells > 0) {
    warnings.push(
      `스프레드시트 수식 실행 방지 접두사를 ${restoredFormulaCells}개 텍스트 셀에서 복원했습니다.`,
    );
  }
  if (repeatedRows > 0) {
    warnings.push(
      `내용이 같은 반복 행 ${repeatedRows}건은 각 발생 순서를 유지해 별도 자산으로 처리합니다.`,
    );
  }
  if (closedRows > 0) {
    warnings.push(`잔액과 평가액이 0인 종료 자산 ${closedRows}건을 상태 그대로 가져옵니다.`);
  }

  return {
    rows,
    rowCount: rows.length,
    totalValueKrw: decimalSum(rows.map((row) => row.input.valueKrw)),
    kindCounts,
    warnings,
  };
}

export async function createExternalAssetCsvIdempotencyKey(
  row: Pick<ExternalAssetCsvImportRow, "canonicalContent" | "occurrence">,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    `${row.canonicalContent}\u0000${row.occurrence}`,
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `csv:${hex}`;
}
