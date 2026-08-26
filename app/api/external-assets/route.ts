import {
  createExternalAsset,
  createExternalAssetsPayload,
  ExternalAssetIdempotencyConflictError,
  ExternalAssetNotFoundError,
  ExternalAssetRevisionConflictError,
  ExternalAssetStorageError,
  listExternalAssets,
  summarizeExternalAssets,
  updateExternalAsset,
} from "@/lib/assets/storage";
import type {
  ExternalAssetCreateResponse,
  ExternalAssetUpdateResponse,
} from "@/lib/assets/types";
import {
  ExternalAssetValidationError,
  parseExternalAssetInput,
  parseExternalAssetUpdate,
} from "@/lib/assets/validation";
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
const MAX_BODY_BYTES = 8192;

function jsonResponse<T>(body: T, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE_HEADERS });
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse(
    { error: { code, message, retryable: status >= 500 } },
    status,
  );
}

function parseLimit(request: Request): number | Response {
  const values = new URL(request.url).searchParams.getAll("limit");
  if (values.length > 1) {
    return errorResponse(400, "invalid-limit", "limit은 한 번만 지정할 수 있습니다.");
  }
  const raw = values[0];
  if (raw === undefined) return 100;
  if (!/^(?:[1-9]|[1-9]\d|100)$/.test(raw)) {
    return errorResponse(400, "invalid-limit", "limit은 1에서 100 사이의 정수여야 합니다.");
  }
  return Number(raw);
}

function authorizeWrite(request: Request, expectedIntent: string): Response | null {
  if (request.headers.get("X-LedgerLens-Intent") !== expectedIntent) {
    return errorResponse(
      428,
      "external-asset-intent-required",
      `외부 자산 변경에는 명시적인 ${expectedIntent} 요청이 필요합니다.`,
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

function parseIdempotencyKey(request: Request): string | Response {
  const key = request.headers.get("Idempotency-Key")?.trim() ?? "";
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
    return errorResponse(
      400,
      "invalid-idempotency-key",
      "8~128자의 유효한 Idempotency-Key가 필요합니다.",
    );
  }
  return key;
}

async function readJsonBody(request: Request): Promise<{ value: unknown } | Response> {
  const mediaType = request.headers
    .get("Content-Type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    return errorResponse(415, "json-required", "Content-Type은 application/json이어야 합니다.");
  }

  const contentLength = request.headers.get("Content-Length");
  if (
    contentLength &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > MAX_BODY_BYTES
  ) {
    return errorResponse(413, "body-too-large", "요청 본문이 너무 큽니다.");
  }
  if (!request.body) {
    return errorResponse(400, "invalid-json", "JSON 요청 본문이 필요합니다.");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        return errorResponse(413, "body-too-large", "요청 본문이 너무 큽니다.");
      }
      chunks.push(value);
    }
  } catch {
    return errorResponse(400, "invalid-json", "JSON 요청 본문을 읽을 수 없습니다.");
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { value: JSON.parse(text) as unknown };
  } catch {
    return errorResponse(400, "invalid-json", "올바른 JSON 요청 본문이 필요합니다.");
  }
}

function mapExternalAssetError(error: unknown, operation: "read" | "create" | "update"): Response {
  if (error instanceof HistoryIdentityError) {
    return errorResponse(error.status, error.code, error.message);
  }
  if (error instanceof ExternalAssetValidationError) {
    return errorResponse(400, error.code, error.message);
  }
  if (error instanceof ExternalAssetIdempotencyConflictError) {
    return errorResponse(
      409,
      "idempotency-conflict",
      "같은 Idempotency-Key가 다른 외부 자산 내용에 이미 사용되었습니다.",
    );
  }
  if (error instanceof ExternalAssetRevisionConflictError) {
    return jsonResponse(
      {
        error: {
          code: "asset-revision-conflict",
          message: "다른 변경이 먼저 저장되었습니다. 최신 자산을 불러온 뒤 다시 시도해 주세요.",
          retryable: false,
          actualRevision: error.actualRevision,
        },
      },
      409,
    );
  }
  if (error instanceof ExternalAssetNotFoundError) {
    return errorResponse(404, "external-asset-not-found", "외부 자산을 찾을 수 없습니다.");
  }
  if (error instanceof ExternalAssetStorageError) {
    return errorResponse(
      503,
      "external-asset-storage-unavailable",
      operation === "read"
        ? "외부 자산 저장소를 읽을 수 없습니다."
        : "외부 자산을 저장하지 못했습니다.",
    );
  }
  return errorResponse(503, "external-asset-unavailable", "외부 자산 요청을 처리하지 못했습니다.");
}

export async function GET(request: Request): Promise<Response> {
  const limit = parseLimit(request);
  if (limit instanceof Response) return limit;

  try {
    if (getPortfolioEnvironment().source === "demo") {
      return jsonResponse(createExternalAssetsPayload("demo", []));
    }
    const ownerId = resolveHistoryOwner(request);
    const accountKey = await resolveHistoryAccountKey();
    const [assets, summary] = await Promise.all([
      listExternalAssets(ownerId, accountKey, limit),
      summarizeExternalAssets(ownerId, accountKey),
    ]);
    return jsonResponse(createExternalAssetsPayload("ready", assets, summary));
  } catch (error) {
    return mapExternalAssetError(error, "read");
  }
}

export async function POST(request: Request): Promise<Response> {
  const authorizationError = authorizeWrite(request, "create-external-asset");
  if (authorizationError) return authorizationError;
  const idempotencyKey = parseIdempotencyKey(request);
  if (idempotencyKey instanceof Response) return idempotencyKey;

  try {
    if (getPortfolioEnvironment().source === "demo") {
      return errorResponse(
        409,
        "live-portfolio-required",
        "실계좌 연결 상태에서만 외부 자산을 저장할 수 있습니다.",
      );
    }
    const ownerId = resolveHistoryOwner(request);
    const parsedBody = await readJsonBody(request);
    if (parsedBody instanceof Response) return parsedBody;
    const input = parseExternalAssetInput(parsedBody.value);
    const accountKey = await resolveHistoryAccountKey();
    const result = await createExternalAsset(input, {
      ownerId,
      accountKey,
      idempotencyKey,
    });
    const [assets, summary] = await Promise.all([
      listExternalAssets(ownerId, accountKey, 100),
      summarizeExternalAssets(ownerId, accountKey),
    ]);
    const body: ExternalAssetCreateResponse = {
      ...result,
      payload: createExternalAssetsPayload("ready", assets, summary),
    };
    return jsonResponse(body, result.created ? 201 : 200);
  } catch (error) {
    return mapExternalAssetError(error, "create");
  }
}

export async function PUT(request: Request): Promise<Response> {
  const authorizationError = authorizeWrite(request, "update-external-asset");
  if (authorizationError) return authorizationError;

  try {
    if (getPortfolioEnvironment().source === "demo") {
      return errorResponse(
        409,
        "live-portfolio-required",
        "실계좌 연결 상태에서만 외부 자산을 수정할 수 있습니다.",
      );
    }
    const ownerId = resolveHistoryOwner(request);
    const parsedBody = await readJsonBody(request);
    if (parsedBody instanceof Response) return parsedBody;
    const input = parseExternalAssetUpdate(parsedBody.value);
    const accountKey = await resolveHistoryAccountKey();
    const result = await updateExternalAsset(input, { ownerId, accountKey });
    const [assets, summary] = await Promise.all([
      listExternalAssets(ownerId, accountKey, 100),
      summarizeExternalAssets(ownerId, accountKey),
    ]);
    const body: ExternalAssetUpdateResponse = {
      ...result,
      payload: createExternalAssetsPayload("ready", assets, summary),
    };
    return jsonResponse(body);
  } catch (error) {
    return mapExternalAssetError(error, "update");
  }
}
