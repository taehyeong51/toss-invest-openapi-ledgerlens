import {
  activateTossCredentials,
  decryptTossCredentialVault,
  deleteTossCredentialVault,
  getTossCredentialVaultStatus,
  lockTossCredentialVault,
  normalizeTossVaultCredentials,
  saveTossCredentialVault,
  TossCredentialVaultError,
  type TossVaultCredentials,
} from "@/lib/credentials/vault";
import { getPortfolioEnvironment } from "@/lib/portfolio/environment";
import { resetPortfolioConnectionCache } from "@/lib/portfolio/loader";
import { TossClient } from "@/lib/toss/client";
import { TossApiError } from "@/lib/toss/errors";
import type { TossAccount } from "@/lib/toss/types";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 2_048;
const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "Cloudflare-CDN-Cache-Control": "no-store",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
} as const;

interface PublicAccount {
  selection: number;
  maskedNumber: string;
  accountType: string;
}

interface CredentialsBody {
  clientId: string;
  clientSecret: string;
}

interface ValidatedAccount {
  accountSeq: number;
  publicAccount: PublicAccount;
}

function jsonResponse<T>(body: T, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(NO_STORE_HEADERS);
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  }
  return Response.json(body, { status, headers });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  extraHeaders?: HeadersInit,
): Response {
  return jsonResponse({ error: { code, message, retryable: status >= 500 } }, status, extraHeaders);
}

function isLoopback(request: Request): boolean {
  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function requireLoopback(request: Request): Response | null {
  return isLoopback(request)
    ? null
    : errorResponse(
        403,
        "local-vault-only",
        "Toss 자격 증명 보관함은 이 기기에서 연 localhost 연결로만 관리할 수 있습니다.",
      );
}

function authorizeMutation(request: Request, intent: string): Response | null {
  const localError = requireLoopback(request);
  if (localError) return localError;
  if (new URL(request.url).search !== "") {
    return errorResponse(400, "query-not-allowed", "자격 증명 요청에는 쿼리를 사용할 수 없습니다.");
  }
  if (request.headers.get("X-LedgerLens-Intent") !== intent) {
    return errorResponse(428, "credential-intent-required", "명시적인 자격 증명 요청이 필요합니다.");
  }
  const origin = request.headers.get("Origin");
  let sameOrigin = false;
  try {
    sameOrigin = origin !== null && new URL(origin).origin === new URL(request.url).origin;
  } catch {
    sameOrigin = false;
  }
  if (!sameOrigin || request.headers.get("Sec-Fetch-Site") === "cross-site") {
    return errorResponse(403, "same-origin-required", "동일 출처 요청만 허용합니다.");
  }
  return null;
}

async function readBoundedJson(request: Request): Promise<unknown | Response> {
  const mediaType = request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    return errorResponse(415, "json-required", "Content-Type은 application/json이어야 합니다.");
  }
  const contentLength = request.headers.get("Content-Length");
  if (contentLength && /^\d+$/u.test(contentLength) && Number(contentLength) > MAX_BODY_BYTES) {
    return errorResponse(413, "body-too-large", "자격 증명 요청 본문이 너무 큽니다.");
  }
  if (!request.body) return errorResponse(400, "invalid-json", "JSON 요청 본문이 필요합니다.");

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
        return errorResponse(413, "body-too-large", "자격 증명 요청 본문이 너무 큽니다.");
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
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return errorResponse(400, "invalid-json", "올바른 JSON 요청 본문이 필요합니다.");
  }
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseCredentialsBody(value: unknown): CredentialsBody {
  if (!exactObject(value, ["clientId", "clientSecret"])) {
    throw new TossCredentialVaultError("invalid-credential-request", "자격 증명 요청 형식이 올바르지 않습니다.");
  }
  const body = value as Record<string, unknown>;
  const credentials = normalizeTossVaultCredentials({
    clientId: typeof body.clientId === "string" ? body.clientId : "",
    clientSecret: typeof body.clientSecret === "string" ? body.clientSecret : "",
  });
  return { clientId: credentials.clientId, clientSecret: credentials.clientSecret };
}

function parseSaveBody(value: unknown): {
  credentials: CredentialsBody;
  passphrase: string;
  preferredAccountSelection?: number;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TossCredentialVaultError("invalid-credential-request", "저장 요청 형식이 올바르지 않습니다.");
  }
  const body = value as Record<string, unknown>;
  const credentialKeys = body.preferredAccountSelection === undefined
    ? ["clientId", "clientSecret", "passphrase"]
    : ["clientId", "clientSecret", "passphrase", "preferredAccountSelection"];
  if (!exactObject(body, credentialKeys) || typeof body.passphrase !== "string") {
    throw new TossCredentialVaultError("invalid-credential-request", "저장 요청 형식이 올바르지 않습니다.");
  }
  if (
    body.preferredAccountSelection !== undefined &&
    (typeof body.preferredAccountSelection !== "number" ||
      !Number.isSafeInteger(body.preferredAccountSelection) ||
      body.preferredAccountSelection < 0)
  ) {
    throw new TossCredentialVaultError(
      "invalid-credential-request",
      "선택한 Toss 계좌 항목이 올바르지 않습니다.",
    );
  }
  const credentials = parseCredentialsBody({
    clientId: body.clientId,
    clientSecret: body.clientSecret,
  });
  return {
    credentials,
    passphrase: body.passphrase,
    ...(body.preferredAccountSelection === undefined
      ? {}
      : { preferredAccountSelection: body.preferredAccountSelection }),
  };
}

function maskAccountNumber(accountNumber: string): string {
  const tail = accountNumber.slice(-4).padStart(4, "•");
  return `•••• ${tail}`;
}

function sanitizeAccounts(accounts: TossAccount[]): ValidatedAccount[] {
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new TossCredentialVaultError(
      "toss-account-not-found",
      "조회 가능한 본인 Toss 증권 계좌를 찾지 못했습니다.",
    );
  }
  return accounts.map((account, selection) => {
    if (
      typeof account?.accountNo !== "string" ||
      account.accountNo.length < 4 ||
      !Number.isSafeInteger(account.accountSeq) ||
      account.accountSeq < 0 ||
      typeof account.accountType !== "string" ||
      account.accountType.length === 0 ||
      account.accountType.length > 64
    ) {
      throw new TossCredentialVaultError(
        "invalid-toss-response",
        "Toss 계좌 응답 형식이 올바르지 않습니다.",
      );
    }
    return {
      accountSeq: account.accountSeq,
      publicAccount: {
        selection,
        maskedNumber: maskAccountNumber(account.accountNo),
        accountType: account.accountType,
      },
    };
  });
}

async function validateWithToss(credentials: TossVaultCredentials): Promise<ValidatedAccount[]> {
  const accounts = sanitizeAccounts(
    await new TossClient({
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
    }).getAccounts(),
  );
  if (
    credentials.preferredAccountSeq !== undefined &&
    !accounts.some((account) => account.accountSeq === credentials.preferredAccountSeq)
  ) {
    throw new TossCredentialVaultError(
      "toss-account-not-found",
      "선택한 계좌를 현재 Toss 계좌 목록에서 찾지 못했습니다.",
    );
  }
  return accounts;
}

function errorFromCaught(error: unknown): Response {
  if (error instanceof TossApiError) {
    if (error.upstreamStatus === 401) {
      return errorResponse(422, "toss-credentials-invalid", "Client ID 또는 Client Secret을 확인해 주세요.");
    }
    if (error.upstreamStatus === 403) {
      return errorResponse(
        422,
        "toss-ip-not-allowed",
        "현재 PC의 공인 egress IP를 Toss WTS의 Open API 허용 IP에 먼저 등록해 주세요.",
      );
    }
    if (error.upstreamStatus === 429) {
      return errorResponse(
        503,
        "toss-rate-limited",
        "Toss 인증 조회 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.",
        error.retryAfterSeconds === undefined
          ? undefined
          : { "Retry-After": String(error.retryAfterSeconds) },
      );
    }
    return errorResponse(503, "toss-validation-unavailable", "Toss에서 자격 증명을 확인하지 못했습니다.");
  }
  if (error instanceof TossCredentialVaultError) {
    const status = error.code === "vault-not-found"
      ? 404
      : error.code === "vault-unlock-failed"
        ? 401
        : error.code.includes("unavailable") || error.code.includes("failed")
          ? 503
          : 400;
    return errorResponse(status, error.code, error.message);
  }
  return errorResponse(503, "credential-vault-unavailable", "자격 증명 보관함을 처리하지 못했습니다.");
}

function activeSource(): "demo" | "environment" | "relay" | "vault" {
  const configuration = getPortfolioEnvironment();
  if (configuration.source === "relay") return "relay";
  if (configuration.source === "direct") {
    return configuration.directCredentialSource === "vault" ? "vault" : "environment";
  }
  return "demo";
}

export async function GET(request: Request): Promise<Response> {
  const localError = requireLoopback(request);
  if (localError) return localError;
  if (new URL(request.url).search !== "") {
    return errorResponse(400, "query-not-allowed", "자격 증명 상태 조회에는 쿼리를 사용할 수 없습니다.");
  }
  try {
    return jsonResponse({
      available: true,
      activeSource: activeSource(),
      vault: await getTossCredentialVaultStatus(),
      storage: "local-encrypted-file",
    });
  } catch (error) {
    return errorFromCaught(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  const authorizationError = authorizeMutation(request, "validate-toss-credentials");
  if (authorizationError) return authorizationError;
  const value = await readBoundedJson(request);
  if (value instanceof Response) return value;
  try {
    const credentials = parseCredentialsBody(value);
    const accounts = await validateWithToss(credentials);
    return jsonResponse({ accounts: accounts.map((account) => account.publicAccount) });
  } catch (error) {
    return errorFromCaught(error);
  }
}

export async function PUT(request: Request): Promise<Response> {
  const authorizationError = authorizeMutation(request, "save-toss-credentials");
  if (authorizationError) return authorizationError;
  const value = await readBoundedJson(request);
  if (value instanceof Response) return value;
  try {
    const { credentials, passphrase, preferredAccountSelection } = parseSaveBody(value);
    const existing = await getTossCredentialVaultStatus();
    if (existing.exists) await decryptTossCredentialVault(passphrase);
    const accounts = await validateWithToss(credentials);
    const selectedAccount = accounts[preferredAccountSelection ?? 0];
    if (!selectedAccount) {
      throw new TossCredentialVaultError(
        "toss-account-not-found",
        "선택한 계좌를 현재 Toss 계좌 목록에서 찾지 못했습니다.",
      );
    }
    const preferredAccountSeq = selectedAccount.accountSeq;
    const stored: TossVaultCredentials = { ...credentials, preferredAccountSeq };
    await saveTossCredentialVault(stored, passphrase);
    const expiresAt = activateTossCredentials(stored);
    resetPortfolioConnectionCache();
    return jsonResponse({
      saved: true,
      expiresAt,
      selectedAccount: selectedAccount.publicAccount,
    });
  } catch (error) {
    return errorFromCaught(error);
  }
}

export async function PATCH(request: Request): Promise<Response> {
  const authorizationError = authorizeMutation(request, "manage-toss-credential-vault");
  if (authorizationError) return authorizationError;
  const value = await readBoundedJson(request);
  if (value instanceof Response) return value;
  try {
    if (exactObject(value, ["action"]) && value.action === "lock") {
      lockTossCredentialVault();
      resetPortfolioConnectionCache();
      return jsonResponse({ locked: true });
    }
    if (!exactObject(value, ["action", "passphrase"]) || value.action !== "unlock" || typeof value.passphrase !== "string") {
      throw new TossCredentialVaultError("invalid-credential-request", "보관함 관리 요청 형식이 올바르지 않습니다.");
    }
    const credentials = await decryptTossCredentialVault(value.passphrase);
    await validateWithToss(credentials);
    const expiresAt = activateTossCredentials(credentials);
    resetPortfolioConnectionCache();
    return jsonResponse({ unlocked: true, expiresAt });
  } catch (error) {
    return errorFromCaught(error);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const authorizationError = authorizeMutation(request, "delete-toss-credential-vault");
  if (authorizationError) return authorizationError;
  const value = await readBoundedJson(request);
  if (value instanceof Response) return value;
  try {
    if (!exactObject(value, ["passphrase"]) || typeof value.passphrase !== "string") {
      throw new TossCredentialVaultError("invalid-credential-request", "보관함 삭제 요청 형식이 올바르지 않습니다.");
    }
    await deleteTossCredentialVault(value.passphrase);
    resetPortfolioConnectionCache();
    return jsonResponse({ deleted: true });
  } catch (error) {
    return errorFromCaught(error);
  }
}
