import {
  createExternalAssetCsvIdempotencyKey,
  EXTERNAL_ASSET_CSV_MAX_BYTES,
  ExternalAssetCsvError,
  parseExternalAssetsCsv,
} from "@/lib/assets/csv";
import {
  createExternalAssetsPayload,
  createImportedExternalAsset,
  ExternalAssetIdempotencyConflictError,
  ExternalAssetStorageError,
  listExternalAssets,
  summarizeExternalAssets,
} from "@/lib/assets/storage";
import {
  HistoryIdentityError,
  resolveHistoryAccountKey,
  resolveHistoryOwner,
} from "@/lib/history/identity";
import { getPortfolioEnvironment } from "@/lib/portfolio/environment";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "Cloudflare-CDN-Cache-Control": "no-store",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
} as const;

interface ImportProgress {
  processedCount: number;
  createdCount: number;
  replayedCount: number;
}

function jsonResponse<T>(body: T, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE_HEADERS });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  progress?: ImportProgress,
): Response {
  return jsonResponse(
    {
      error: {
        code,
        message,
        retryable: status >= 500,
        ...(progress && progress.processedCount > 0 ? progress : {}),
      },
    },
    status,
  );
}

function parseDryRun(request: Request): boolean | Response {
  const values = new URL(request.url).searchParams.getAll("dryRun");
  if (values.length === 0) return false;
  if (values.length !== 1 || !["true", "false"].includes(values[0])) {
    return errorResponse(
      400,
      "invalid-dry-run",
      "dryRun은 true 또는 false로 한 번만 지정할 수 있습니다.",
    );
  }
  return values[0] === "true";
}

function authorizeImport(request: Request): Response | null {
  if (request.headers.get("X-LedgerLens-Intent") !== "import-external-assets") {
    return errorResponse(
      428,
      "external-asset-import-intent-required",
      "CSV 가져오기에는 명시적인 import-external-assets 요청이 필요합니다.",
    );
  }

  const suppliedOrigin = request.headers.get("Origin");
  let sameOrigin = false;
  try {
    sameOrigin =
      suppliedOrigin !== null &&
      new URL(suppliedOrigin).origin === new URL(request.url).origin;
  } catch {
    sameOrigin = false;
  }
  if (!sameOrigin || request.headers.get("Sec-Fetch-Site") === "cross-site") {
    return errorResponse(403, "same-origin-required", "동일 출처 요청만 허용합니다.");
  }
  return null;
}

function validateIdempotencyKey(request: Request): Response | null {
  const key = request.headers.get("Idempotency-Key")?.trim() ?? "";
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
    return errorResponse(
      400,
      "invalid-idempotency-key",
      "확정 가져오기에는 8~128자의 유효한 Idempotency-Key가 필요합니다.",
    );
  }
  return null;
}

function validateCsvMediaType(request: Request): Response | null {
  const parts = (request.headers.get("Content-Type") ?? "")
    .split(";")
    .map((part) => part.trim());
  if (parts[0].toLowerCase() !== "text/csv") {
    return errorResponse(415, "csv-required", "Content-Type은 text/csv여야 합니다.");
  }
  const charsetParameters = parts
    .slice(1)
    .filter((part) => part.toLowerCase().startsWith("charset="));
  if (charsetParameters.length > 1) {
    return errorResponse(415, "utf8-csv-required", "CSV charset은 한 번만 지정해 주세요.");
  }
  if (charsetParameters.length === 1) {
    const charset = charsetParameters[0]
      .slice("charset=".length)
      .replace(/^"|"$/g, "")
      .toLowerCase();
    if (charset !== "utf-8" && charset !== "utf8") {
      return errorResponse(415, "utf8-csv-required", "CSV는 UTF-8 인코딩이어야 합니다.");
    }
  }
  return null;
}

async function readCsvBody(request: Request): Promise<string | Response> {
  const mediaTypeError = validateCsvMediaType(request);
  if (mediaTypeError) return mediaTypeError;

  const contentLength = request.headers.get("Content-Length");
  if (
    contentLength &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > EXTERNAL_ASSET_CSV_MAX_BYTES
  ) {
    return errorResponse(
      413,
      "csv-too-large",
      `CSV는 ${EXTERNAL_ASSET_CSV_MAX_BYTES}바이트를 초과할 수 없습니다.`,
    );
  }
  if (!request.body) {
    return errorResponse(400, "csv-body-required", "CSV 요청 본문이 필요합니다.");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > EXTERNAL_ASSET_CSV_MAX_BYTES) {
        await reader.cancel();
        return errorResponse(
          413,
          "csv-too-large",
          `CSV는 ${EXTERNAL_ASSET_CSV_MAX_BYTES}바이트를 초과할 수 없습니다.`,
        );
      }
      chunks.push(value);
    }
  } catch {
    return errorResponse(400, "invalid-csv-body", "CSV 요청 본문을 읽을 수 없습니다.");
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return errorResponse(
      400,
      "invalid-csv-encoding",
      "CSV 요청 본문은 올바른 UTF-8이어야 합니다.",
    );
  }
}

function mapImportError(error: unknown, progress: ImportProgress): Response {
  if (error instanceof ExternalAssetCsvError) {
    return errorResponse(400, error.code, error.message);
  }
  if (error instanceof HistoryIdentityError) {
    return errorResponse(error.status, error.code, error.message);
  }
  if (error instanceof ExternalAssetIdempotencyConflictError) {
    return errorResponse(
      409,
      "external-asset-import-idempotency-conflict",
      "동일한 CSV 행 키가 다른 자산 내용과 충돌했습니다. CSV를 변경하지 말고 다시 확인해 주세요.",
      progress,
    );
  }
  if (error instanceof ExternalAssetStorageError) {
    return errorResponse(
      503,
      "external-asset-import-interrupted",
      "가져오기가 중간에 중단되었습니다. 같은 CSV로 다시 실행하면 완료된 행은 중복 없이 재생됩니다.",
      progress,
    );
  }
  return errorResponse(
    503,
    "external-asset-import-unavailable",
    "외부 자산 CSV 가져오기를 처리하지 못했습니다. 같은 CSV로 다시 시도해 주세요.",
    progress,
  );
}

export async function POST(request: Request): Promise<Response> {
  const dryRun = parseDryRun(request);
  if (dryRun instanceof Response) return dryRun;
  const authorizationError = authorizeImport(request);
  if (authorizationError) return authorizationError;
  if (!dryRun) {
    const idempotencyError = validateIdempotencyKey(request);
    if (idempotencyError) return idempotencyError;
  }

  const progress: ImportProgress = {
    processedCount: 0,
    createdCount: 0,
    replayedCount: 0,
  };

  try {
    const body = await readCsvBody(request);
    if (body instanceof Response) return body;
    const now = new Date();
    const preview = parseExternalAssetsCsv(body, now);
    if (dryRun) {
      return jsonResponse({
        status: "preview" as const,
        rowCount: preview.rowCount,
        totalValueKrw: preview.totalValueKrw,
        kindCounts: preview.kindCounts,
        warnings: preview.warnings,
      });
    }

    // Compute every deterministic row key before touching D1. If a later write
    // fails, a retry with the same canonical rows and occurrence order safely
    // replays completed inserts and resumes at the first unfinished row.
    const keyedRows = await Promise.all(
      preview.rows.map(async (row) => ({
        ...row,
        idempotencyKey: await createExternalAssetCsvIdempotencyKey(row),
      })),
    );

    if (getPortfolioEnvironment().source === "demo") {
      return errorResponse(
        409,
        "live-portfolio-required",
        "실계좌 연결 상태에서만 CSV 자산을 저장할 수 있습니다.",
      );
    }

    const ownerId = resolveHistoryOwner(request);
    const accountKey = await resolveHistoryAccountKey();
    for (const row of keyedRows) {
      const result = await createImportedExternalAsset(
        row.input,
        { ownerId, accountKey, idempotencyKey: row.idempotencyKey },
        now,
      );
      progress.processedCount += 1;
      if (result.created) progress.createdCount += 1;
      else progress.replayedCount += 1;
    }

    const [assets, summary] = await Promise.all([
      listExternalAssets(ownerId, accountKey, 100),
      summarizeExternalAssets(ownerId, accountKey),
    ]);
    return jsonResponse(
      {
        status: "imported" as const,
        rowCount: preview.rowCount,
        createdCount: progress.createdCount,
        replayedCount: progress.replayedCount,
        warnings: preview.warnings,
        payload: createExternalAssetsPayload("ready", assets, summary),
      },
      progress.createdCount > 0 ? 201 : 200,
    );
  } catch (error) {
    return mapImportError(error, progress);
  }
}
