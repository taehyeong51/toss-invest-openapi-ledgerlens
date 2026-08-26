"use client";

import { useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  calculatePlanPace,
  calculateReviewAttribution,
  calculateReviewReliability,
  type CashFlowConfirmation,
} from "@/lib/review/analysis";
import { calculateExternalAssetDiagnostics } from "@/lib/assets/diagnostics";
import { calculateTotalTrackedValueKrw } from "@/lib/portfolio/tracked";
import {
  apiErrorMessage,
  compareDecimal,
  exactDifference,
  exactSum,
  formatAsOf,
  formatCompactKrw,
  formatDate,
  formatDecimal,
  formatKrw,
  formatPercent,
  numeric,
  signedClass,
  signedKrw,
} from "../lib/format";
import type {
  AllocationItem,
  AnalyticsPayload,
  AutomationPayload,
  CapitalPlanPayload,
  CapitalPlanView,
  CashFlowsPayload,
  ExternalAssetsPayload,
  HistoryPayload,
  HistorySnapshot,
  PortfolioPayload,
  ReviewJournalEntry,
  ReviewJournalPayload,
} from "../lib/ui-types";
import { AssetTrendChart } from "./AssetTrendChart";
import type { WholeAssetHistoryPayload } from "./WholeAssetTrendChart";
import type { WorkspaceView } from "./WorkspaceNav";

type HistoryPeriod = 30 | 90 | 365 | "all";

export interface ReviewWorkspaceData {
  portfolio: PortfolioPayload;
  history: HistoryPayload;
  cashFlows: CashFlowsPayload;
  externalAssets: ExternalAssetsPayload;
  wholeAssetHistory: WholeAssetHistoryPayload;
  analytics: AnalyticsPayload;
  automation: AutomationPayload | null;
  capitalPlan: CapitalPlanPayload;
  reviewJournal: ReviewJournalPayload;
}

interface ReviewWorkspaceProps {
  data: ReviewWorkspaceData;
  period: HistoryPeriod;
  onPeriodChange: (period: HistoryPeriod) => void;
  onNavigate: (view: WorkspaceView) => void;
  onReviewAdded: (review: ReviewJournalEntry) => void;
  onReviewUpdated: (review: ReviewJournalEntry) => void;
}

const DEFAULT_ALLOCATION: AllocationItem[] = [
  { key: "KR", label: "국내주식", valueKrw: "0", weight: "0", targetWeight: "0.45" },
  { key: "US", label: "미국주식", valueKrw: "0", weight: "0", targetWeight: "0.45" },
  { key: "CASH", label: "현금", valueKrw: "0", weight: "0", targetWeight: "0.1" },
];

function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  return fetch(url, {
    ...init,
    headers: { Accept: "application/json", ...init?.headers },
    cache: "no-store",
  }).then(async (response) => {
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(apiErrorMessage(body, "데이터를 처리하지 못했습니다."));
    return body as T;
  });
}

function totalTracked(portfolio: PortfolioPayload): string {
  return calculateTotalTrackedValueKrw({
    equityValueKrw: String(portfolio.summary.equityValueKrw ?? "0"),
    buyingPowerKrw: String(portfolio.summary.buyingPowerKrw ?? "0"),
    buyingPowerUsd: String(portfolio.summary.buyingPowerUsd ?? "0"),
    usdKrwRate: String(portfolio.summary.usdKrwRate ?? "0"),
  });
}

function targetWeightFor(item: AllocationItem, plan: CapitalPlanView): string {
  if (item.key === "KR") return plan.targetKrWeight;
  if (item.key === "US") return plan.targetUsWeight;
  if (item.key === "CASH") return plan.targetCashWeight;
  return "0";
}

function filteredSnapshots(
  snapshots: HistorySnapshot[],
  period: HistoryPeriod,
  endedAt: string,
): HistorySnapshot[] {
  const end = Date.parse(endedAt);
  const ordered = [...snapshots]
    .filter((snapshot) => Date.parse(snapshot.capturedAt) <= end)
    .sort((left, right) => Date.parse(left.capturedAt) - Date.parse(right.capturedAt));
  if (period === "all") return ordered;
  const boundary = end - period * 24 * 60 * 60 * 1_000;
  return ordered.filter((snapshot) => Date.parse(snapshot.capturedAt) >= boundary);
}

function appendLiveSnapshot(
  snapshots: HistorySnapshot[],
  portfolio: PortfolioPayload,
): HistorySnapshot[] {
  const liveTimestamp = Date.parse(portfolio.asOf);
  const latestTimestamp = Date.parse(snapshots.at(-1)?.capturedAt ?? "");
  if (!Number.isFinite(liveTimestamp) || liveTimestamp <= latestTimestamp) return snapshots;
  return [...snapshots, {
    id: "live-current",
    capturedAt: portfolio.asOf,
    equityValueKrw: portfolio.summary.equityValueKrw,
    profitLossKrw: portfolio.summary.profitLossKrw,
    buyingPowerKrw: portfolio.summary.buyingPowerKrw,
    totalTrackedValueKrw: totalTracked(portfolio),
    usdKrwRate: portfolio.summary.usdKrwRate,
    holdingCount: portfolio.holdings.length,
  }];
}

function normalizedHistory(snapshots: HistorySnapshot[]) {
  return snapshots.map((snapshot) => ({
    id: String(snapshot.id),
    capturedAt: snapshot.capturedAt,
    equityValueKrw: String(snapshot.equityValueKrw ?? "0"),
    profitLossKrw: String(snapshot.profitLossKrw ?? "0"),
    buyingPowerKrw: String(snapshot.buyingPowerKrw ?? "0"),
    totalTrackedValueKrw: String(snapshot.totalTrackedValueKrw ?? "0"),
    usdKrwRate: String(snapshot.usdKrwRate ?? "0"),
    holdingCount: snapshot.holdingCount,
  }));
}

function periodStart(snapshots: HistorySnapshot[], period: HistoryPeriod, endedAt: string): string {
  const end = Date.parse(endedAt);
  if (period === "all") {
    return snapshots[0]?.capturedAt ?? new Date(end - 24 * 60 * 60 * 1_000).toISOString();
  }
  return new Date(end - period * 24 * 60 * 60 * 1_000).toISOString();
}

function monthKey(value: string): string | null {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp + 9 * 60 * 60 * 1_000).toISOString().slice(0, 7);
}

function PeriodControl({ value, onChange }: {
  value: HistoryPeriod;
  onChange: (value: HistoryPeriod) => void;
}) {
  const values: Array<{ value: HistoryPeriod; label: string; ariaLabel: string }> = [
    { value: 30, label: "1M", ariaLabel: "1개월" },
    { value: 90, label: "3M", ariaLabel: "3개월" },
    { value: 365, label: "1Y", ariaLabel: "1년" },
    { value: "all", label: "ALL", ariaLabel: "전체 기간" },
  ];
  return (
    <div className="period-control" role="group" aria-label="분석 기간">
      {values.map((item) => (
        <button type="button" key={String(item.value)} aria-label={item.ariaLabel} aria-pressed={value === item.value} onClick={() => onChange(item.value)}>
          {item.label}
        </button>
      ))}
    </div>
  );
}

function StatusNotice({ tone = "neutral", children }: {
  tone?: "neutral" | "warning" | "danger";
  children: ReactNode;
}) {
  return <div className={`status-notice ${tone}`} role={tone === "danger" ? "alert" : "status"}>{children}</div>;
}

export function ReviewWorkspace({
  data,
  period,
  onPeriodChange,
  onNavigate,
  onReviewAdded,
  onReviewUpdated,
}: ReviewWorkspaceProps) {
  const { portfolio, history, cashFlows, capitalPlan } = data;
  const [cashFlowConfirmation, setCashFlowConfirmation] = useState<CashFlowConfirmation>("unknown");
  const [action, setAction] = useState("");
  const [savingReview, setSavingReview] = useState(false);
  const [updatingReview, setUpdatingReview] = useState<string | null>(null);
  const [reviewNotice, setReviewNotice] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const reviewIdempotency = useRef<string | null>(null);
  const plan = capitalPlan.plan;
  const pacePlan = plan?.startAssetKrw ? { ...plan, startAssetKrw: plan.startAssetKrw } : null;
  const storedSnapshots = filteredSnapshots(history.snapshots, period, portfolio.asOf);
  const snapshots = appendLiveSnapshot(storedSnapshots, portfolio);
  const normalizedSnapshots = normalizedHistory(snapshots);
  const current = totalTracked(portfolio);
  const externalDiagnostics = data.externalAssets.status === "ready"
    ? calculateExternalAssetDiagnostics(data.externalAssets.assets, portfolio.asOf)
    : null;
  const registeredTotal = data.externalAssets.status === "ready"
    ? exactSum(current, data.externalAssets.totalValueKrw)
    : null;
  const externalAssetsTruncated = data.externalAssets.status === "ready" &&
    data.externalAssets.count > data.externalAssets.assets.length;
  const wholeAssetPointCount = data.wholeAssetHistory.count ??
    data.wholeAssetHistory.points.length;
  const carriedForwardMonthCount = data.wholeAssetHistory.points.filter(
    (point) => point.portfolioCarriedForward,
  ).length;
  const wholeAssetHistoryWarnings = data.wholeAssetHistory.warnings ?? [];
  const wholeAssetHistoryLabel = data.wholeAssetHistory.status === "loading"
    ? "불러오는 중"
    : data.wholeAssetHistory.status === "unavailable"
      ? "불러오기 실패"
      : data.wholeAssetHistory.status === "demo"
        ? "데모 저장 안 함"
        : wholeAssetPointCount === 0
          ? "관측 월 없음"
          : `${wholeAssetPointCount}개월`;
  const wholeAssetHistoryDetail = data.wholeAssetHistory.status === "ready"
    ? carriedForwardMonthCount > 0
      ? `직전 증권 스냅샷 이월 ${carriedForwardMonthCount}개월`
      : "월별 비교 가능"
    : data.wholeAssetHistory.status === "insufficient-history"
      ? "두 관측 월부터 비교 가능"
      : data.wholeAssetHistory.status === "unavailable"
        ? "전체 자산 이력 API 확인 필요"
        : data.wholeAssetHistory.status === "loading"
          ? "월별 등록 범위를 확인하고 있습니다"
          : "개인 자산 이력을 저장하지 않습니다";
  const first = snapshots[0]?.totalTrackedValueKrw ?? current;
  const change = exactDifference(current, first);
  const reviewStartedAt = periodStart(storedSnapshots, period, portfolio.asOf);
  const reliability = calculateReviewReliability({
    snapshotTimestamps: storedSnapshots.map((snapshot) => snapshot.capturedAt),
    startedAt: reviewStartedAt,
    endedAt: portfolio.asOf,
    planConfigured: Boolean(pacePlan),
    cashFlowConfirmation,
  });
  const attribution = normalizedSnapshots.length >= 2
    ? calculateReviewAttribution(normalizedSnapshots, cashFlows.cashFlows.map((flow) => ({
      ...flow,
      note: flow.note ?? "",
    })))
    : null;
  const pace = pacePlan ? calculatePlanPace({
    startAssetKrw: pacePlan.startAssetKrw,
    targetAssetKrw: pacePlan.targetAssetKrw,
    currentAssetKrw: current,
    startDate: pacePlan.startDate,
    targetDate: pacePlan.targetDate,
    asOf: portfolio.asOf,
  }) : null;
  const planProgress = pacePlan && numeric(pacePlan.targetAssetKrw) > 0
    ? Math.min(999, (numeric(current) / numeric(pacePlan.targetAssetKrw)) * 100)
    : null;
  const targetRatio = plan && numeric(current) > 0 ? numeric(plan.targetAssetKrw) / numeric(current) : null;
  const allocation = portfolio.allocation.length ? portfolio.allocation : DEFAULT_ALLOCATION;
  const deviations = plan ? allocation.map((item) => ({
    ...item,
    target: targetWeightFor(item, plan),
    drift: exactDifference(item.weight, targetWeightFor(item, plan)),
  })) : [];
  const largestDrift = [...deviations].sort(
    (left, right) => Math.abs(numeric(right.drift)) - Math.abs(numeric(left.drift)),
  )[0];
  const currentMonth = monthKey(portfolio.asOf);
  const monthlyContribution = cashFlows.cashFlows
    .filter((entry) => entry.kind === "contribution" && monthKey(entry.occurredAt) === currentMonth)
    .reduce((sum, entry) => exactSum(sum, entry.amountKrw), "0");
  const contributionGap = plan ? exactDifference(plan.monthlyContributionKrw, monthlyContribution) : null;
  const historyReady = snapshots.length >= 2;
  const paceLabel = !pace
    ? "계획 기준 없음"
    : compareDecimal(pace.paceDifferenceKrw, "0") >= 0
      ? `${formatCompactKrw(pace.paceDifferenceKrw)} 앞섬`
      : `${formatCompactKrw(exactDifference("0", pace.paceDifferenceKrw))} 뒤처짐`;
  const dominantLabels = {
    "cash-flow": "외부 입출금",
    "holding-value": "보유자산 평가액",
    "cash-residual": "현금·결제 잔여",
  } as const;
  const dominantLabel = attribution ? dominantLabels[attribution.dominant] : "분석 자료 부족";
  const readinessCopy = {
    ready: { label: "분석 준비", detail: "선택 기간의 핵심 확인이 끝났습니다." },
    check: { label: "확인 필요", detail: "아래 항목을 확인하면 해석 범위가 선명해집니다." },
    blocked: { label: "근거 부족", detail: "저장 기록을 더 쌓은 뒤 기간 비교를 시작하세요." },
  }[reliability.readiness];
  const planRange = pacePlan ? numeric(pacePlan.targetAssetKrw) - numeric(pacePlan.startAssetKrw) : 0;
  const actualPosition = pacePlan && planRange > 0
    ? Math.max(0, Math.min(100, ((numeric(current) - numeric(pacePlan.startAssetKrw)) / planRange) * 100))
    : 0;
  const plannedPosition = pace ? Math.max(0, Math.min(100, numeric(pace.elapsedRatio) * 100)) : 0;

  async function submitReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (cashFlowConfirmation === "unknown") {
      setReviewError("외부 입출금 기록 여부를 먼저 확인해 주세요.");
      return;
    }
    setSavingReview(true);
    setReviewError(null);
    setReviewNotice(null);
    const key = reviewIdempotency.current ?? `review-${crypto.randomUUID()}`;
    reviewIdempotency.current = key;
    try {
      const response = await fetchJson<{ review: ReviewJournalEntry; created: boolean }>("/api/reviews", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": key,
          "X-LedgerLens-Intent": "record-review",
        },
        body: JSON.stringify({
          periodStartedAt: reviewStartedAt,
          periodEndedAt: portfolio.asOf,
          cashFlowConfirmation,
          action,
          snapshotCount: reliability.snapshotCount,
          planRevision: plan?.revision ?? null,
        }),
      });
      reviewIdempotency.current = null;
      onReviewAdded(response.review);
      setAction("");
      setReviewNotice(response.created ? "이번 검토와 다음 행동을 기록했습니다." : "같은 검토가 이미 기록되어 있습니다.");
    } catch (caught) {
      setReviewError(caught instanceof Error ? caught.message : "검토 기록을 저장하지 못했습니다.");
    } finally {
      setSavingReview(false);
    }
  }

  async function changeReviewStatus(review: ReviewJournalEntry) {
    setUpdatingReview(review.id);
    setReviewError(null);
    setReviewNotice(null);
    try {
      const response = await fetchJson<{ review: ReviewJournalEntry }>("/api/reviews", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-LedgerLens-Intent": "update-review" },
        body: JSON.stringify({
          id: review.id,
          status: review.status === "open" ? "resolved" : "open",
          expectedRevision: review.revision,
        }),
      });
      onReviewUpdated(response.review);
      setReviewNotice(response.review.status === "resolved" ? "이전 행동을 해결로 표시했습니다." : "이전 행동을 다시 점검 대상으로 열었습니다.");
    } catch (caught) {
      setReviewError(caught instanceof Error ? caught.message : "검토 상태를 변경하지 못했습니다.");
    } finally {
      setUpdatingReview(null);
    }
  }

  const decisionText = !historyReady
    ? "정기 검토를 시작하기 전에 근거를 확인하세요."
    : pace
      ? `무수익 계획선보다 ${paceLabel}.`
      : `${signedKrw(change)} 변화를 확인했습니다. 계획 기준을 연결하세요.`;
  const decisionDetail = !historyReady
    ? "현재 조회는 볼 수 있지만 기간 변화와 원인을 비교하려면 서로 다른 시점의 기록이 더 필요합니다."
    : `선택 기간 총 변화는 ${signedKrw(change)}이며 가장 큰 관측 항목은 ${dominantLabel}입니다. 입출금 완전성을 확인한 뒤 후속 행동 하나를 남기세요.`;

  return (
    <div className="review-screen review-workflow-screen">
      <section className="review-ribbon" aria-labelledby="review-title">
        <div className="review-ribbon-main">
          <div className="review-title-row">
            <div>
              <h1 id="review-title" tabIndex={-1}>{decisionText}</h1>
              <p>{decisionDetail}</p>
            </div>
            <PeriodControl value={period} onChange={onPeriodChange} />
          </div>
          <dl className="review-metrics">
            <div>
              <dt>현재 추적 자산</dt>
              <dd>{formatKrw(current)}</dd>
              <span>{formatAsOf(portfolio.asOf)} 기준</span>
            </div>
            <div>
              <dt>계획 페이스</dt>
              <dd className={pace ? signedClass(pace.paceDifferenceKrw) : undefined}>{pace ? paceLabel : "기준 없음"}</dd>
              <span>{pace ? `무수익 계획선 ${formatCompactKrw(pace.plannedAssetKrw)}` : plan ? "기존 계획의 시작 자산 확인" : "Capital Plan에서 시작 자산 설정"}</span>
            </div>
            <div>
              <dt>주된 관측 원인</dt>
              <dd>{historyReady ? dominantLabel : "계산 불가"}</dd>
              <span>{cashFlowConfirmation === "complete" ? "입출금 확인 반영" : "입출금 확인 전 임시 해석"}</span>
            </div>
          </dl>
        </div>
        <aside className="review-ribbon-checks" aria-labelledby="readiness-title">
          <div className="check-heading">
            <span id="readiness-title">증권 성과 분석 신뢰도</span>
            <strong className={`readiness-status ${reliability.readiness}`}>{readinessCopy.label}</strong>
          </div>
          <p className="readiness-summary">{readinessCopy.detail}</p>
          <dl className="readiness-list">
            <div>
              <dt>최근 저장</dt>
              <dd>{reliability.latestSnapshotAt ? formatDate(reliability.latestSnapshotAt, true) : "저장 기록 없음"}</dd>
              <span>최대 관측 공백 {formatDecimal(reliability.largestGapDays, 1)}일 · 3일 초과 {reliability.gapCount}구간</span>
            </div>
            <div>
              <dt>기록 밀도</dt>
              <dd>{reliability.observationDays}일 / {reliability.periodDays}일</dd>
              <span>달력일 대비 {formatPercent(reliability.densityRatio)} · 거래일 기준 아님</span>
            </div>
            <div>
              <dt>계획 기준</dt>
              <dd>{pacePlan ? `revision ${pacePlan.revision}` : plan ? "시작 자산 확인 필요" : "미설정"}</dd>
              <button type="button" onClick={() => onNavigate("plan")}>{pacePlan ? "계획 확인" : plan ? "시작 자산 설정" : "계획 설정"}</button>
            </div>
          </dl>
          <fieldset className="cashflow-confirmation">
            <legend>이 기간 외부 입출금을 모두 기록했습니까?</legend>
            <div>
              <label><input type="radio" name="cashflow-confirmation" value="complete" checked={cashFlowConfirmation === "complete"} onChange={() => setCashFlowConfirmation("complete")} /> 예, 모두 기록함</label>
              <label><input type="radio" name="cashflow-confirmation" value="incomplete" checked={cashFlowConfirmation === "incomplete"} onChange={() => setCashFlowConfirmation("incomplete")} /> 아니요, 점검 필요</label>
            </div>
          </fieldset>
          <div className="analysis-scope">
            <p><strong>계산 가능</strong> 자산 변화, 계획선, 기록된 입출금, 평가액·현금 변화</p>
            <p><strong>계산 보류</strong> 가격·환율의 개별 기여도, 벤치마크, 세금·배당·수수료</p>
          </div>
          {reliability.limitations.length ? (
            <ul className="readiness-limitations">
              {reliability.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}
            </ul>
          ) : null}
        </aside>
      </section>

      <section className="whole-asset-reliability" aria-labelledby="whole-asset-reliability-title">
        <div className="whole-asset-reliability-heading">
          <div>
            <h2 id="whole-asset-reliability-title">전체 자산 점검</h2>
            <p>Toss 조회 범위와 수동 원장의 신선도·만기·월별 관측 범위를 분리해 확인합니다.</p>
          </div>
          <span>Toss 조회 + 수동 원장</span>
        </div>
        {data.externalAssets.status === "ready" && externalDiagnostics ? (
          <>
            <dl className="whole-asset-reliability-list">
              <div className="whole-asset-reliability-total">
                <dt>등록 자산 총액</dt>
                <dd>{formatKrw(registeredTotal ?? current)}</dd>
                <span>Toss 추적 {formatCompactKrw(current)} + 수동 {formatCompactKrw(data.externalAssets.totalValueKrw)}</span>
              </div>
              <div>
                <dt>수동 자산 원천</dt>
                <dd>{data.externalAssets.count > 0 ? `${data.externalAssets.count}건 연결` : "등록 없음"}</dd>
                <span>{data.externalAssets.lastUpdatedAt ? `최근 수정 ${formatDate(data.externalAssets.lastUpdatedAt, true)}` : "아직 저장된 수동 자산이 없습니다"}</span>
              </div>
              <div>
                <dt>평가 갱신</dt>
                <dd>{externalDiagnostics.staleCount}건</dd>
                <span>{externalDiagnostics.staleAfterDays}일 초과 평가값</span>
              </div>
              <div>
                <dt>만기 점검</dt>
                <dd>{externalDiagnostics.maturityDueSoonCount + externalDiagnostics.maturityOverdueCount}건</dd>
                <span>{externalDiagnostics.maturityWindowDays}일 이내 {externalDiagnostics.maturityDueSoonCount} · 경과 {externalDiagnostics.maturityOverdueCount}</span>
              </div>
              <div>
                <dt>월별 등록 기록</dt>
                <dd>{wholeAssetHistoryLabel}</dd>
                <span>{wholeAssetHistoryDetail}</span>
              </div>
            </dl>
            {data.externalAssets.count === 0 ? (
              <div className="whole-asset-reliability-state empty" role="status">
                <strong>수동 등록 자산이 없습니다</strong>
                <p>현재 등록 자산 총액은 Toss에서 추적하는 증권 자산만 반영합니다.</p>
              </div>
            ) : null}
          </>
        ) : (
          <div className={`whole-asset-reliability-state ${data.externalAssets.status}`} role={data.externalAssets.status === "unavailable" ? "alert" : "status"}>
            <strong>{data.externalAssets.status === "demo" ? "데모에서는 개인 자산 원장을 저장하지 않습니다" : "수동 자산 원장을 불러오지 못했습니다"}</strong>
            <p>{data.externalAssets.status === "demo" ? "전체 자산 합계와 평가·만기 점검은 실제 저장소를 연결한 뒤 계산합니다." : "Toss 추적 자산은 볼 수 있지만 전체 등록 자산 총액과 수동 자산 점검은 확인할 수 없습니다."}</p>
            <dl className="whole-asset-reliability-source-state">
              <div><dt>수동 자산 원천</dt><dd>{data.externalAssets.status === "demo" ? "데모 저장 안 함" : "불러오기 실패"}</dd></div>
              <div><dt>월별 등록 기록</dt><dd>{wholeAssetHistoryLabel}</dd><span>{wholeAssetHistoryDetail}</span></div>
            </dl>
          </div>
        )}
        {externalAssetsTruncated ? (
          <p className="whole-asset-reliability-truncation" role="note">
            등록 자산 총액은 서버의 전체 {data.externalAssets.count}건 합계입니다. 평가·만기 점검 건수는 현재 불러온 최근 {data.externalAssets.assets.length}건 기준이므로 나머지 자산은 목록 페이지네이션 후 확인해야 합니다.
          </p>
        ) : null}
        {wholeAssetHistoryWarnings.length ? (
          <ul className="whole-asset-reliability-warnings">
            {wholeAssetHistoryWarnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
        ) : null}
        <p className="whole-asset-reliability-scope" role="note">
          전체 등록 자산은 현재 규모와 입력 범위의 점검값입니다. 수동 자산은 Modified Dietz 수익률, 계획 페이스, 손익 또는 변화 원인 계산에 포함하지 않습니다.
        </p>
      </section>

      <section className="plan-pace-section" aria-labelledby="plan-pace-title">
        <div className="section-heading-inline">
          <div>
            <h2 id="plan-pace-title">계획 페이스</h2>
            <p>계획 시작 자산에서 목표 자산까지 수익률 0%, 균등 적립을 가정한 기준선과 현재를 비교합니다.</p>
          </div>
          <button className="text-button" type="button" onClick={() => onNavigate("plan")}>{pacePlan ? "계획 수정" : plan ? "시작 자산 설정" : "계획 설정"}</button>
        </div>
        {pacePlan && pace ? (
          <>
            <div className="pace-conclusion">
              <strong className={signedClass(pace.paceDifferenceKrw)}>{paceLabel}</strong>
              <span>{pace.status === "target-date-reached" ? "목표일 도달" : `목표일까지 ${pace.remainingDays.toLocaleString("ko-KR")}일`}</span>
            </div>
            <div className="pace-track" role="img" aria-label={`계획 시작 ${formatKrw(pacePlan.startAssetKrw)}, 현재 계획선 ${formatKrw(pace.plannedAssetKrw)}, 실제 ${formatKrw(current)}, 목표 ${formatKrw(pacePlan.targetAssetKrw)}`}>
              <span className="pace-fill" style={{ width: `${plannedPosition}%` }} />
              <span className="pace-marker planned" style={{ left: `${plannedPosition}%` }}><i />계획선</span>
              <span className="pace-marker actual" style={{ left: `${actualPosition}%` }}><i />실제</span>
            </div>
            <dl className="pace-ledger">
              <div><dt>계획 시작 자산</dt><dd>{formatKrw(pacePlan.startAssetKrw)}</dd><span>{formatDate(pacePlan.startDate)}</span></div>
              <div><dt>오늘의 무수익 계획선</dt><dd>{formatKrw(pace.plannedAssetKrw)}</dd><span>기간 경과 {formatPercent(pace.elapsedRatio)}</span></div>
              <div><dt>남은 목표 차이</dt><dd>{formatKrw(pace.targetGapKrw)}</dd><span>목표의 {formatDecimal(planProgress, 1)}% 추적</span></div>
              <div><dt>필요 월 투자금</dt><dd>{pace.requiredMonthlyContributionKrw ? formatKrw(pace.requiredMonthlyContributionKrw) : "0원"}</dd><span>수익률 미가정 · 평균 월 길이 기준</span></div>
            </dl>
            <p className="pace-method">저장한 월 투자금 {formatKrw(pacePlan.monthlyContributionKrw)}과 필요 금액의 차이는 {pace.requiredMonthlyContributionKrw ? signedKrw(exactDifference(pacePlan.monthlyContributionKrw, pace.requiredMonthlyContributionKrw)) : formatKrw(pacePlan.monthlyContributionKrw)}입니다. 이는 매수 제안이나 수익률 예측이 아닙니다.</p>
          </>
        ) : (
          <StatusNotice tone="warning">계획 시작 자산, 목표 자산, 시작일과 목표일을 저장하면 실제 성장 속도를 무수익 계획선과 비교합니다.</StatusNotice>
        )}
      </section>

      <section className="review-chart-section" aria-labelledby="asset-trend-title">
        <div className="section-heading-inline">
          <div>
            <h2 id="asset-trend-title">자산 성장과 계획 기준</h2>
            <p>채운 점은 입출금, 마지막 테두리 점은 현재 조회입니다. 선은 관측 시점 사이를 직선으로 연결하며 장중 수익률 곡선이 아닙니다.</p>
          </div>
          {plan && targetRatio && targetRatio > 1.25 ? (
            <div className="goal-reference">목표 {formatCompactKrw(plan.targetAssetKrw)} · 현재의 {formatDecimal(targetRatio, 1)}배</div>
          ) : null}
        </div>
        <AssetTrendChart
          snapshots={snapshots}
          cashFlows={cashFlows.cashFlows}
          targetAssetKrw={plan?.targetAssetKrw}
          planLine={pacePlan ? {
            startAssetKrw: pacePlan.startAssetKrw,
            targetAssetKrw: pacePlan.targetAssetKrw,
            startDate: pacePlan.startDate,
            targetDate: pacePlan.targetDate,
          } : null}
        />
      </section>

      <section className="change-bridge" aria-labelledby="change-bridge-title">
        <div className="section-heading-inline">
          <div>
            <h2 id="change-bridge-title">관측 가능한 변화 원인</h2>
            <p>외부 입출금, 보유자산 평가액 변화, 매매·결제 등을 포함한 현금 잔여로 총 변화를 맞춥니다. 가격과 환율 기여도는 거래 원장 없이 분리하지 않습니다.</p>
          </div>
          <span className={`attribution-confidence ${cashFlowConfirmation}`}>{cashFlowConfirmation === "complete" ? "입출금 확인 완료" : cashFlowConfirmation === "incomplete" ? "누락 점검 필요" : "입출금 확인 전"}</span>
        </div>
        {attribution ? (
          <>
            <div className="bridge-track attribution-track">
              <div className="bridge-node start"><span>시작 자산</span><strong>{formatCompactKrw(first)}</strong></div>
              <div className={`bridge-step ${signedClass(attribution.netCashFlowKrw)}`}><span>외부 입출금</span><strong>{signedKrw(attribution.netCashFlowKrw)}</strong><small>{attribution.flowCount}건 · 사용자 기록</small></div>
              <div className={`bridge-step ${signedClass(attribution.holdingValueChangeKrw)}`}><span>보유자산 평가액</span><strong>{signedKrw(attribution.holdingValueChangeKrw)}</strong><small>가격·환율·매매 포함</small></div>
              <div className={`bridge-step ${signedClass(attribution.cashAndSettlementResidualKrw)}`}><span>현금·결제 잔여</span><strong>{signedKrw(attribution.cashAndSettlementResidualKrw)}</strong><small>현금 변화 − 외부 입출금</small></div>
              <div className="bridge-node end"><span>현재 자산</span><strong>{formatCompactKrw(current)}</strong></div>
            </div>
            <dl className="attribution-references">
              <div><dt>평가손익 변화</dt><dd className={signedClass(attribution.unrealizedProfitLossChangeKrw)}>{signedKrw(attribution.unrealizedProfitLossChangeKrw)}</dd><span>현재 누적 미실현 평가손익의 시점 간 차이</span></div>
              <div><dt>USD/KRW 참고</dt><dd className={signedClass(attribution.usdKrwRateChange)}>{attribution.usdKrwRateChange ? formatPercent(attribution.usdKrwRateChange) : "계산 불가"}</dd><span>환율 자체의 변화이며 자산 기여도는 아님</span></div>
            </dl>
          </>
        ) : <StatusNotice>비교 가능한 두 시점이 없어 변화 원인을 계산하지 않습니다.</StatusNotice>}
      </section>

      <section className="review-journal-section" aria-labelledby="review-journal-title">
        <div className="review-journal-compose">
          <div className="section-heading-inline">
            <div>
              <h2 id="review-journal-title">이번 검토 마치기</h2>
              <p>다음 검토 전 확인할 행동을 한 가지만 남깁니다. 매수·매도 지시가 아니라 점검 메모입니다.</p>
            </div>
          </div>
          <form className="review-journal-form" onSubmit={submitReview}>
            <label htmlFor="review-action">다음 검토 전 행동</label>
            <div>
              <input id="review-action" value={action} maxLength={240} placeholder="예: 누락된 8월 외부 입금 1건 기록하기" onChange={(event) => setAction(event.target.value)} required />
              <button className="primary-button" type="submit" disabled={savingReview || data.reviewJournal.status === "demo" || cashFlowConfirmation === "unknown"}>{savingReview ? "기록 중…" : "검토 기록"}</button>
            </div>
            <span>선택 기간 {formatDate(reviewStartedAt)}–{formatDate(portfolio.asOf)} · 저장 스냅샷 {reliability.snapshotCount}개</span>
          </form>
          {data.reviewJournal.status === "demo" ? <StatusNotice tone="warning">Demo에서는 검토 기록을 저장하지 않습니다. 입출금 확인과 행동 입력 흐름만 미리 볼 수 있습니다.</StatusNotice> : null}
          {reviewError ? <StatusNotice tone="danger">{reviewError}</StatusNotice> : null}
          {reviewNotice ? <StatusNotice>{reviewNotice}</StatusNotice> : null}
        </div>
        <details className="review-history">
          <summary>지난 검토 {data.reviewJournal.count}건 · 미해결 {data.reviewJournal.reviews.filter((review) => review.status === "open").length}건</summary>
          {data.reviewJournal.reviews.length ? (
            <ol>
              {data.reviewJournal.reviews.map((review) => (
                <li key={review.id}>
                  <div>
                    <span className={`review-action-status ${review.status}`}>{review.status === "resolved" ? "해결" : "점검 중"}</span>
                    <strong>{review.action}</strong>
                    <p>{formatDate(review.createdAt, true)} · 입출금 {review.cashFlowConfirmation === "complete" ? "모두 기록 확인" : "누락 점검 필요"} · 스냅샷 {review.snapshotCount}개</p>
                  </div>
                  <button
                    className="secondary-button"
                    type="button"
                    aria-label={`${review.action}: ${review.status === "open" ? "해결로 표시" : "다시 열기"}`}
                    disabled={updatingReview === review.id}
                    onClick={() => void changeReviewStatus(review)}
                  >
                    {updatingReview === review.id ? "변경 중…" : review.status === "open" ? "해결로 표시" : "다시 열기"}
                  </button>
                </li>
              ))}
            </ol>
          ) : <p className="empty-row">아직 저장된 검토가 없습니다.</p>}
        </details>
      </section>

      <section className="diagnostic-band" aria-label="다음 배분 전 점검">
        <div><span>Unrealized P/L</span><strong className={signedClass(portfolio.summary.profitLossKrw)}>{signedKrw(portfolio.summary.profitLossKrw)}</strong><p>현재 조회의 누적 평가 손익이며 실현 손익이 아닙니다.</p></div>
        <div><span>Allocation</span><strong>{largestDrift ? `${largestDrift.label} ${formatPercent(largestDrift.drift)}p` : "목표 배분 미설정"}</strong><p>{plan ? "양수는 목표 초과, 음수는 목표 미달입니다." : "계획 저장 전에는 편차를 만들지 않습니다."}</p></div>
        <div><span>Monthly capital</span><strong>{plan ? `${formatCompactKrw(monthlyContribution)} / ${formatCompactKrw(plan.monthlyContributionKrw)}` : "월 투자금 미설정"}</strong><p>{contributionGap === null ? "계획을 설정하세요." : compareDecimal(contributionGap, "0") > 0 ? `${formatCompactKrw(contributionGap)} 추가 점검` : "저장 월 투자금 기준 충족"}</p></div>
        <div><span>Review hypothesis</span><strong>Discovery 3/10</strong><p>이 흐름은 아직 인터뷰로 검증되지 않은 강한 제품 가설입니다.</p></div>
      </section>
    </div>
  );
}
