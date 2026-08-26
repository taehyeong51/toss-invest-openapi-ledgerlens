import {
  EXTERNAL_ASSET_CSV_MAX_ROWS,
  serializeExternalAssetsCsv,
} from "@/lib/assets/csv";
import {
  ExternalAssetStorageError,
  listExternalAssetsForExport,
} from "@/lib/assets/storage";
import {
  HistoryIdentityError,
  resolveHistoryAccountKey,
  resolveHistoryOwner,
} from "@/lib/history/identity";
import { getPortfolioEnvironment } from "@/lib/portfolio/environment";

export const dynamic = "force-dynamic";

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "Cloudflare-CDN-Cache-Control": "no-store",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
} as const;

function jsonError(status: number, code: string, message: string): Response {
  return Response.json(
    { error: { code, message, retryable: status >= 500 } },
    { status, headers: PRIVATE_HEADERS },
  );
}

function csvResponse(csv: string, now: Date = new Date()): Response {
  const date = new Date(now.getTime() + 9 * 60 * 60 * 1_000)
    .toISOString()
    .slice(0, 10);
  return new Response(csv, {
    headers: {
      ...PRIVATE_HEADERS,
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition":
        `attachment; filename="ledgerlens-external-assets-${date}.csv"`,
    },
  });
}

export async function GET(request: Request): Promise<Response> {
  try {
    if (getPortfolioEnvironment().source === "demo") {
      return csvResponse(serializeExternalAssetsCsv([]));
    }

    const ownerId = resolveHistoryOwner(request);
    const accountKey = await resolveHistoryAccountKey();
    const assets = await listExternalAssetsForExport(
      ownerId,
      accountKey,
      EXTERNAL_ASSET_CSV_MAX_ROWS + 1,
    );
    if (assets.length > EXTERNAL_ASSET_CSV_MAX_ROWS) {
      return jsonError(
        409,
        "external-asset-export-limit-exceeded",
        `외부 자산이 ${EXTERNAL_ASSET_CSV_MAX_ROWS}건을 초과해 안전하게 내보낼 수 없습니다. 범위를 나눈 내보내기 기능이 추가될 때까지 자산 수를 줄여 주세요.`,
      );
    }
    return csvResponse(serializeExternalAssetsCsv(assets));
  } catch (error) {
    if (error instanceof HistoryIdentityError) {
      return jsonError(error.status, error.code, error.message);
    }
    if (error instanceof ExternalAssetStorageError) {
      return jsonError(
        503,
        "external-asset-export-storage-unavailable",
        "외부 자산 저장소를 읽지 못해 CSV를 만들 수 없습니다.",
      );
    }
    return jsonError(
      503,
      "external-asset-export-unavailable",
      "외부 자산 CSV 내보내기를 처리하지 못했습니다.",
    );
  }
}
