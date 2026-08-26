"use client";

import { formatDate, formatKrw, formatPercent } from "../lib/format";

export type ExternalAssetReviewStatus = "loading" | "ready" | "demo" | "unavailable";
export type ExternalAssetReviewSeverity = "warning" | "attention" | "info";
export type ExternalAssetReviewIssueCode =
  | "valuation-stale"
  | "maturity-overdue"
  | "maturity-soon";

export interface ExternalAssetReviewIssue {
  code: ExternalAssetReviewIssueCode;
  assetId: string;
  name: string;
  severity: ExternalAssetReviewSeverity;
  message: string;
  valuedAt?: string | null;
  maturityDate?: string | null;
}

export interface ExternalAssetReviewDiagnostics {
  status?: Exclude<ExternalAssetReviewStatus, "loading">;
  asOf: string;
  staleAfterDays: number;
  maturityWindowDays: number;
  staleCount: number;
  maturitySoonCount: number;
  overdueCount: number;
  cashLikeValueKrw: string;
  usdValueKrw: string;
  largestAsset: {
    assetId?: string;
    name: string;
    valueKrw: string;
    share?: string | null;
  } | null;
  issues: ExternalAssetReviewIssue[];
}

interface ExternalAssetReviewQueueProps {
  diagnostics: ExternalAssetReviewDiagnostics | null;
  status?: ExternalAssetReviewStatus;
  maxIssues?: number;
}

function issueLabel(issue: ExternalAssetReviewIssue): string {
  if (issue.code === "maturity-overdue") return "만기 경과";
  if (issue.code === "maturity-soon") return "만기 예정";
  return "평가 갱신";
}

function issueDate(issue: ExternalAssetReviewIssue): string | null {
  if (issue.code === "valuation-stale" && issue.valuedAt) {
    return `평가 기준 ${formatDate(issue.valuedAt)}`;
  }
  if (issue.maturityDate) return `만기 ${formatDate(issue.maturityDate)}`;
  return null;
}

function QueueState({ status }: { status: Exclude<ExternalAssetReviewStatus, "ready"> }) {
  const copy = status === "loading"
    ? {
        title: "점검 항목을 계산하는 중입니다",
        description: "평가 기준일과 예적금 만기일을 확인하고 있습니다.",
        role: "status" as const,
      }
    : status === "demo"
      ? {
          title: "데모에는 실제 점검 항목이 없습니다",
          description: "수동 자산을 등록하면 오래된 평가값과 다가오는 만기를 한곳에서 확인할 수 있습니다.",
          role: "note" as const,
        }
      : {
          title: "자산 점검 정보를 불러오지 못했습니다",
          description: "수동 자산 저장소 연결을 확인한 뒤 다시 불러오세요.",
          role: "alert" as const,
        };

  return <div className={`asset-review-state ${status}`} role={copy.role}><strong>{copy.title}</strong><p>{copy.description}</p></div>;
}

export function ExternalAssetReviewQueue({
  diagnostics,
  status,
  maxIssues = 6,
}: ExternalAssetReviewQueueProps) {
  const visibleStatus = status ?? diagnostics?.status ?? (diagnostics ? "ready" : "loading");
  const visibleIssues = diagnostics?.issues.slice(0, Math.max(1, maxIssues)) ?? [];
  const hiddenIssueCount = Math.max(0, (diagnostics?.issues.length ?? 0) - visibleIssues.length);

  return (
    <section className="asset-review-queue" aria-labelledby="asset-review-title">
      <div className="asset-review-heading">
        <div>
          <h2 id="asset-review-title">수동 자산 점검</h2>
          <p>오래된 평가값과 예적금 만기를 먼저 확인할 수 있도록 사실 기반 항목만 모았습니다.</p>
        </div>
        {diagnostics && visibleStatus === "ready" ? <span>기준 {formatDate(diagnostics.asOf)}</span> : null}
      </div>

      {visibleStatus !== "ready" || !diagnostics ? (
        <QueueState status={visibleStatus === "ready" ? "loading" : visibleStatus} />
      ) : (
        <>
          <dl className="asset-review-counts" aria-label="수동 자산 점검 건수">
            <div><dt>평가 갱신 필요</dt><dd>{diagnostics.staleCount}건</dd><span>{diagnostics.staleAfterDays}일 초과</span></div>
            <div><dt>만기 임박</dt><dd>{diagnostics.maturitySoonCount}건</dd><span>{diagnostics.maturityWindowDays}일 이내</span></div>
            <div><dt>만기 경과</dt><dd>{diagnostics.overdueCount}건</dd><span>기준일 이전</span></div>
          </dl>

          <div className="asset-review-body">
            <div className="asset-review-issues">
              <h3>확인할 항목</h3>
              {visibleIssues.length ? (
                <ol>
                  {visibleIssues.map((issue) => (
                    <li key={`${issue.assetId}-${issue.code}`} data-severity={issue.severity}>
                      <div>
                        <span>{issueLabel(issue)}</span>
                        <strong>{issue.name}</strong>
                        {issueDate(issue) ? <small>{issueDate(issue)}</small> : null}
                      </div>
                      <p>{issue.message}</p>
                    </li>
                  ))}
                </ol>
              ) : (
                <div className="asset-review-empty" role="status">
                  <strong>지금 확인할 항목이 없습니다</strong>
                  <p>등록된 평가 기준일과 만기일이 현재 점검 기준 안에 있습니다.</p>
                </div>
              )}
              {hiddenIssueCount > 0 ? <p className="asset-review-more">그 밖의 점검 항목 {hiddenIssueCount}건이 있습니다.</p> : null}
            </div>

            <div className="asset-review-facts">
              <h3>구성 사실</h3>
              <dl>
                <div><dt>현금·예적금</dt><dd>{formatKrw(diagnostics.cashLikeValueKrw)}</dd></div>
                <div><dt>USD 표시 자산</dt><dd>{formatKrw(diagnostics.usdValueKrw)}</dd><span>원화 평가액 기준</span></div>
                <div>
                  <dt>가장 큰 수동 자산</dt>
                  <dd>{diagnostics.largestAsset ? diagnostics.largestAsset.name : "등록 없음"}</dd>
                  {diagnostics.largestAsset ? (
                    <span>
                      {formatKrw(diagnostics.largestAsset.valueKrw)}
                      {diagnostics.largestAsset.share ? ` · 수동 자산의 ${formatPercent(diagnostics.largestAsset.share)}` : ""}
                    </span>
                  ) : null}
                </div>
              </dl>
            </div>
          </div>

          <p className="asset-review-disclosure" role="note">
            이 목록은 입력값의 날짜와 비중을 보여주는 점검 보조 정보입니다. 금융상품의 갱신·해지·매매를 권하는 판단이 아닙니다.
          </p>
        </>
      )}
    </section>
  );
}
