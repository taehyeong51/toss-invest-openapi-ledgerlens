import {
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";

const VAULT_VERSION = 1;
const PBKDF2_ITERATIONS = 310_000;
const MAX_VAULT_BYTES = 32 * 1024;
const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1_000;
const VAULT_AAD = new TextEncoder().encode("LedgerLens Toss credential vault v1");

export interface TossVaultCredentials {
  clientId: string;
  clientSecret: string;
  preferredAccountSeq?: number;
}

export interface TossCredentialVaultStatus {
  exists: boolean;
  unlocked: boolean;
  expiresAt: string | null;
}

interface StoredCredentialVault {
  version: 1;
  kdf: {
    name: "PBKDF2";
    hash: "SHA-256";
    iterations: number;
    salt: string;
  };
  cipher: {
    name: "AES-GCM";
    iv: string;
    ciphertext: string;
  };
  createdAt: string;
  updatedAt: string;
}

interface UnlockedState {
  credentials: TossVaultCredentials;
  expiresAtMs: number;
}

interface VaultFileOptions {
  filePath?: string;
  now?: () => number;
}

let unlockedState: UnlockedState | null = null;

export class TossCredentialVaultError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TossCredentialVaultError";
    this.code = code;
  }
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

export function normalizeTossVaultCredentials(input: TossVaultCredentials): TossVaultCredentials {
  const clientId = typeof input.clientId === "string" ? input.clientId.trim() : "";
  const clientSecret = typeof input.clientSecret === "string" ? input.clientSecret.trim() : "";
  if (!clientId || clientId.length > 256 || containsControlCharacter(clientId)) {
    throw new TossCredentialVaultError(
      "invalid-client-id",
      "Toss Client ID는 1~256자의 한 줄 문자열이어야 합니다.",
    );
  }
  if (!clientSecret || clientSecret.length > 512 || containsControlCharacter(clientSecret)) {
    throw new TossCredentialVaultError(
      "invalid-client-secret",
      "Toss Client Secret은 1~512자의 한 줄 문자열이어야 합니다.",
    );
  }
  const preferredAccountSeq = input.preferredAccountSeq;
  if (
    preferredAccountSeq !== undefined &&
    (!Number.isSafeInteger(preferredAccountSeq) || preferredAccountSeq < 0)
  ) {
    throw new TossCredentialVaultError(
      "invalid-account-seq",
      "선택한 Toss 계좌 식별자가 올바르지 않습니다.",
    );
  }
  return {
    clientId,
    clientSecret,
    ...(preferredAccountSeq === undefined ? {} : { preferredAccountSeq }),
  };
}

function requirePassphrase(passphrase: string): string {
  if (typeof passphrase !== "string" || passphrase.length < 12 || passphrase.length > 256) {
    throw new TossCredentialVaultError(
      "invalid-passphrase",
      "보관함 암호는 12~256자로 입력해 주세요.",
    );
  }
  return passphrase;
}

function filePath(options?: VaultFileOptions): string {
  return options?.filePath ?? resolve(process.cwd(), "private-data", "toss-credentials.v1.json");
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function bytesFromBase64(value: string, expectedLength?: number): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new TossCredentialVaultError("invalid-vault", "암호화 보관함 형식이 올바르지 않습니다.");
  }
  const bytes = new Uint8Array(Buffer.from(value, "base64"));
  if (expectedLength !== undefined && bytes.byteLength !== expectedLength) {
    throw new TossCredentialVaultError("invalid-vault", "암호화 보관함 형식이 올바르지 않습니다.");
  }
  return bytes;
}

function isStoredCredentialVault(value: unknown): value is StoredCredentialVault {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<StoredCredentialVault>;
  return (
    candidate.version === VAULT_VERSION &&
    candidate.kdf?.name === "PBKDF2" &&
    candidate.kdf.hash === "SHA-256" &&
    candidate.kdf.iterations === PBKDF2_ITERATIONS &&
    typeof candidate.kdf.salt === "string" &&
    candidate.cipher?.name === "AES-GCM" &&
    typeof candidate.cipher.iv === "string" &&
    typeof candidate.cipher.ciphertext === "string" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.updatedAt === "string"
  );
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function readStoredVault(options?: VaultFileOptions): Promise<StoredCredentialVault> {
  const target = filePath(options);
  let details;
  try {
    details = await stat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new TossCredentialVaultError("vault-not-found", "저장된 Toss 보관함이 없습니다.");
    }
    throw new TossCredentialVaultError("vault-unavailable", "Toss 보관함을 읽을 수 없습니다.", {
      cause: error,
    });
  }
  if (!details.isFile() || details.size <= 0 || details.size > MAX_VAULT_BYTES) {
    throw new TossCredentialVaultError("invalid-vault", "암호화 보관함 형식이 올바르지 않습니다.");
  }
  try {
    const parsed: unknown = JSON.parse(await readFile(target, "utf8"));
    if (!isStoredCredentialVault(parsed)) {
      throw new TossCredentialVaultError("invalid-vault", "암호화 보관함 형식이 올바르지 않습니다.");
    }
    return parsed;
  } catch (error) {
    if (error instanceof TossCredentialVaultError) throw error;
    throw new TossCredentialVaultError("invalid-vault", "암호화 보관함 형식이 올바르지 않습니다.", {
      cause: error,
    });
  }
}

async function decryptStoredVault(
  stored: StoredCredentialVault,
  passphrase: string,
): Promise<TossVaultCredentials> {
  const salt = bytesFromBase64(stored.kdf.salt, 16);
  const iv = bytesFromBase64(stored.cipher.iv, 12);
  const ciphertext = bytesFromBase64(stored.cipher.ciphertext);
  if (ciphertext.byteLength < 17) {
    throw new TossCredentialVaultError("invalid-vault", "암호화 보관함 형식이 올바르지 않습니다.");
  }
  try {
    const key = await deriveKey(requirePassphrase(passphrase), salt);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: VAULT_AAD, tagLength: 128 },
      key,
      ciphertext,
    );
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError("Invalid credential payload.");
    }
    const candidate = parsed as Partial<TossVaultCredentials>;
    return normalizeTossVaultCredentials({
      clientId: candidate.clientId ?? "",
      clientSecret: candidate.clientSecret ?? "",
      ...(candidate.preferredAccountSeq === undefined
        ? {}
        : { preferredAccountSeq: candidate.preferredAccountSeq }),
    });
  } catch (error) {
    if (error instanceof TossCredentialVaultError && error.code !== "invalid-passphrase") {
      throw error;
    }
    throw new TossCredentialVaultError(
      "vault-unlock-failed",
      "보관함 암호가 맞지 않거나 보관함이 손상되었습니다.",
      { cause: error },
    );
  }
}

export function getUnlockedTossCredentials(
  now: () => number = Date.now,
): TossVaultCredentials | null {
  if (!unlockedState) return null;
  if (now() >= unlockedState.expiresAtMs) {
    unlockedState = null;
    return null;
  }
  return { ...unlockedState.credentials };
}

export function activateTossCredentials(
  credentials: TossVaultCredentials,
  now: () => number = Date.now,
): string {
  const normalized = normalizeTossVaultCredentials(credentials);
  const expiresAtMs = now() + SESSION_LIFETIME_MS;
  unlockedState = { credentials: normalized, expiresAtMs };
  return new Date(expiresAtMs).toISOString();
}

export function lockTossCredentialVault(): void {
  unlockedState = null;
}

export async function getTossCredentialVaultStatus(
  options?: VaultFileOptions,
): Promise<TossCredentialVaultStatus> {
  let exists = false;
  try {
    const details = await stat(filePath(options));
    exists = details.isFile() && details.size > 0 && details.size <= MAX_VAULT_BYTES;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new TossCredentialVaultError("vault-unavailable", "Toss 보관함 상태를 확인할 수 없습니다.", {
        cause: error,
      });
    }
  }
  const now = options?.now ?? Date.now;
  const credentials = getUnlockedTossCredentials(now);
  return {
    exists,
    unlocked: credentials !== null,
    expiresAt: credentials && unlockedState ? new Date(unlockedState.expiresAtMs).toISOString() : null,
  };
}

export async function decryptTossCredentialVault(
  passphrase: string,
  options?: VaultFileOptions,
): Promise<TossVaultCredentials> {
  return decryptStoredVault(await readStoredVault(options), passphrase);
}

export async function saveTossCredentialVault(
  credentials: TossVaultCredentials,
  passphrase: string,
  options?: VaultFileOptions,
): Promise<void> {
  const normalized = normalizeTossVaultCredentials(credentials);
  const secret = requirePassphrase(passphrase);
  const target = filePath(options);
  let createdAt = new Date((options?.now ?? Date.now)()).toISOString();
  try {
    const existing = await readStoredVault(options);
    await decryptStoredVault(existing, secret);
    createdAt = existing.createdAt;
  } catch (error) {
    if (!(error instanceof TossCredentialVaultError) || error.code !== "vault-not-found") throw error;
  }

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(secret, salt);
  const plaintext = new TextEncoder().encode(JSON.stringify(normalized));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: VAULT_AAD, tagLength: 128 },
      key,
      plaintext,
    ),
  );
  const updatedAt = new Date((options?.now ?? Date.now)()).toISOString();
  const stored: StoredCredentialVault = {
    version: VAULT_VERSION,
    kdf: {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations: PBKDF2_ITERATIONS,
      salt: base64(salt),
    },
    cipher: { name: "AES-GCM", iv: base64(iv), ciphertext: base64(ciphertext) },
    createdAt,
    updatedAt,
  };

  const parent = dirname(target);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, target);
    await chmod(target, 0o600).catch(() => undefined);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw new TossCredentialVaultError("vault-write-failed", "암호화 보관함을 저장하지 못했습니다.", {
      cause: error,
    });
  }
}

export async function deleteTossCredentialVault(
  passphrase: string,
  options?: VaultFileOptions,
): Promise<void> {
  await decryptTossCredentialVault(passphrase, options);
  try {
    await unlink(filePath(options));
    lockTossCredentialVault();
  } catch (error) {
    throw new TossCredentialVaultError("vault-delete-failed", "암호화 보관함을 삭제하지 못했습니다.", {
      cause: error,
    });
  }
}
