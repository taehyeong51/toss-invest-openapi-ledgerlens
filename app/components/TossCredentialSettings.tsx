"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import { apiErrorMessage, formatDate } from "../lib/format";

interface CredentialVaultStatus {
  available: true;
  activeSource: "demo" | "environment" | "relay" | "vault";
  storage: "local-encrypted-file";
  vault: {
    exists: boolean;
    unlocked: boolean;
    expiresAt: string | null;
  };
}

interface TossAccountOption {
  selection: number;
  maskedNumber: string;
  accountType: string;
}

interface TossCredentialSettingsProps {
  onConnectionChanged: () => Promise<void>;
}

function isLoopbackBrowser(): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
}

function subscribeToBrowserLocation(): () => void {
  return () => undefined;
}

function getServerLoopbackSnapshot(): null {
  return null;
}

async function credentialRequest<T>(method: string, intent?: string, body?: unknown): Promise<T> {
  const response = await fetch("/api/toss-credentials", {
    method,
    headers: {
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(intent ? { "X-LedgerLens-Intent": intent } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(apiErrorMessage(payload, "Toss 연결 설정을 처리하지 못했습니다."));
  return payload as T;
}

function sourceLabel(source: CredentialVaultStatus["activeSource"]): string {
  const labels: Record<CredentialVaultStatus["activeSource"], string> = {
    demo: "Demo",
    environment: "서버 환경변수",
    relay: "고정-egress Relay",
    vault: "로컬 암호화 보관함",
  };
  return labels[source];
}

export function TossCredentialSettings({ onConnectionChanged }: TossCredentialSettingsProps) {
  const local = useSyncExternalStore(
    subscribeToBrowserLocation,
    isLoopbackBrowser,
    getServerLoopbackSnapshot,
  );
  const [status, setStatus] = useState<CredentialVaultStatus | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [accounts, setAccounts] = useState<TossAccountOption[]>([]);
  const [selectedAccountSelection, setSelectedAccountSelection] = useState("");
  const [busy, setBusy] = useState<"status" | "validate" | "save" | "unlock" | "lock" | "delete" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showReplacement, setShowReplacement] = useState(false);

  const refreshStatus = useCallback(async (showProgress = false) => {
    if (showProgress) setBusy("status");
    try {
      setStatus(await credentialRequest<CredentialVaultStatus>("GET"));
    } finally {
      if (showProgress) setBusy(null);
    }
  }, []);

  useEffect(() => {
    if (local !== true) return;
    const timeout = window.setTimeout(() => {
      void refreshStatus(true).catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : "보관함 상태를 확인하지 못했습니다.");
      });
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [local, refreshStatus]);

  const canSave = useMemo(
    () =>
      accounts.length > 0 &&
      selectedAccountSelection !== "" &&
      passphrase.length >= 12 &&
      busy === null,
    [accounts.length, selectedAccountSelection, passphrase.length, busy],
  );

  function clearMessages() {
    setNotice(null);
    setError(null);
  }

  function updateClientId(value: string) {
    setClientId(value);
    setAccounts([]);
    setSelectedAccountSelection("");
  }

  function updateClientSecret(value: string) {
    setClientSecret(value);
    setAccounts([]);
    setSelectedAccountSelection("");
  }

  async function validate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    clearMessages();
    setBusy("validate");
    try {
      const result = await credentialRequest<{ accounts: TossAccountOption[] }>(
        "POST",
        "validate-toss-credentials",
        { clientId, clientSecret },
      );
      setAccounts(result.accounts);
      setSelectedAccountSelection(String(result.accounts[0]?.selection ?? ""));
      setNotice(
        result.accounts.length === 1
          ? "Toss 인증과 계좌 조회를 확인했습니다. 보관함 암호를 정한 뒤 저장하세요."
          : `${result.accounts.length}개 계좌를 확인했습니다. 사용할 계좌를 선택하세요.`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Toss 자격 증명을 확인하지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    clearMessages();
    setBusy("save");
    try {
      const result = await credentialRequest<{
        saved: true;
        expiresAt: string;
        selectedAccount: TossAccountOption;
      }>("PUT", "save-toss-credentials", {
        clientId,
        clientSecret,
        passphrase,
        preferredAccountSelection: Number(selectedAccountSelection),
      });
      setClientId("");
      setClientSecret("");
      setPassphrase("");
      setAccounts([]);
      setSelectedAccountSelection("");
      setShowReplacement(false);
      await refreshStatus();
      await onConnectionChanged();
      setNotice(
        `${result.selectedAccount.maskedNumber} 계좌를 연결했습니다. ${formatDate(result.expiresAt, true)}까지 서버 메모리에서 잠금 해제됩니다.`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "암호화 보관함을 저장하지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }

  async function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    clearMessages();
    setBusy("unlock");
    try {
      const result = await credentialRequest<{ unlocked: true; expiresAt: string }>(
        "PATCH",
        "manage-toss-credential-vault",
        { action: "unlock", passphrase },
      );
      setPassphrase("");
      await refreshStatus();
      await onConnectionChanged();
      setNotice(`보관함을 열었습니다. ${formatDate(result.expiresAt, true)}까지 연결이 유지됩니다.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "보관함을 열지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }

  async function lock() {
    clearMessages();
    setBusy("lock");
    try {
      await credentialRequest("PATCH", "manage-toss-credential-vault", { action: "lock" });
      await refreshStatus();
      await onConnectionChanged();
      setNotice("서버 메모리의 Toss 연결을 잠갔습니다. 암호화 파일은 그대로 남아 있습니다.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "보관함을 잠그지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    clearMessages();
    if (!window.confirm("이 PC의 암호화된 Toss 자격 증명 파일을 삭제할까요? 이 작업은 되돌릴 수 없습니다.")) {
      return;
    }
    setBusy("delete");
    try {
      await credentialRequest("DELETE", "delete-toss-credential-vault", { passphrase });
      setPassphrase("");
      setShowReplacement(false);
      await refreshStatus();
      await onConnectionChanged();
      setNotice("이 PC의 암호화된 Toss 자격 증명 파일을 삭제했습니다.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "보관함을 삭제하지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }

  const setupVisible = Boolean(status && (!status.vault.exists || showReplacement));

  return (
    <section className="credential-settings" aria-labelledby="toss-credential-title">
      <div className="section-heading-inline">
        <div>
          <h2 id="toss-credential-title">내 Toss Open API 연결</h2>
          <p>개인 PC에서 키를 검증하고 암호화해 저장합니다. 주문 API는 추가되지 않습니다.</p>
        </div>
        {status ? <span className={`credential-source source-${status.activeSource}`}>{sourceLabel(status.activeSource)}</span> : null}
      </div>

      {local === false ? (
        <div className="status-notice warning" role="status">
          키 입력은 원격·공개 주소에서 차단됩니다. 이 앱을 실행한 PC의 <code>http://localhost:3000</code>에서만 보관함을 설정하세요.
        </div>
      ) : null}
      {local === true && busy === "status" && !status ? <div className="inline-loader">보관함 상태를 확인하는 중…</div> : null}

      {status?.activeSource === "environment" || status?.activeSource === "relay" ? (
        <div className="status-notice" role="status">
          현재 {sourceLabel(status.activeSource)} 설정이 우선 적용됩니다. 로컬 보관함을 사용하려면 서버의 해당 환경 설정을 제거하고 다시 시작하세요.
        </div>
      ) : null}

      {status?.vault.exists && !status.vault.unlocked ? (
        <form className="credential-unlock" onSubmit={unlock}>
          <label>
            <span>보관함 암호</span>
            <input
              type="password"
              value={passphrase}
              minLength={12}
              maxLength={256}
              autoComplete="current-password"
              onChange={(event) => setPassphrase(event.target.value)}
              required
            />
          </label>
          <button className="primary-button" type="submit" disabled={busy !== null || passphrase.length < 12}>
            {busy === "unlock" ? "확인 중…" : "검증 후 연결"}
          </button>
          <button className="text-button" type="button" onClick={() => setShowReplacement((current) => !current)}>
            {showReplacement ? "교체 취소" : "저장된 키 교체"}
          </button>
        </form>
      ) : null}

      {status?.vault.unlocked ? (
        <div className="credential-unlocked">
          <div>
            <strong>보관함 잠금 해제됨</strong>
            <span>{status.vault.expiresAt ? `${formatDate(status.vault.expiresAt, true)}까지` : "현재 세션"} · 서버 메모리에만 복호화</span>
          </div>
          <button className="secondary-button" type="button" disabled={busy !== null} onClick={lock}>
            {busy === "lock" ? "잠그는 중…" : "지금 잠그기"}
          </button>
          <button className="text-button" type="button" onClick={() => setShowReplacement((current) => !current)}>
            {showReplacement ? "교체 취소" : "키 교체"}
          </button>
        </div>
      ) : null}

      {setupVisible ? (
        <form className="credential-setup" onSubmit={validate}>
          <div className="credential-fields">
            <label>
              <span>Client ID</span>
              <input
                value={clientId}
                maxLength={256}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => updateClientId(event.target.value)}
                required
              />
            </label>
            <label>
              <span>Client Secret</span>
              <input
                type={showSecret ? "text" : "password"}
                value={clientSecret}
                maxLength={512}
                autoComplete="new-password"
                spellCheck={false}
                onChange={(event) => updateClientSecret(event.target.value)}
                required
              />
            </label>
            <label className="secret-visibility">
              <input type="checkbox" checked={showSecret} onChange={(event) => setShowSecret(event.target.checked)} />
              <span>Secret 표시</span>
            </label>
          </div>
          <div className="credential-actions">
            <button className="secondary-button" type="submit" disabled={busy !== null || !clientId || !clientSecret}>
              {busy === "validate" ? "Toss 확인 중…" : "키와 계좌 확인"}
            </button>
            <span>현재 서버의 공인 IP가 WTS 허용 IP에 등록되어 있어야 합니다.</span>
          </div>

          {accounts.length > 0 ? (
            <div className="credential-confirmation">
              <label>
                <span>사용할 계좌</span>
                <select
                  value={selectedAccountSelection}
                  onChange={(event) => setSelectedAccountSelection(event.target.value)}
                  required
                >
                  {accounts.map((account) => (
                    <option key={account.selection} value={account.selection}>
                      {account.maskedNumber} · {account.accountType}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>보관함 암호 <small>12자 이상 · 분실 시 복구 불가</small></span>
                <input
                  type="password"
                  value={passphrase}
                  minLength={12}
                  maxLength={256}
                  autoComplete="new-password"
                  onChange={(event) => setPassphrase(event.target.value)}
                  required
                />
              </label>
              <button className="primary-button" type="button" disabled={!canSave} onClick={save}>
                {busy === "save" ? "암호화 저장 중…" : "암호화 저장 후 연결"}
              </button>
            </div>
          ) : null}
        </form>
      ) : null}

      {status?.vault.exists ? (
        <details className="credential-danger-zone">
          <summary>보관함 삭제</summary>
          <p>암호화 파일과 현재 연결을 모두 제거합니다. 삭제하려면 보관함 암호가 필요합니다.</p>
          <div>
            <label>
              <span className="sr-only">삭제 확인용 보관함 암호</span>
              <input
                type="password"
                value={passphrase}
                minLength={12}
                maxLength={256}
                autoComplete="current-password"
                placeholder="보관함 암호"
                onChange={(event) => setPassphrase(event.target.value)}
              />
            </label>
            <button className="danger-button" type="button" disabled={busy !== null || passphrase.length < 12} onClick={remove}>
              {busy === "delete" ? "삭제 중…" : "이 PC에서 보관함 삭제"}
            </button>
          </div>
        </details>
      ) : null}

      <ul className="credential-guardrails">
        <li>Client Secret과 보관함 암호는 브라우저 저장소, URL, 로그, 응답에 남기지 않습니다.</li>
        <li>키는 PBKDF2-SHA-256과 AES-256-GCM으로 암호화되어 <code>private-data/</code>에 저장되며 Git에서 제외됩니다.</li>
        <li>서버 재시작 또는 8시간 후에는 보관함 암호로 다시 열어야 합니다.</li>
        <li><a href="https://developers.tossinvest.com/docs" target="_blank" rel="noreferrer">Toss 공식 가이드</a>에서 키 발급과 WTS 허용 IP를 먼저 확인하세요.</li>
      </ul>

      {error ? <div className="status-notice danger" role="alert">{error}</div> : null}
      {notice ? <div className="status-notice" role="status">{notice}</div> : null}
    </section>
  );
}
