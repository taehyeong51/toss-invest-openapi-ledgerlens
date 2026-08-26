import {
  getEnvironmentTossClient,
  getPortfolioEnvironment,
} from "../portfolio/environment";
import { getRememberedDirectAccountSelection } from "../portfolio/loader";

const LOCAL_OWNER_ID = "local-development-owner";
const discoveredDirectAccounts = new Map<string, number>();
const directAccountDiscoveries = new Map<string, Promise<number>>();

export class HistoryIdentityError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HistoryIdentityError";
    this.status = status;
    this.code = code;
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function discoverSingleDirectAccountSeq(
  clientId: string,
  configuration: ReturnType<typeof getPortfolioEnvironment>,
): Promise<number> {
  const cached = discoveredDirectAccounts.get(clientId);
  if (cached !== undefined) return cached;

  const existing = directAccountDiscoveries.get(clientId);
  if (existing) return existing;

  const discovery = getEnvironmentTossClient(configuration)
    .getAccounts()
    .then((accounts) => {
      const selected = accounts[0];
      if (
        accounts.length === 1 &&
        Number.isSafeInteger(selected?.accountSeq) &&
        selected.accountSeq >= 0
      ) {
        discoveredDirectAccounts.set(clientId, selected.accountSeq);
        return selected.accountSeq;
      }
      throw new HistoryIdentityError(
        409,
        "history-account-key-required",
        accounts.length > 1
          ? "여러 계좌가 있어 기록할 TOSS_ACCOUNT_SEQ 설정이 필요합니다."
          : "기록할 실계좌를 확인하지 못했습니다.",
      );
    })
    .finally(() => {
      directAccountDiscoveries.delete(clientId);
    });

  directAccountDiscoveries.set(clientId, discovery);
  return discovery;
}

/** Resolves ownership only from an explicitly trusted platform or loopback opt-in. */
export function resolveHistoryOwner(request: Request): string {
  const hostname = new URL(request.url).hostname;
  if (isLoopback(hostname)) {
    if (process.env.LEDGERLENS_ALLOW_LOCAL_HISTORY === "true") return LOCAL_OWNER_ID;
    throw new HistoryIdentityError(
      401,
      "history-owner-required",
      "로컬 기록 저장은 명시적으로 활성화해야 합니다.",
    );
  }

  if (process.env.LEDGERLENS_TRUST_PLATFORM_AUTH !== "true") {
    throw new HistoryIdentityError(
      401,
      "history-owner-required",
      "배포 환경의 인증 경계를 명시적으로 신뢰한 경우에만 기록을 볼 수 있습니다.",
    );
  }

  const ownerId = request.headers.get("oai-authenticated-user-id")?.trim();
  const containsControlCharacter = ownerId
    ? Array.from(ownerId).some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 31 || codePoint === 127;
      })
    : false;
  if (!ownerId || ownerId.length > 256 || containsControlCharacter) {
    throw new HistoryIdentityError(401, "history-owner-required", "인증된 사용자만 기록을 볼 수 있습니다.");
  }
  return ownerId;
}

/** Derives a non-secret, stable account partition without using a masked number. */
export async function resolveHistoryAccountKey(): Promise<string> {
  const configuration = getPortfolioEnvironment();
  if (configuration.source === "direct" && configuration.directCredentials) {
    let accountSeq = configuration.preferredAccountSeq;
    if (accountSeq === undefined) {
      const remembered = getRememberedDirectAccountSelection(
        configuration.directCredentials.clientId,
      );
      if (remembered?.accountCount === 1) {
        accountSeq = remembered.accountSeq;
      } else if (remembered && remembered.accountCount > 1) {
        throw new HistoryIdentityError(
          409,
          "history-account-key-required",
          "여러 계좌가 있어 기록할 TOSS_ACCOUNT_SEQ 설정이 필요합니다.",
        );
      } else {
        accountSeq = await discoverSingleDirectAccountSeq(
          configuration.directCredentials.clientId,
          configuration,
        );
      }
    }
    return `direct:${await sha256(
      `${configuration.directCredentials.clientId}\u0000${accountSeq}`,
    )}`;
  }

  if (configuration.source === "relay" && configuration.relay) {
    return `relay:${await sha256(configuration.relay.accountKey)}`;
  }

  throw new HistoryIdentityError(
    409,
    "history-account-key-required",
    "기록 저장에는 실계좌 번호 설정이 필요합니다.",
  );
}

export async function createSnapshotId(
  ownerId: string,
  accountKey: string,
  idempotencyKey: string,
): Promise<string> {
  return `ps_${(await sha256(`${ownerId}\u0000${accountKey}\u0000${idempotencyKey}`)).slice(0, 40)}`;
}
