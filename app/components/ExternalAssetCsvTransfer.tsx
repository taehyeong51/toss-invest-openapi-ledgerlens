"use client";

import { useRef, useState, type ChangeEvent } from "react";
import { apiErrorMessage, formatKrw } from "../lib/format";
import type {
  ExternalAssetKind,
  ExternalAssetsPayload,
  PortfolioPayload,
} from "../lib/ui-types";

interface ExternalAssetCsvTransferProps {
  payload: ExternalAssetsPayload;
  mode: PortfolioPayload["mode"];
  onImported: (payload: ExternalAssetsPayload) => Promise<void>;
}

interface CsvPreview {
  status: "preview";
  rowCount: number;
  totalValueKrw: string;
  kindCounts: Record<ExternalAssetKind, number>;
  warnings: string[];
}

interface CsvImportResult {
  status: "imported";
  rowCount: number;
  createdCount: number;
  replayedCount: number;
  warnings: string[];
  payload: ExternalAssetsPayload;
}

interface SelectedCsv {
  generation: number;
  name: string;
  file: File;
  bytes: number;
}

const MAX_CSV_BYTES = 256 * 1024;
const KIND_LABELS: Array<{ kind: ExternalAssetKind; label: string }> = [
  { kind: "cash", label: "현금·입출금" },
  { kind: "deposit", label: "예금" },
  { kind: "savings", label: "적금" },
  { kind: "pension", label: "연금" },
  { kind: "insurance", label: "보험" },
  { kind: "property", label: "부동산" },
  { kind: "crypto", label: "가상자산" },
  { kind: "other", label: "기타" },
];

async function responseError(response: Response, fallback: string): Promise<Error> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON failures still receive a safe, local fallback.
  }
  return new Error(apiErrorMessage(body, fallback));
}

function exportFilename(response: Response): string {
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const matched = disposition.match(/filename="?([^";]+)"?/i);
  return matched?.[1]?.trim() || "ledgerlens-external-assets.csv";
}

export function ExternalAssetCsvTransfer({
  payload,
  mode,
  onImported,
}: ExternalAssetCsvTransferProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const idempotencyKey = useRef<string | null>(null);
  const selectionGeneration = useRef(0);
  const [selected, setSelected] = useState<SelectedCsv | null>(null);
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [importResult, setImportResult] = useState<CsvImportResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canWrite = mode !== "demo" && payload.status === "ready";

  async function selectFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0] ?? null;
    setPreview(null);
    setImportResult(null);
    setError(null);
    idempotencyKey.current = null;
    selectionGeneration.current += 1;
    const generation = selectionGeneration.current;
    if (!file) {
      setSelected(null);
      return;
    }
    if (file.size > MAX_CSV_BYTES) {
      setSelected(null);
      setError("CSV 파일은 256 KiB 이하여야 합니다.");
      event.target.value = "";
      return;
    }
    try {
      const bytes = await file.arrayBuffer();
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (selectionGeneration.current !== generation) return;
      setSelected({ generation, name: file.name, file, bytes: file.size });
      idempotencyKey.current = `csv-import-${crypto.randomUUID()}`;
    } catch {
      if (selectionGeneration.current !== generation) return;
      setSelected(null);
      setError("CSV 파일은 올바른 UTF-8이어야 합니다. 인코딩을 UTF-8 CSV로 바꾼 뒤 다시 선택해 주세요.");
      event.target.value = "";
    }
  }

  async function requestPreview(): Promise<void> {
    if (!selected) return;
    setPreviewing(true);
    setPreview(null);
    setImportResult(null);
    setError(null);
    const generation = selected.generation;
    try {
      const response = await fetch("/api/external-assets/import?dryRun=true", {
        method: "POST",
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "X-LedgerLens-Intent": "import-external-assets",
        },
        body: selected.file,
      });
      if (!response.ok) {
        throw await responseError(response, "CSV 내용을 검증하지 못했습니다.");
      }
      const result = await response.json() as CsvPreview;
      if (selectionGeneration.current === generation) setPreview(result);
    } catch (caught) {
      if (selectionGeneration.current === generation) {
        setError(caught instanceof Error ? caught.message : "CSV 내용을 검증하지 못했습니다.");
      }
    } finally {
      setPreviewing(false);
    }
  }

  async function confirmImport(): Promise<void> {
    if (!selected || !preview || preview.rowCount === 0 || !canWrite || !idempotencyKey.current) return;
    setImporting(true);
    setImportResult(null);
    setError(null);
    try {
      const response = await fetch("/api/external-assets/import", {
        method: "POST",
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Idempotency-Key": idempotencyKey.current,
          "X-LedgerLens-Intent": "import-external-assets",
        },
        body: selected.file,
      });
      if (!response.ok) {
        throw await responseError(response, "CSV 자산을 저장하지 못했습니다.");
      }
      const result = await response.json() as CsvImportResult;
      setImportResult(result);
      await onImported(result.payload);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "CSV 자산을 저장하지 못했습니다.");
    } finally {
      setImporting(false);
    }
  }

  async function downloadExport(): Promise<void> {
    setExporting(true);
    setError(null);
    try {
      const response = await fetch("/api/external-assets/export", { cache: "no-store" });
      if (!response.ok) {
        throw await responseError(response, "외부 자산 CSV를 만들지 못했습니다.");
      }
      const objectUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = exportFilename(response);
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "외부 자산 CSV를 만들지 못했습니다.");
    } finally {
      setExporting(false);
    }
  }

  function resetSelection(): void {
    setSelected(null);
    setPreview(null);
    setImportResult(null);
    setError(null);
    idempotencyKey.current = null;
    selectionGeneration.current += 1;
    if (inputRef.current) inputRef.current.value = "";
    window.requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
  }

  return (
    <section className="csv-transfer" aria-labelledby="csv-transfer-title">
      <div className="section-heading-inline csv-transfer-heading">
        <div>
          <h2 id="csv-transfer-title">외부 자산 CSV</h2>
          <p>현재 수동 자산을 내려받거나, 같은 열 구조의 CSV를 검증한 뒤 장부에 추가합니다.</p>
        </div>
        <button
          className="secondary-button"
          type="button"
          disabled={exporting || payload.status === "unavailable"}
          onClick={() => void downloadExport()}
        >
          {exporting ? "내보내는 중…" : `현재 장부 내보내기 · ${payload.count}건`}
        </button>
      </div>

      <div className="csv-flow">
        <div className="csv-file-step">
          <span className="csv-step-index" aria-hidden="true">01</span>
          <div>
            <label htmlFor="external-assets-csv">CSV 파일 선택</label>
            <p id="external-assets-csv-help">UTF-8 CSV · 최대 250행 · 256 KiB 이하</p>
          </div>
          <input
            ref={inputRef}
            id="external-assets-csv"
            type="file"
            accept=".csv,text/csv"
            aria-describedby="external-assets-csv-help"
            disabled={previewing || importing}
            onChange={(event) => void selectFile(event)}
          />
        </div>

        <div className="csv-file-summary">
          <div>
            <span>선택 파일</span>
            <strong>{selected?.name ?? "아직 선택하지 않음"}</strong>
            <small>{selected ? `${selected.bytes.toLocaleString("ko-KR")} bytes` : "내보낸 파일을 그대로 다시 사용할 수 있습니다."}</small>
          </div>
          <div className="csv-file-actions">
            {selected ? <button className="text-button" type="button" disabled={previewing || importing} onClick={resetSelection}>선택 취소</button> : null}
            <button className="secondary-button" type="button" disabled={!selected || previewing || importing} onClick={() => void requestPreview()}>
              {previewing ? "검증 중…" : "검증 미리보기"}
            </button>
          </div>
        </div>
      </div>

      <p className="csv-boundary-note">
        Import는 기존 항목을 수정하거나 종료하지 않고 새 현재값을 추가합니다. 완전히 같은 정규화 행을 같은 발생 순서로 다시 가져오면 중복 저장하지 않지만, 값이 달라진 행은 새 자산으로 취급합니다.
      </p>

      {preview ? (
        <div className="csv-preview" aria-live="polite">
          <div className="csv-preview-summary">
            <span className="csv-step-index" aria-hidden="true">02</span>
            <div><span>검증 행</span><strong>{preview.rowCount}건</strong></div>
            <div><span>CSV 평가액 합계</span><strong>{formatKrw(preview.totalValueKrw)}</strong></div>
            <button className="primary-button" type="button" disabled={!canWrite || importing || importResult !== null || preview.rowCount === 0} onClick={() => void confirmImport()}>
              {importing ? "저장 중…" : importResult ? "저장 완료" : "확인하고 가져오기"}
            </button>
          </div>
          <dl className="csv-kind-counts">
            {KIND_LABELS.map(({ kind, label }) => (
              <div key={kind}><dt>{label}</dt><dd>{preview.kindCounts[kind] ?? 0}건</dd></div>
            ))}
          </dl>
          {preview.rowCount === 0 ? (
            <p className="csv-write-disabled" role="note">가져올 데이터 행이 없습니다. 이 헤더 전용 파일은 CSV 템플릿으로 사용할 수 있습니다.</p>
          ) : preview.warnings.length ? <ul className="csv-warning-list">{preview.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : <p className="csv-preview-clear">형식과 필수값 검증을 통과했습니다.</p>}
          {!canWrite ? (
            <p className="csv-write-disabled" role="note">
              {mode === "demo" ? "Demo에서는 실제 저장하지 않습니다. CSV 검증 결과만 확인할 수 있습니다." : "외부 자산 저장소를 사용할 수 없어 실제 저장을 중단했습니다."}
            </p>
          ) : null}
        </div>
      ) : null}

      {importResult ? (
        <p className="csv-success" role="status">
          CSV {importResult.rowCount}행을 처리해 {importResult.createdCount}건을 추가했습니다. 중복 방지로 다시 사용된 행은 {importResult.replayedCount}건입니다.
        </p>
      ) : null}
      {error ? <p className="csv-error" role="alert">{error}</p> : null}
    </section>
  );
}
