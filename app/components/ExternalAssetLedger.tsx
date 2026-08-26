"use client";

import { useMemo, useRef, useState, type FormEvent } from "react";
import {
  DECIMAL_INPUT_PATTERN,
  apiErrorMessage,
  formatDate,
  formatDecimal,
  formatKrw,
} from "../lib/format";
import type {
  ExternalAssetItem,
  ExternalAssetKind,
  ExternalAssetsPayload,
  PortfolioPayload,
} from "../lib/ui-types";

interface ExternalAssetLedgerProps {
  payload: ExternalAssetsPayload;
  mode: PortfolioPayload["mode"];
  onChanged: (payload: ExternalAssetsPayload) => void;
}

interface ExternalAssetDraft {
  kind: ExternalAssetKind;
  name: string;
  institution: string;
  currency: "KRW" | "USD";
  balance: string;
  valueKrw: string;
  valuedAt: string;
  maturityDate: string;
  annualRatePercent: string;
  note: string;
}

interface ExternalAssetMutationResponse {
  asset: ExternalAssetItem;
  created?: boolean;
  updated?: boolean;
  payload: ExternalAssetsPayload;
}

const KIND_OPTIONS: Array<{ value: ExternalAssetKind; label: string }> = [
  { value: "cash", label: "현금·입출금" },
  { value: "deposit", label: "예금" },
  { value: "savings", label: "적금" },
  { value: "pension", label: "연금" },
  { value: "insurance", label: "보험" },
  { value: "property", label: "부동산" },
  { value: "crypto", label: "가상자산" },
  { value: "other", label: "기타" },
];

function kindLabel(kind: ExternalAssetKind): string {
  return KIND_OPTIONS.find((option) => option.value === kind)?.label ?? kind;
}

function currentLocalDate(): string {
  const now = new Date();
  return new Date(now.getTime() + 9 * 60 * 60 * 1_000)
    .toISOString()
    .slice(0, 10);
}

function localDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 10);
}

function emptyDraft(): ExternalAssetDraft {
  return {
    kind: "cash",
    name: "",
    institution: "",
    currency: "KRW",
    balance: "",
    valueKrw: "",
    valuedAt: currentLocalDate(),
    maturityDate: "",
    annualRatePercent: "",
    note: "",
  };
}

function draftFromAsset(asset: ExternalAssetItem): ExternalAssetDraft {
  return {
    kind: asset.kind,
    name: asset.name,
    institution: asset.institution,
    currency: asset.currency === "USD" ? "USD" : "KRW",
    balance: asset.balance,
    valueKrw: asset.valueKrw,
    valuedAt: localDate(asset.valuedAt),
    maturityDate: asset.maturityDate ?? "",
    annualRatePercent: asset.annualRatePercent ?? "",
    note: asset.note ?? "",
  };
}

function nativeBalance(asset: ExternalAssetItem): string {
  if (asset.currency === "KRW") return formatKrw(asset.balance);
  if (asset.currency === "USD") return `$${formatDecimal(asset.balance, 2)}`;
  return `${formatDecimal(asset.balance, 2)} ${asset.currency}`;
}

function canonicalDecimalInput(value: string): string {
  const [integer, fraction] = value.split(".");
  const trimmedFraction = fraction?.replace(/0+$/, "") ?? "";
  return trimmedFraction ? `${integer}.${trimmedFraction}` : integer;
}

function assetTerms(asset: ExternalAssetItem): string {
  const terms = [
    asset.annualRatePercent === null
      ? null
      : `연 ${formatDecimal(asset.annualRatePercent, 2)}%`,
    asset.maturityDate ? `만기 ${formatDate(asset.maturityDate)}` : null,
  ].filter((value): value is string => value !== null);
  return terms.length ? terms.join(" · ") : "조건 정보 없음";
}

function mutationPayload(value: unknown): ExternalAssetsPayload | null {
  if (!value || typeof value !== "object") return null;
  if ("payload" in value) {
    const response = value as Partial<ExternalAssetMutationResponse>;
    return response.payload ?? null;
  }
  if ("assets" in value && "totalValueKrw" in value) {
    return value as ExternalAssetsPayload;
  }
  return null;
}

export function ExternalAssetLedger({ payload, mode, onChanged }: ExternalAssetLedgerProps) {
  const createIdempotencyKey = useRef<string | null>(null);
  const [draft, setDraft] = useState<ExternalAssetDraft>(() => emptyDraft());
  const [editing, setEditing] = useState<ExternalAssetItem | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const isDemo = mode === "demo" || payload.status === "demo";
  const isUnavailable = payload.status === "unavailable";
  const canWrite = !isDemo && !isUnavailable;
  const assets = useMemo(
    () => [...payload.assets].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [payload.assets],
  );

  function beginCreate(): void {
    if (!canWrite) return;
    createIdempotencyKey.current = `external-asset-${Date.now()}-${crypto.randomUUID()}`;
    setDraft(emptyDraft());
    setEditing(null);
    setError(null);
    setNotice(null);
    setFormOpen(true);
  }

  function beginEdit(asset: ExternalAssetItem): void {
    createIdempotencyKey.current = null;
    setDraft(draftFromAsset(asset));
    setEditing(asset);
    setError(null);
    setNotice(null);
    setFormOpen(true);
  }

  function closeForm(): void {
    if (saving) return;
    createIdempotencyKey.current = null;
    setEditing(null);
    setError(null);
    setFormOpen(false);
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canWrite || saving) return;

    setSaving(true);
    setError(null);
    setNotice(null);

    const body = {
      ...(editing ? { id: editing.id, expectedRevision: editing.revision } : {}),
      kind: draft.kind,
      name: draft.name.trim(),
      institution: draft.institution.trim(),
      currency: draft.currency,
      balance: canonicalDecimalInput(draft.balance),
      valueKrw: canonicalDecimalInput(draft.valueKrw),
      valuedAt: draft.valuedAt,
      maturityDate: draft.maturityDate || null,
      annualRatePercent: draft.annualRatePercent
        ? canonicalDecimalInput(draft.annualRatePercent)
        : null,
      note: draft.note.trim(),
    };
    const idempotencyKey = editing
      ? null
      : createIdempotencyKey.current ??= `external-asset-${Date.now()}-${crypto.randomUUID()}`;

    try {
      const response = await fetch("/api/external-assets", {
        method: editing ? "PUT" : "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-LedgerLens-Intent": editing ? "update-external-asset" : "create-external-asset",
          ...(!editing
            ? { "Idempotency-Key": idempotencyKey as string }
            : {}),
        },
        cache: "no-store",
        body: JSON.stringify(body),
      });
      const responseBody: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(apiErrorMessage(responseBody, "외부 자산을 저장하지 못했습니다."));
      }
      const nextPayload = mutationPayload(responseBody);
      if (!nextPayload) throw new Error("저장 결과 형식을 확인하지 못했습니다.");

      onChanged(nextPayload);
      createIdempotencyKey.current = null;
      setDraft(emptyDraft());
      setEditing(null);
      setFormOpen(false);
      setNotice(editing ? "자산 평가값을 새 이력으로 저장했습니다." : "자산을 수동 장부에 추가했습니다.");
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "외부 자산을 저장하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="external-ledger" aria-labelledby="external-ledger-title">
      <div className="external-heading">
        <div>
          <h2 id="external-ledger-title">현금·예적금·기타 자산</h2>
          <p>토스증권 밖의 자산을 직접 평가해 전체 자산에 더합니다. 이 값은 투자 성과 계산에서는 제외됩니다.</p>
        </div>
        <button className="external-add-button" type="button" onClick={beginCreate} aria-expanded={formOpen} disabled={!canWrite}>
          자산 추가
        </button>
      </div>

      <dl className="external-summary" aria-label="수동 자산 요약">
        <div>
          <dt>수동 평가 합계</dt>
          <dd>{formatKrw(payload.totalValueKrw)}</dd>
        </div>
        <div>
          <dt>등록 항목</dt>
          <dd>{payload.count}건</dd>
        </div>
        <div>
          <dt>최근 수정</dt>
          <dd>{payload.lastUpdatedAt ? formatDate(payload.lastUpdatedAt, true) : "기록 없음"}</dd>
        </div>
        <div>
          <dt>데이터 출처</dt>
          <dd>사용자 수동 입력</dd>
        </div>
      </dl>

      {payload.count > assets.length ? (
        <p className="external-mode-note" role="note">
          전체 {payload.count}건 중 최근 {assets.length}건을 표시합니다. 합계와 최근 수정 시각은 전체 등록분 기준입니다.
        </p>
      ) : null}

      {isUnavailable ? (
        <p className="external-mode-note" role="alert">
          수동 자산 저장소를 불러오지 못했습니다. 등록 총액은 완전하지 않으므로 새로고침 후 다시 확인하세요.
        </p>
      ) : isDemo ? (
        <p className="external-mode-note" role="note">
          데모 모드에서는 예시 구조만 확인할 수 있습니다. 실제 자산 저장은 라이브 연결 후 사용할 수 있습니다.
        </p>
      ) : null}

      {formOpen ? (
        <form className="external-form" onSubmit={submit} aria-label={editing ? "외부 자산 수정" : "외부 자산 추가"}>
          <div className="external-form-heading">
            <div>
              <h3>{editing ? `${editing.name} 수정` : "새 수동 자산"}</h3>
              <p>잔액과 원화 평가액은 자동 시세가 아닌 직접 확인한 값으로 기록됩니다.</p>
            </div>
            <button type="button" className="external-close-button" onClick={closeForm}>닫기</button>
          </div>

          <div className="external-form-grid">
            <label>
              <span>자산 구분</span>
              <select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as ExternalAssetKind })}>
                {KIND_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label>
              <span>자산 이름</span>
              <input value={draft.name} maxLength={80} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="생활비 통장" required />
            </label>
            <label>
              <span>기관 <small>선택</small></span>
              <input value={draft.institution} maxLength={80} onChange={(event) => setDraft({ ...draft, institution: event.target.value })} placeholder="은행 또는 보관처" />
            </label>
            <label>
              <span>통화</span>
              <select value={draft.currency} onChange={(event) => setDraft({ ...draft, currency: event.target.value as "KRW" | "USD" })}>
                <option value="KRW">KRW · 원화</option>
                <option value="USD">USD · 미국 달러</option>
              </select>
            </label>
            <label>
              <span>잔액</span>
              <input value={draft.balance} inputMode="decimal" pattern={DECIMAL_INPUT_PATTERN} onChange={(event) => setDraft({ ...draft, balance: event.target.value })} placeholder="0" required />
            </label>
            <label>
              <span>원화 평가액</span>
              <span className="external-input-unit">
                <input value={draft.valueKrw} inputMode="decimal" pattern={DECIMAL_INPUT_PATTERN} onChange={(event) => setDraft({ ...draft, valueKrw: event.target.value })} placeholder="0" required />
                <em>원</em>
              </span>
            </label>
            <label>
              <span>평가 기준일</span>
              <input type="date" max={currentLocalDate()} value={draft.valuedAt} onChange={(event) => setDraft({ ...draft, valuedAt: event.target.value })} required />
            </label>
            <label>
              <span>만기일 <small>선택</small></span>
              <input type="date" min={draft.valuedAt} value={draft.maturityDate} onChange={(event) => setDraft({ ...draft, maturityDate: event.target.value })} />
            </label>
            <label>
              <span>연 이율 <small>선택</small></span>
              <span className="external-input-unit">
                <input value={draft.annualRatePercent} inputMode="decimal" pattern={DECIMAL_INPUT_PATTERN} onChange={(event) => setDraft({ ...draft, annualRatePercent: event.target.value })} placeholder="0.00" />
                <em>%</em>
              </span>
            </label>
            <label className="external-note-field">
              <span>메모 <small>선택</small></span>
              <input value={draft.note} maxLength={200} onChange={(event) => setDraft({ ...draft, note: event.target.value })} placeholder="평가 근거 또는 갱신 주기" />
            </label>
          </div>

          {draft.kind === "insurance" ? (
            <p className="external-kind-note">
              보험은 납입액이나 보장액이 아니라, 보험사에서 확인한 현재 해지환급금만 원화 평가액으로 입력하세요.
            </p>
          ) : null}

          <div className="external-form-footer">
            <p>저장할 때마다 수정 이력이 남습니다. 전체 자산 합계에는 포함되지만 투자 수익률에는 포함되지 않습니다.</p>
            <button type="submit" disabled={saving || !canWrite}>
              {saving ? "저장 중…" : editing ? "평가값 업데이트" : "수동 자산 저장"}
            </button>
          </div>
          {error ? <p className="external-form-error" role="alert">{error}</p> : null}
        </form>
      ) : null}

      <div className="external-live-message" aria-live="polite">
        {notice ? <p>{notice}</p> : null}
      </div>

      {assets.length ? (
        <>
          <div className="external-table-scroll">
            <table className="external-table">
              <thead>
                <tr>
                  <th>자산</th>
                  <th>잔액</th>
                  <th>원화 평가액</th>
                  <th>평가 기준</th>
                  <th><span className="sr-only">수정</span></th>
                </tr>
              </thead>
              <tbody>
                {assets.map((asset) => (
                  <tr key={asset.id}>
                    <td>
                      <strong>{asset.name}</strong>
                      <span>{kindLabel(asset.kind)} · {asset.institution || "기관 미지정"} · {asset.valueKrw === "0" ? "종료됨" : "수동"}</span>
                    </td>
                    <td>{nativeBalance(asset)}</td>
                    <td><strong>{formatKrw(asset.valueKrw)}</strong></td>
                    <td>
                      {formatDate(asset.valuedAt)}
                      <span>{assetTerms(asset)}</span>
                    </td>
                    <td><button type="button" className="external-row-button" onClick={() => beginEdit(asset)}>수정</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="external-mobile-list" aria-label="수동 자산 목록">
            {assets.map((asset) => (
              <li key={`mobile-${asset.id}`}>
                <div className="external-mobile-title">
                  <div><strong>{asset.name}</strong><span>{kindLabel(asset.kind)} · {asset.institution || "기관 미지정"}{asset.valueKrw === "0" ? " · 종료됨" : ""}</span></div>
                  <strong>{formatKrw(asset.valueKrw)}</strong>
                </div>
                <dl>
                  <div><dt>잔액</dt><dd>{nativeBalance(asset)}</dd></div>
                  <div><dt>평가 기준일</dt><dd>{formatDate(asset.valuedAt)}</dd></div>
                  <div><dt>만기·이율</dt><dd>{assetTerms(asset)}</dd></div>
                </dl>
                <button type="button" onClick={() => beginEdit(asset)}>평가값 수정</button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <div className="external-empty-state">
          <h3>아직 수동 자산이 없습니다</h3>
          <p>현금, 예적금, 연금처럼 토스증권 계좌 밖에 있는 자산부터 한 건씩 등록하세요.</p>
          <button type="button" onClick={beginCreate} disabled={!canWrite}>첫 자산 추가</button>
        </div>
      )}
    </section>
  );
}
