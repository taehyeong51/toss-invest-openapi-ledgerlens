"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { AssetTrendChart } from "./components/AssetTrendChart";
import {
  ExternalAssetReviewQueue,
  type ExternalAssetReviewDiagnostics,
} from "./components/ExternalAssetReviewQueue";
import { ExternalAssetLedger } from "./components/ExternalAssetLedger";
import { ExternalAssetCsvTransfer } from "./components/ExternalAssetCsvTransfer";
import { DashboardWorkspace } from "./components/DashboardWorkspace";
import { ReviewWorkspace } from "./components/ReviewWorkspace";
import { TossCredentialSettings } from "./components/TossCredentialSettings";
import {
  WholeAssetTrendChart,
  type WholeAssetHistoryPayload,
} from "./components/WholeAssetTrendChart";
import { WorkspaceNav, type WorkspaceView } from "./components/WorkspaceNav";
import { calculateModifiedDietzMetrics } from "@/lib/analytics/calculate";
import { calculateExternalAssetDiagnostics } from "@/lib/assets/diagnostics";
import { calculateTotalTrackedValueKrw } from "@/lib/portfolio/tracked";
import {
  apiErrorMessage,
  compareDecimal,
  DECIMAL_INPUT_PATTERN,
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
} from "./lib/format";
import type {
  AllocationItem,
  AnalyticsPayload,
  AnalyticsMetrics,
  AutomationPayload,
  CapitalPlanPayload,
  CapitalPlanView,
  CashFlowEntry,
  CashFlowKind,
  CashFlowsPayload,
  ExternalAssetsPayload,
  HistoryPayload,
  HistorySnapshot,
  HoldingHistoryPayload,
  HoldingItem,
  PortfolioPayload,
  ReviewJournalEntry,
  ReviewJournalPayload,
} from "./lib/ui-types";

type HistoryPeriod = 30 | 90 | 365 | "all";
type HoldingSort = "value" | "profit" | "daily" | "name";

interface WorkspaceData {
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

interface CapitalPlanDraft {
  startAssetKrw: string;
  targetAssetKrw: string;
  startDate: string;
  targetDate: string;
  monthlyContributionKrw: string;
  targetKrWeight: string;
  targetUsWeight: string;
  targetCashWeight: string;
}

interface CashFlowDraft {
  kind: CashFlowKind;
  amountKrw: string;
  occurredAt: string;
  note: string;
}

const EMPTY_HISTORY: HistoryPayload = { snapshots: [], count: 0 };
const EMPTY_CASH_FLOWS: CashFlowsPayload = { cashFlows: [], count: 0 };
const EMPTY_EXTERNAL_ASSETS: ExternalAssetsPayload = {
  status: "unavailable",
  assets: [],
  count: 0,
  totalValueKrw: "0",
  lastUpdatedAt: null,
};
const EMPTY_WHOLE_ASSET_HISTORY: WholeAssetHistoryPayload = {
  status: "unavailable",
  points: [],
  count: 0,
  warnings: [],
};
const EMPTY_ANALYTICS: AnalyticsPayload = {
  status: "insufficient-history",
  period: null,
  metrics: null,
  warnings: [],
};
const EMPTY_PLAN: CapitalPlanPayload = { status: "unconfigured", plan: null };
const EMPTY_REVIEWS: ReviewJournalPayload = { status: "ready", reviews: [], count: 0 };
const WHOLE_ASSET_HISTORY_RELOAD_WARNING = "수동 자산은 저장됐지만 월별 등록 자산 이력을 다시 불러오지 못했습니다.";
const DEFAULT_ALLOCATION: AllocationItem[] = [
  { key: "KR", label: "국내주식", valueKrw: "0", weight: "0", targetWeight: "0.45" },
  { key: "US", label: "미국주식", valueKrw: "0", weight: "0", targetWeight: "0.45" },
  { key: "CASH", label: "현금", valueKrw: "0", weight: "0", targetWeight: "0.1" },
];

const CAPITAL_TIME_ZONE = {
  name: "Asia/Seoul",
  offsetMs: 9 * 60 * 60 * 1_000,
} as const;

function wallClockIsoInCapitalTimeZone(value: string | Date): string | null {
  try {
    const date = typeof value === "string" ? new Date(value) : value;
    if (!Number.isFinite(date.getTime())) return null;
    return new Date(date.getTime() + CAPITAL_TIME_ZONE.offsetMs).toISOString();
  } catch {
    return null;
  }
}

function monthKeyInCapitalTimeZone(value: string | Date): string | null {
  return wallClockIsoInCapitalTimeZone(value)?.slice(0, 7) ?? null;
}

function capitalDateTimeInputToIso(value: string): string {
  return new Date(`${value}:00+09:00`).toISOString();
}

function currentDateInput(): string {
  return wallClockIsoInCapitalTimeZone(new Date())?.slice(0, 10) ?? "";
}

function currentDateTimeInput(): string {
  return wallClockIsoInCapitalTimeZone(new Date())?.slice(0, 16) ?? "";
}

function defaultTargetDate(): string {
  const date = new Date();
  date.setFullYear(date.getFullYear() + 10);
  return date.toISOString().slice(0, 10);
}

function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  return fetch(url, {
    ...init,
    headers: { Accept: "application/json", ...init?.headers },
    cache: "no-store",
  }).then(async (response) => {
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(apiErrorMessage(body, "데이터를 불러오지 못했습니다."));
    return body as T;
  });
}

function viewFromHash(): WorkspaceView | null {
  const value = window.location.hash.replace(/^#/, "");
  return (["review", "performance", "portfolio", "plan", "data"] as WorkspaceView[]).includes(
    value as WorkspaceView,
  )
    ? (value as WorkspaceView)
    : null;
}

function focusWorkspaceHeading(): void {
  window.setTimeout(() => {
    document.querySelector<HTMLElement>("#workspace-main h1")?.focus({ preventScroll: true });
  }, 0);
}

function totalTracked(portfolio: PortfolioPayload): string {
  return calculateTotalTrackedValueKrw({
    equityValueKrw: String(portfolio.summary.equityValueKrw ?? "0"),
    buyingPowerKrw: String(portfolio.summary.buyingPowerKrw ?? "0"),
    buyingPowerUsd: String(portfolio.summary.buyingPowerUsd ?? "0"),
    usdKrwRate: String(portfolio.summary.usdKrwRate ?? "0"),
  });
}

function externalAssetReviewDiagnostics(
  payload: ExternalAssetsPayload,
  asOf: string,
): ExternalAssetReviewDiagnostics {
  const diagnostics = calculateExternalAssetDiagnostics(payload.assets, asOf);
  return {
    asOf: diagnostics.asOf,
    staleAfterDays: diagnostics.staleAfterDays,
    maturityWindowDays: diagnostics.maturityWindowDays,
    staleCount: diagnostics.staleCount,
    maturitySoonCount: diagnostics.maturityDueSoonCount,
    overdueCount: diagnostics.maturityOverdueCount,
    cashLikeValueKrw: diagnostics.cashLikeValueKrw,
    usdValueKrw: diagnostics.usdValueKrw,
    largestAsset: diagnostics.largestAsset,
    issues: diagnostics.issues.map((issue) => ({
      code: issue.code === "maturity-due-soon" ? "maturity-soon" : issue.code,
      assetId: issue.assetId,
      name: issue.assetName,
      severity: issue.severity,
      message: issue.message,
      valuedAt: issue.valuedAt,
      maturityDate: issue.dueDate,
    })),
  };
}

function targetWeightFor(item: AllocationItem, plan: CapitalPlanView): string {
  if (item.key === "KR") return plan.targetKrWeight;
  if (item.key === "US") return plan.targetUsWeight;
  if (item.key === "CASH") return plan.targetCashWeight;
  return "0";
}

function appendLiveSnapshot(
  snapshots: HistorySnapshot[],
  portfolio: PortfolioPayload,
): HistorySnapshot[] {
  const ordered = [...snapshots].sort(
    (left, right) => Date.parse(left.capturedAt) - Date.parse(right.capturedAt),
  );
  const liveTimestamp = Date.parse(portfolio.asOf);
  const latestTimestamp = Date.parse(ordered.at(-1)?.capturedAt ?? "");
  if (!Number.isFinite(liveTimestamp) || liveTimestamp <= latestTimestamp) return ordered;
  return [...ordered, {
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

function periodAnalytics(
  snapshots: HistorySnapshot[],
  cashFlows: CashFlowEntry[],
): AnalyticsMetrics | null {
  if (snapshots.length < 2) return null;
  try {
    return calculateModifiedDietzMetrics(
      snapshots.map((snapshot) => ({
        id: String(snapshot.id),
        capturedAt: snapshot.capturedAt,
        equityValueKrw: String(snapshot.equityValueKrw ?? "0"),
        profitLossKrw: String(snapshot.profitLossKrw ?? "0"),
        buyingPowerKrw: String(snapshot.buyingPowerKrw ?? "0"),
        totalTrackedValueKrw: String(snapshot.totalTrackedValueKrw ?? "0"),
        usdKrwRate: String(snapshot.usdKrwRate ?? "0"),
        holdingCount: snapshot.holdingCount,
      })),
      cashFlows.map((flow) => ({ ...flow, note: flow.note ?? "" })),
    );
  } catch {
    return null;
  }
}

function StatusNotice({ tone = "neutral", children }: { tone?: "neutral" | "warning" | "danger"; children: React.ReactNode }) {
  return <div className={`status-notice ${tone}`} role={tone === "danger" ? "alert" : "status"}>{children}</div>;
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20 7v5h-5M4 17v-5h5" />
      <path d="M6.1 8.5A7 7 0 0 1 18.5 7M17.9 15.5A7 7 0 0 1 5.5 17" />
    </svg>
  );
}

function PageLead({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) {
  return (
    <div className="page-lead">
      <div>
        <h1 tabIndex={-1}>{title}</h1>
        <p>{description}</p>
      </div>
      {action ? <div className="page-lead-action">{action}</div> : null}
    </div>
  );
}

function PeriodControl({ value, onChange }: { value: HistoryPeriod; onChange: (value: HistoryPeriod) => void }) {
  const values: Array<{ value: HistoryPeriod; label: string; ariaLabel: string }> = [
    { value: 30, label: "1M", ariaLabel: "1개월" },
    { value: 90, label: "3M", ariaLabel: "3개월" },
    { value: 365, label: "1Y", ariaLabel: "1년" },
    { value: "all", label: "ALL", ariaLabel: "전체 기간" },
  ];
  return (
    <div className="period-control" role="group" aria-label="분석 기간">
      {values.map((item) => (
        <button
          type="button"
          key={String(item.value)}
          aria-label={item.ariaLabel}
          aria-pressed={value === item.value}
          onClick={() => onChange(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function filteredSnapshots(
  snapshots: HistorySnapshot[],
  period: HistoryPeriod,
  endedAt?: string,
): HistorySnapshot[] {
  const ordered = [...snapshots].sort(
    (left, right) => Date.parse(left.capturedAt) - Date.parse(right.capturedAt),
  );
  const newest = ordered.at(-1);
  if (!newest) return [];
  const requestedEnd = Date.parse(endedAt ?? "");
  const end = Number.isFinite(requestedEnd) ? requestedEnd : Date.parse(newest.capturedAt);
  const eligible = ordered.filter((snapshot) => Date.parse(snapshot.capturedAt) <= end);
  if (period === "all") return eligible;
  const boundary = end - period * 24 * 60 * 60 * 1_000;
  return eligible.filter((snapshot) => Date.parse(snapshot.capturedAt) >= boundary);
}

export function LegacyReviewScreen({ data, period, onPeriodChange, onNavigate }: {
  data: WorkspaceData;
  period: HistoryPeriod;
  onPeriodChange: (period: HistoryPeriod) => void;
  onNavigate: (view: WorkspaceView) => void;
}) {
  const { portfolio, history, cashFlows, capitalPlan } = data;
  const plan = capitalPlan.plan;
  const storedSnapshots = filteredSnapshots(history.snapshots, period, portfolio.asOf);
  const snapshots = appendLiveSnapshot(storedSnapshots, portfolio);
  const current = totalTracked(portfolio);
  const first = snapshots[0]?.totalTrackedValueKrw ?? current;
  const change = exactDifference(current, first);
  const metrics = periodAnalytics(snapshots, cashFlows.cashFlows);
  const flow = metrics?.netCashFlowKrw ?? "0";
  const adjustedGain = exactDifference(change, flow);
  const planProgress = plan && numeric(plan.targetAssetKrw) > 0
    ? Math.min(999, (numeric(current) / numeric(plan.targetAssetKrw)) * 100)
    : null;
  const targetRatio = plan && numeric(current) > 0 ? numeric(plan.targetAssetKrw) / numeric(current) : null;
  const allocation = portfolio.allocation.length ? portfolio.allocation : DEFAULT_ALLOCATION;
  const deviations = plan ? allocation.map((item) => ({
    ...item,
    target: targetWeightFor(item, plan),
    drift: exactDifference(item.weight, targetWeightFor(item, plan)),
  })) : [];
  const largestDrift = [...deviations].sort(
    (a, b) => Math.abs(numeric(b.drift)) - Math.abs(numeric(a.drift)),
  )[0];
  const monthPrefix = monthKeyInCapitalTimeZone(portfolio.asOf);
  const monthlyContribution = cashFlows.cashFlows
    .filter((entry) => (
      entry.kind === "contribution" &&
      monthKeyInCapitalTimeZone(entry.occurredAt) === monthPrefix
    ))
    .reduce((sum, entry) => exactSum(sum, entry.amountKrw), "0");
  const contributionGap = plan
    ? exactDifference(plan.monthlyContributionKrw, monthlyContribution)
    : null;
  const historyReady = snapshots.length >= 2;

  let decisionText = "비교할 기록이 더 필요합니다.";
  let decisionDetail = "현재 상태를 기록하면 다음 검토부터 자산 변화와 현금흐름을 구분할 수 있습니다.";
  if (historyReady && !plan) {
    decisionText = `${signedKrw(change)} 변화를 확인했습니다. 계획 기준을 설정해 판단을 완성하세요.`;
    decisionDetail = "현재·과거 흐름은 보이지만 목표 자산과 월 투자금이 없어 계획 대비 진행 여부는 판단하지 않습니다.";
  } else if (historyReady && plan) {
    decisionText = `${formatCompactKrw(current)}, 목표의 ${formatDecimal(planProgress, 1)}%를 추적 중입니다.`;
    decisionDetail = compareDecimal(change, "0") >= 0
      ? `선택 기간 자산은 ${signedKrw(change)} 변했습니다. 시장·환율 효과와 자금 유입을 아래에서 분리해 확인하세요.`
      : `선택 기간 자산은 ${signedKrw(change)} 변했습니다. 현금흐름을 제외한 변화와 배분 편차를 우선 점검하세요.`;
  }

  return (
    <div className="review-screen">
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
              <dt>추적 자산</dt>
              <dd>{formatKrw(current)}</dd>
              <span>{formatAsOf(portfolio.asOf)} 기준</span>
            </div>
            <div>
              <dt>기간 변화</dt>
              <dd className={signedClass(change)}>{historyReady ? signedKrw(change) : "—"}</dd>
              <span>{storedSnapshots.length}개 저장 기록 + 현재 조회</span>
            </div>
            <div>
              <dt>목표 진행</dt>
              <dd>{planProgress === null ? "기준 없음" : `${formatDecimal(planProgress, 1)}%`}</dd>
              <span>{plan ? `${formatDate(plan.targetDate)}까지` : "Capital Plan에서 설정"}</span>
            </div>
          </dl>
        </div>
        <aside className="review-ribbon-checks" aria-label="다음 점검">
          <div className="check-heading">
            <span>이번 검토의 초점</span>
            <button type="button" onClick={() => onNavigate("plan")}>계획 열기</button>
          </div>
          <ol>
            <li>
              <span>배분</span>
              <strong>{largestDrift ? `${largestDrift.label} ${formatPercent(largestDrift.drift)}p` : "계획 없음"}</strong>
              <small>{plan ? "목표 대비 가장 큰 편차" : "계획 저장 후 비교"}</small>
            </li>
            <li>
              <span>투자금</span>
              <strong>{contributionGap === null ? "계획 없음" : compareDecimal(contributionGap, "0") > 0 ? `${formatCompactKrw(contributionGap)} 남음` : "월 계획 충족"}</strong>
              <small>이번 달 외부 입금 기준</small>
            </li>
            <li>
              <span>근거</span>
              <strong>{historyReady ? `${snapshots.length}개 시점` : "기록 부족"}</strong>
              <small>미래 예측 없이 과거 기록만 사용</small>
            </li>
          </ol>
        </aside>
      </section>

      <section className="review-chart-section" aria-labelledby="asset-trend-title">
        <div className="section-heading-inline">
          <div>
            <h2 id="asset-trend-title">자산 성장과 계획 기준</h2>
            <p>채운 점은 입출금, 마지막 테두리 점은 현재 조회입니다. 선은 관측 시점 사이를 직선으로 연결하며 장중 수익률 곡선이 아닙니다.</p>
          </div>
          {plan && targetRatio && targetRatio > 1.25 ? (
            <div className="goal-reference">
              목표 {formatCompactKrw(plan.targetAssetKrw)} · 현재의 {formatDecimal(targetRatio, 1)}배
            </div>
          ) : null}
        </div>
        <AssetTrendChart snapshots={snapshots} cashFlows={cashFlows.cashFlows} targetAssetKrw={plan?.targetAssetKrw} />
      </section>

      <section className="change-bridge" aria-labelledby="change-bridge-title">
        <div className="section-heading-inline">
          <div>
            <h2 id="change-bridge-title">무엇이 자산을 바꿨나</h2>
            <p>외부 자금 이동과 나머지 평가 변화를 분리합니다. 거래·배당·수수료별 귀속은 현재 데이터로 계산하지 않습니다.</p>
          </div>
          <button className="text-button" type="button" onClick={() => onNavigate("performance")}>성과 상세 보기</button>
        </div>
        <div className="bridge-track">
          <div className="bridge-node start">
            <span>시작 자산</span>
            <strong>{formatCompactKrw(first)}</strong>
          </div>
          <div className={`bridge-step ${signedClass(flow)}`}>
            <span>순 현금흐름</span>
            <strong>{metrics ? signedKrw(flow) : "—"}</strong>
            <small>{metrics ? `${metrics.flowCount}건 반영` : "분석 자료 부족"}</small>
          </div>
          <div className={`bridge-step ${signedClass(adjustedGain)}`}>
            <span>시장·환율 등</span>
            <strong>{historyReady ? signedKrw(adjustedGain) : "—"}</strong>
            <small>현금흐름 차감 잔여 변화</small>
          </div>
          <div className="bridge-node end">
            <span>현재 자산</span>
            <strong>{formatCompactKrw(current)}</strong>
          </div>
        </div>
      </section>

      <section className="diagnostic-band" aria-label="계획 진단">
        <div>
          <span>Unrealized P/L</span>
          <strong className={signedClass(portfolio.summary.profitLossKrw)}>{signedKrw(portfolio.summary.profitLossKrw)}</strong>
          <p>현재 조회의 누적 평가 손익이며 실현 손익이 아닙니다.</p>
        </div>
        <div>
          <span>Allocation</span>
          <strong>{largestDrift ? `${largestDrift.label} ${formatPercent(largestDrift.drift)}p` : "목표 배분 미설정"}</strong>
          <p>{plan ? "양수는 목표 초과, 음수는 목표 미달입니다." : "Capital Plan 저장 전에는 편차를 만들지 않습니다."}</p>
        </div>
        <div>
          <span>Cash plan</span>
          <strong>{plan ? `${formatCompactKrw(monthlyContribution)} / ${formatCompactKrw(plan.monthlyContributionKrw)}` : "월 투자금 미설정"}</strong>
          <p>계좌 밖에서 기록한 입금만 집계합니다.</p>
        </div>
        <div>
          <span>Next review</span>
          <strong>{historyReady ? plan ? "배분 편차와 평가 변화 확인" : "현재 배분과 평가 변화 확인" : "스냅샷 한 번 더 기록"}</strong>
          <p>매수·매도 판단이나 미래 수익률 예측은 제공하지 않습니다.</p>
        </div>
      </section>
    </div>
  );
}

function PerformanceScreen({ data, period, onPeriodChange }: {
  data: WorkspaceData;
  period: HistoryPeriod;
  onPeriodChange: (value: HistoryPeriod) => void;
}) {
  const storedSnapshots = filteredSnapshots(
    data.history.snapshots,
    period,
    data.portfolio.asOf,
  );
  const snapshots = appendLiveSnapshot(storedSnapshots, data.portfolio);
  const metrics = periodAnalytics(snapshots, data.cashFlows.cashFlows);
  return (
    <div className="content-screen performance-screen">
      <PageLead
        title="Performance"
        description="저장된 자산 시점과 사용자가 기록한 입출금으로 과거 성과를 설명합니다. 미래 수익률은 예측하지 않습니다."
        action={<PeriodControl value={period} onChange={onPeriodChange} />}
      />
      <section className="performance-overview">
        <div className="performance-chart-panel">
          <div className="section-heading-inline">
            <div>
              <h2>추적 자산의 변화</h2>
              <p>{snapshots.length}개 시점 · {snapshots[0] ? formatDate(snapshots[0].capturedAt) : "시작 없음"}부터</p>
            </div>
          </div>
          <AssetTrendChart snapshots={snapshots} cashFlows={data.cashFlows.cashFlows} targetAssetKrw={data.capitalPlan.plan?.targetAssetKrw} />
        </div>
        <dl className="performance-ledger">
          <div><dt>시작 추적 자산</dt><dd>{metrics ? formatKrw(metrics.startTrackedValueKrw) : "—"}</dd></div>
          <div><dt>총 변화</dt><dd className={signedClass(metrics?.grossChangeKrw)}>{metrics ? signedKrw(metrics.grossChangeKrw) : "—"}</dd></div>
          <div><dt>외부 입금</dt><dd>{metrics ? signedKrw(metrics.contributionsKrw) : "—"}</dd></div>
          <div><dt>외부 출금</dt><dd>{metrics ? compareDecimal(metrics.withdrawalsKrw, "0") === 0 ? formatKrw("0") : `-${formatKrw(metrics.withdrawalsKrw)}` : "—"}</dd></div>
          <div className="emphasis"><dt>현금흐름 조정 변화</dt><dd className={signedClass(metrics?.adjustedGainKrw)}>{metrics ? signedKrw(metrics.adjustedGainKrw) : "—"}</dd></div>
          <div><dt>Modified Dietz</dt><dd>{metrics?.modifiedDietzReturn ? formatPercent(metrics.modifiedDietzReturn) : "계산 불가"}</dd></div>
        </dl>
      </section>
      <section className="method-note">
        <h2>Modified Dietz 해석</h2>
        <p>이 값은 추적 자산 기준 Modified Dietz 추정치입니다. 기간 중 입출금 시점을 가중하지만 장중 거래, 배당, 세금, 수수료, 개별 종목 기여도나 완전한 시간가중수익률을 대체하지 않습니다.</p>
        {data.analytics.warnings.length ? (
          <ul>{data.analytics.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
        ) : null}
      </section>
      <section className="snapshot-register">
        <div className="section-heading-inline"><div><h2>기록 원장</h2><p>분석에 사용되는 불변 스냅샷입니다.</p></div></div>
        {storedSnapshots.length ? (
          <div className="table-scroll">
            <table>
              <thead><tr><th>기준 시각</th><th>추적 자산</th><th>평가 손익</th><th>보유 종목</th></tr></thead>
              <tbody>{[...storedSnapshots].reverse().map((snapshot) => (
                <tr key={snapshot.id}>
                  <td>{formatDate(snapshot.capturedAt, true)}</td>
                  <td>{formatKrw(snapshot.totalTrackedValueKrw)}</td>
                  <td className={signedClass(snapshot.profitLossKrw)}>{signedKrw(snapshot.profitLossKrw)}</td>
                  <td>{snapshot.holdingCount}개</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <StatusNotice>저장된 스냅샷이 없습니다. Data 화면에서 현재 상태를 기록하세요.</StatusNotice>}
      </section>
    </div>
  );
}

function AllocationRows({ allocation, plan }: { allocation: AllocationItem[]; plan: CapitalPlanView | null }) {
  const rows = (allocation.length ? allocation : DEFAULT_ALLOCATION).map((item) => {
    const target = plan ? targetWeightFor(item, plan) : null;
    return { ...item, target, drift: target ? exactDifference(item.weight, target) : null };
  });
  return (
    <div className="allocation-rows">
      {rows.map((item) => {
        const currentPercent = Math.max(0, Math.min(100, numeric(item.weight) * 100));
        const targetPercent = item.target === null ? null : Math.max(0, Math.min(100, numeric(item.target) * 100));
        return (
          <div className="allocation-row" key={item.key}>
            <div className="allocation-label">
              <div><strong>{item.label}</strong><span>{formatKrw(item.valueKrw)}</span></div>
              <div><strong>{formatPercent(item.weight)}</strong><span className={item.drift === null ? undefined : signedClass(item.drift)}>{item.drift === null ? "목표 미설정" : `${formatPercent(item.drift)}p`}</span></div>
            </div>
            <div className="allocation-track" aria-label={item.target === null ? `${item.label} 현재 ${formatPercent(item.weight)}, 목표 미설정` : `${item.label} 현재 ${formatPercent(item.weight)}, 목표 ${formatPercent(item.target)}`}>
              <span className="allocation-fill" style={{ width: `${currentPercent}%` }} />
              {targetPercent === null ? null : <span className="allocation-target" style={{ left: `${targetPercent}%` }} />}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PortfolioScreen({
  data,
  onExternalAssetsChanged,
}: {
  data: WorkspaceData;
  onExternalAssetsChanged: (payload: ExternalAssetsPayload) => void;
}) {
  const [sort, setSort] = useState<HoldingSort>("value");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<HoldingItem | null>(null);
  const [holdingHistory, setHoldingHistory] = useState<HoldingHistoryPayload | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const holdings = useMemo(() => data.portfolio.holdings.filter((holding) => {
    const needle = query.trim().toLocaleLowerCase("ko");
    return !needle || `${holding.name} ${holding.symbol}`.toLocaleLowerCase("ko").includes(needle);
  }).sort((left, right) => {
    if (sort === "name") return left.name.localeCompare(right.name, "ko");
    if (sort === "profit") return numeric(right.profitLossRate) - numeric(left.profitLossRate);
    if (sort === "daily") return numeric(right.dailyProfitLossRate) - numeric(left.dailyProfitLossRate);
    return numeric(right.marketValueKrw) - numeric(left.marketValueKrw);
  }), [data.portfolio.holdings, query, sort]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    const search = new URLSearchParams({
      symbol: selected.symbol,
      marketCountry: selected.marketCountry,
      currency: selected.currency,
      limit: "365",
    });
    fetchJson<HoldingHistoryPayload>(`/api/holding-history?${search.toString()}`)
      .then((payload) => { if (!cancelled) setHoldingHistory(payload); })
      .catch((error: unknown) => { if (!cancelled) setHistoryError(error instanceof Error ? error.message : "종목 이력을 불러오지 못했습니다."); });
    return () => { cancelled = true; };
  }, [selected]);

  const holdingSnapshots: HistorySnapshot[] = holdingHistory?.points.map((point) => ({
    id: point.snapshotId,
    capturedAt: point.capturedAt,
    equityValueKrw: point.marketValueKrw,
    profitLossKrw: point.profitLossNative,
    buyingPowerKrw: "0",
    totalTrackedValueKrw: point.marketValueKrw,
    usdKrwRate: point.usdKrwRate,
    holdingCount: 1,
  })) ?? [];

  function holdingKey(holding: HoldingItem): string {
    return `${holding.marketCountry}:${holding.currency}:${holding.symbol}`;
  }

  function toggleHolding(holding: HoldingItem): void {
    setHoldingHistory(null);
    setHistoryError(null);
    setSelected(selected && holdingKey(selected) === holdingKey(holding) ? null : holding);
  }

  const plan = data.capitalPlan.plan;
  const investmentValueKrw = totalTracked(data.portfolio);
  const registeredValueKrw = exactSum(
    investmentValueKrw,
    data.externalAssets.totalValueKrw,
  );
  const assetReviewDiagnostics = useMemo(
    () => data.externalAssets.status === "ready"
      ? externalAssetReviewDiagnostics(data.externalAssets, data.portfolio.asOf)
      : null,
    [data.externalAssets, data.portfolio.asOf],
  );
  const currentWholeAssetPoint = data.externalAssets.status === "unavailable"
    ? null
    : {
        month: monthKeyInCapitalTimeZone(data.portfolio.asOf) ?? undefined,
        observedAt: data.portfolio.asOf,
        portfolioValueKrw: investmentValueKrw,
        externalValueKrw: data.externalAssets.totalValueKrw,
        totalRegisteredValueKrw: registeredValueKrw,
        externalAssetCount: data.externalAssets.assets.filter(
          (asset) => compareDecimal(asset.valueKrw, "0") !== 0,
        ).length,
      };

  return (
    <div className="content-screen portfolio-screen">
      <PageLead title="Portfolio" description={plan ? "연결 자산과 수동 등록 자산을 한눈에 보고, 투자 계좌 배분은 저장한 계획 기준과 별도로 비교합니다." : "연결 자산과 수동 등록 자산을 한눈에 봅니다. 투자 계좌의 목표 편차는 계획을 저장한 뒤 표시합니다."} />
      <section className="whole-asset-overview" aria-labelledby="whole-asset-heading">
        <div className="section-heading-inline">
          <div>
            <h2 id="whole-asset-heading">내 자산 한눈에 보기</h2>
            <p>등록 총액은 토스 연결 자산과 직접 확인해 입력한 외부 자산을 합산합니다.</p>
          </div>
          <span className="scope-label">등록 범위</span>
        </div>
        <dl className="whole-asset-ledger">
          <div className="emphasis"><dt>등록 자산 총액</dt><dd>{data.externalAssets.status === "unavailable" ? "확인 불가" : formatKrw(registeredValueKrw)}</dd></div>
          <div><dt>토스 연결 자산</dt><dd>{formatKrw(investmentValueKrw)}</dd></div>
          <div><dt>수동 등록 자산</dt><dd>{data.externalAssets.status === "unavailable" ? "불러오기 실패" : formatKrw(data.externalAssets.totalValueKrw)}</dd></div>
        </dl>
        <p className="scope-disclosure">이 합계는 자산 현황용입니다. 수동 등록 자산은 현금 흐름 관계가 검증되기 전까지 투자 수익률과 손익 계산에서 제외합니다.</p>
      </section>
      <WholeAssetTrendChart
        payload={data.wholeAssetHistory}
        currentPoint={currentWholeAssetPoint}
      />
      <ExternalAssetReviewQueue
        diagnostics={assetReviewDiagnostics}
        status={data.externalAssets.status === "ready"
          ? "ready"
          : data.externalAssets.status}
      />
      {data.externalAssets.count > data.externalAssets.assets.length ? (
        <p className="asset-review-scope-note" role="note">
          점검 큐는 현재 불러온 최근 {data.externalAssets.assets.length}건 기준입니다. 전체 {data.externalAssets.count}건을 점검하려면 목록 페이지네이션이 필요합니다.
        </p>
      ) : null}
      <ExternalAssetLedger
        payload={data.externalAssets}
        mode={data.portfolio.mode}
        onChanged={onExternalAssetsChanged}
      />
      <section className="portfolio-allocation">
        <div className="section-heading-inline">
          <div><h2>{plan ? "목표 배분과의 거리" : "현재 배분"}</h2><p>{plan ? "막대는 현재 비중, 세로 표시는 저장한 목표 비중입니다. 편차는 판단 근거이며 거래 지시가 아닙니다." : "막대는 현재 비중입니다. 저장된 자본 계획이 없어 목표선과 편차를 만들지 않습니다."}</p></div>
          <span className="legend-inline"><i />현재 {plan ? <><b />목표</> : null}</span>
        </div>
        <AllocationRows allocation={data.portfolio.allocation} plan={data.capitalPlan.plan} />
      </section>
      <section className="holdings-section">
        <div className="section-heading-inline">
          <div><h2>보유 자산</h2><p>{holdings.length}개 종목 · 원화 환산 가치는 조회 시점 환율을 포함합니다.</p></div>
          <div className="holdings-controls">
            <label className="holding-search"><span>종목 검색</span><input type="search" value={query} placeholder="이름 또는 심볼" onChange={(event) => setQuery(event.target.value)} /></label>
            <label className="sort-control"><span>정렬</span>
              <select value={sort} onChange={(event) => setSort(event.target.value as HoldingSort)}>
                <option value="value">평가금액</option><option value="profit">누적 수익률</option><option value="daily">일간 수익률</option><option value="name">이름</option>
              </select>
            </label>
          </div>
        </div>
        {holdings.length ? (
          <div className="table-scroll holdings-table">
            <table>
              <thead><tr><th>종목</th><th>수량</th><th>평가금액</th><th>누적</th><th>오늘</th><th><span className="sr-only">이력</span></th></tr></thead>
              <tbody>{holdings.map((holding) => (
                <tr key={holdingKey(holding)} className={selected && holdingKey(selected) === holdingKey(holding) ? "selected" : ""}>
                  <td><strong>{holding.name}</strong><span>{holding.symbol} · {holding.marketCountry === "KR" ? "국내" : "미국"}</span></td>
                  <td>{formatDecimal(holding.quantity, 4)}</td>
                  <td><strong>{formatKrw(holding.marketValueKrw)}</strong><span>{holding.currency === "KRW" ? formatKrw(holding.marketValueNative) : `$${formatDecimal(holding.marketValueNative, 2)}`}</span></td>
                  <td className={signedClass(holding.profitLossRate)}>{formatPercent(holding.profitLossRate)}</td>
                  <td className={signedClass(holding.dailyProfitLossRate)}>{formatPercent(holding.dailyProfitLossRate)}</td>
                  <td><button type="button" className="row-button" onClick={() => toggleHolding(holding)}>{selected && holdingKey(selected) === holdingKey(holding) ? "닫기" : "추이"}</button></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <StatusNotice>표시할 보유 종목이 없습니다.</StatusNotice>}
        {holdings.length ? (
          <ul className="mobile-holdings">
            {holdings.map((holding) => {
              const isSelected = selected && holdingKey(selected) === holdingKey(holding);
              return (
                <li key={`mobile-${holdingKey(holding)}`}>
                  <div className="mobile-holding-title"><div><strong>{holding.name}</strong><span>{holding.symbol} · {holding.marketCountry === "KR" ? "국내" : "미국"}</span></div><strong>{formatKrw(holding.marketValueKrw)}</strong></div>
                  <dl><div><dt>수량</dt><dd>{formatDecimal(holding.quantity, 4)}</dd></div><div><dt>누적</dt><dd className={signedClass(holding.profitLossRate)}>{formatPercent(holding.profitLossRate)}</dd></div><div><dt>오늘</dt><dd className={signedClass(holding.dailyProfitLossRate)}>{formatPercent(holding.dailyProfitLossRate)}</dd></div></dl>
                  <button type="button" onClick={() => toggleHolding(holding)} aria-expanded={Boolean(isSelected)}>{isSelected ? "가치 추이 닫기" : "저장된 가치 추이 보기"}</button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>
      {selected ? (
        <section className="holding-detail" aria-live="polite">
          <div className="section-heading-inline">
            <div><h2>{holdingHistory?.holding?.name ?? selected.name} 가치 추이</h2><p>저장된 스냅샷에서 시장·통화·심볼이 모두 같은 항목을 찾은 결과입니다. 종목별 기여도나 거래 성과로 해석하지 않습니다.</p></div>
            <button className="text-button" type="button" onClick={() => setSelected(null)}>닫기</button>
          </div>
          {historyError ? <StatusNotice tone="danger">{historyError}</StatusNotice> : holdingHistory ? <AssetTrendChart compact snapshots={holdingSnapshots} /> : <div className="inline-loader">종목 이력을 불러오는 중…</div>}
        </section>
      ) : null}
    </div>
  );
}

function CapitalPlanForm({ payload, allocation, mode, onSaved, currentAssetKrw }: {
  payload: CapitalPlanPayload;
  allocation: AllocationItem[];
  mode: PortfolioPayload["mode"];
  onSaved: (plan: CapitalPlanView) => void;
  currentAssetKrw: string;
}) {
  const fallback = allocation.length ? allocation : DEFAULT_ALLOCATION;
  const initial = useMemo<CapitalPlanDraft>(() => ({
    startAssetKrw: payload.plan?.startAssetKrw ?? currentAssetKrw,
    targetAssetKrw: payload.plan?.targetAssetKrw ?? "500000000",
    startDate: payload.plan?.startDate ?? currentDateInput(),
    targetDate: payload.plan?.targetDate ?? defaultTargetDate(),
    monthlyContributionKrw: payload.plan?.monthlyContributionKrw ?? "2000000",
    targetKrWeight: payload.plan?.targetKrWeight ?? String(fallback.find((item) => item.key === "KR")?.targetWeight ?? "0.45"),
    targetUsWeight: payload.plan?.targetUsWeight ?? String(fallback.find((item) => item.key === "US")?.targetWeight ?? "0.45"),
    targetCashWeight: payload.plan?.targetCashWeight ?? String(fallback.find((item) => item.key === "CASH")?.targetWeight ?? "0.1"),
  }), [payload.plan, fallback, currentAssetKrw]);
  const [draft, setDraft] = useState<CapitalPlanDraft>(initial);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const weightTotal = numeric(draft.targetKrWeight) + numeric(draft.targetUsWeight) + numeric(draft.targetCashWeight);
  const assetRangeValid = /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(draft.startAssetKrw) &&
    /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(draft.targetAssetKrw) &&
    compareDecimal(draft.startAssetKrw, "0") > 0 &&
    compareDecimal(draft.targetAssetKrw, draft.startAssetKrw) > 0;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setNotice(null);
    setError(null);
    try {
      const response = await fetchJson<{ plan: CapitalPlanView; updated: boolean }>("/api/capital-plan", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-LedgerLens-Intent": "update-capital-plan" },
        body: JSON.stringify({ ...draft, expectedRevision: payload.plan?.revision ?? 0 }),
      });
      onSaved(response.plan);
      setNotice(response.updated ? "자본 계획을 저장했습니다." : "이미 같은 계획이 저장되어 있습니다.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "자본 계획을 저장하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="capital-plan-form" onSubmit={submit}>
      <div className="plan-primary-fields">
        <label><span>계획 시작 자산</span><span className="input-with-unit"><input value={draft.startAssetKrw} inputMode="decimal" pattern={DECIMAL_INPUT_PATTERN} onChange={(event) => setDraft({ ...draft, startAssetKrw: event.target.value })} required /><em>원</em></span></label>
        <label><span>목표 자산</span><span className="input-with-unit"><input value={draft.targetAssetKrw} inputMode="decimal" pattern={DECIMAL_INPUT_PATTERN} onChange={(event) => setDraft({ ...draft, targetAssetKrw: event.target.value })} required /><em>원</em></span></label>
        <label><span>월 투자금</span><span className="input-with-unit"><input value={draft.monthlyContributionKrw} inputMode="decimal" pattern={DECIMAL_INPUT_PATTERN} onChange={(event) => setDraft({ ...draft, monthlyContributionKrw: event.target.value })} required /><em>원</em></span></label>
        <label><span>계획 시작일</span><input type="date" value={draft.startDate} onChange={(event) => setDraft({ ...draft, startDate: event.target.value })} required /></label>
        <label><span>목표일</span><input type="date" value={draft.targetDate} min={draft.startDate} onChange={(event) => setDraft({ ...draft, targetDate: event.target.value })} required /></label>
      </div>
      <fieldset className="weight-fields">
        <legend>목표 배분 비율</legend>
        <p>소수로 입력합니다. 예: 45%는 0.45</p>
        <div>
          <label><span>국내주식</span><input value={draft.targetKrWeight} inputMode="decimal" onChange={(event) => setDraft({ ...draft, targetKrWeight: event.target.value })} /></label>
          <label><span>미국주식</span><input value={draft.targetUsWeight} inputMode="decimal" onChange={(event) => setDraft({ ...draft, targetUsWeight: event.target.value })} /></label>
          <label><span>현금</span><input value={draft.targetCashWeight} inputMode="decimal" onChange={(event) => setDraft({ ...draft, targetCashWeight: event.target.value })} /></label>
        </div>
        <strong className={Math.abs(weightTotal - 1) < 0.0000001 ? "valid" : "invalid"}>합계 {formatDecimal(weightTotal * 100, 2)}%</strong>
      </fieldset>
      {!assetRangeValid ? <StatusNotice tone="warning">목표 자산은 계획 시작 자산보다 커야 합니다.</StatusNotice> : null}
      {!payload.plan ? <StatusNotice>시작 자산에는 현재 추적 자산을 제안하고, 45 / 45 / 10 비중과 나머지 금액은 저장 전 템플릿으로만 표시합니다.</StatusNotice> : null}
      {mode === "demo" ? <StatusNotice tone="warning">Demo에서는 계획을 미리 작성해 볼 수 있지만 저장하지 않습니다. 실계좌 연결 후 같은 화면에서 저장할 수 있습니다.</StatusNotice> : null}
      {error ? <StatusNotice tone="danger">{error}</StatusNotice> : null}
      {notice ? <StatusNotice>{notice}</StatusNotice> : null}
      <div className="form-actions">
        <button className="primary-button" type="submit" disabled={saving || mode === "demo" || !assetRangeValid || Math.abs(weightTotal - 1) >= 0.0000001}>{saving ? "저장 중…" : payload.plan ? "계획 업데이트" : "계획 저장"}</button>
        {payload.plan ? <span>revision {payload.plan.revision} · {formatDate(payload.plan.updatedAt, true)} 수정</span> : <span>계획은 읽기 전용 계좌 데이터와 별도로 저장됩니다.</span>}
      </div>
    </form>
  );
}

function CashFlowLedger({ cashFlows, mode, onRecorded }: {
  cashFlows: CashFlowEntry[];
  mode: PortfolioPayload["mode"];
  onRecorded: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<CashFlowDraft>({ kind: "contribution", amountKrw: "", occurredAt: currentDateTimeInput(), note: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const idempotency = useRef<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    const key = idempotency.current ?? `cash-flow-${Date.now()}-${crypto.randomUUID()}`;
    idempotency.current = key;
    try {
      await fetchJson("/api/cash-flows", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key, "X-LedgerLens-Intent": "record-cash-flow" },
        body: JSON.stringify({ kind: draft.kind, amountKrw: draft.amountKrw, occurredAt: capitalDateTimeInputToIso(draft.occurredAt), note: draft.note }),
      });
      idempotency.current = null;
      setDraft({ kind: "contribution", amountKrw: "", occurredAt: currentDateTimeInput(), note: "" });
      await onRecorded();
      setNotice("현금흐름 원장에 기록했습니다.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "현금흐름을 기록하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="cashflow-ledger">
      <form onSubmit={submit}>
        <div className="cashflow-fields">
          <label><span>구분</span><select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as CashFlowKind })}><option value="contribution">외부 입금</option><option value="withdrawal">외부 출금</option></select></label>
          <label><span>금액</span><span className="input-with-unit"><input value={draft.amountKrw} inputMode="decimal" onChange={(event) => setDraft({ ...draft, amountKrw: event.target.value })} required /><em>원</em></span></label>
          <label><span>발생 시각 (KST)</span><input type="datetime-local" value={draft.occurredAt} onChange={(event) => setDraft({ ...draft, occurredAt: event.target.value })} required /></label>
          <label className="wide"><span>메모</span><input value={draft.note} maxLength={200} placeholder="예: 8월 정기 투자금" onChange={(event) => setDraft({ ...draft, note: event.target.value })} /></label>
        </div>
        <div className="form-actions"><button className="secondary-button" disabled={saving || mode === "demo"} type="submit">{saving ? "기록 중…" : "현금흐름 기록"}</button><span>주식 매매나 계좌 안의 환전은 현금흐름이 아니므로 기록하지 않습니다.</span></div>
      </form>
      {mode === "demo" ? <StatusNotice tone="warning">Demo 데이터에는 원장 항목을 저장하지 않습니다.</StatusNotice> : null}
      {error ? <StatusNotice tone="danger">{error}</StatusNotice> : null}
      {notice ? <StatusNotice>{notice}</StatusNotice> : null}
      {cashFlows.length ? (
        <div className="table-scroll compact-table"><table><thead><tr><th>발생 시각</th><th>구분</th><th>금액</th><th>메모</th></tr></thead><tbody>{cashFlows.map((entry) => <tr key={entry.id}><td>{formatDate(entry.occurredAt, true)}</td><td>{entry.kind === "contribution" ? "외부 입금" : "외부 출금"}</td><td className={entry.kind === "contribution" ? "positive" : "negative"}>{entry.kind === "contribution" ? "+" : "-"}{formatKrw(entry.amountKrw)}</td><td>{entry.note || "—"}</td></tr>)}</tbody></table></div>
      ) : <p className="empty-row">기록된 외부 입출금이 없습니다.</p>}
    </div>
  );
}

function PlanScreen({ data, onPlanSaved, onDataReload }: {
  data: WorkspaceData;
  onPlanSaved: (plan: CapitalPlanView) => void;
  onDataReload: () => Promise<void>;
}) {
  return (
    <div className="content-screen plan-screen">
      <PageLead title="Capital Plan" description="목표 자산·기간·월 투자금·목표 배분을 하나의 기준으로 관리합니다. 예상 수익률이나 매매 시나리오는 계산하지 않습니다." />
      <section className="plan-editor">
        <div className="section-heading-inline"><div><h2>계획 기준</h2><p>Review와 Portfolio의 계획 대비 표시에 즉시 사용됩니다.</p></div></div>
        <CapitalPlanForm key={data.capitalPlan.plan?.revision ?? 0} payload={data.capitalPlan} allocation={data.portfolio.allocation} mode={data.portfolio.mode} currentAssetKrw={totalTracked(data.portfolio)} onSaved={onPlanSaved} />
      </section>
      <section className="cashflow-section">
        <div className="section-heading-inline"><div><h2>외부 자금 원장</h2><p>성과에서 자금 유입 효과를 분리하기 위해 계좌와 외부 사이의 입출금만 기록합니다.</p></div></div>
        <CashFlowLedger cashFlows={data.cashFlows.cashFlows} mode={data.portfolio.mode} onRecorded={onDataReload} />
      </section>
    </div>
  );
}

function automationLabel(status: AutomationPayload["status"]): string {
  const labels: Record<AutomationPayload["status"], string> = {
    demo: "Demo · 저장 안 함",
    "manual-only": "Direct · 수동 기록",
    ready: "Relay 준비됨",
    "awaiting-trigger": "트리거 확인 대기",
    scheduled: "평일 자동 기록",
    degraded: "자동 기록 점검 필요",
  };
  return labels[status];
}

function DataScreen({ data, onReload, onExternalAssetsChanged }: {
  data: WorkspaceData;
  onReload: () => Promise<void>;
  onExternalAssetsChanged: (payload: ExternalAssetsPayload) => Promise<void>;
}) {
  const [capturing, setCapturing] = useState(false);
  const [savingAutomation, setSavingAutomation] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function capture() {
    setCapturing(true); setNotice(null); setError(null);
    try {
      await fetchJson("/api/history", { method: "POST", headers: { "Idempotency-Key": `snapshot-${Date.now()}-${crypto.randomUUID()}`, "X-LedgerLens-Intent": "capture" } });
      await onReload();
      setNotice("현재 상태를 새 스냅샷으로 기록했습니다.");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "스냅샷을 저장하지 못했습니다."); }
    finally { setCapturing(false); }
  }

  async function setAutomation(enabled: boolean) {
    const schedule = data.automation?.schedule;
    if (!schedule) return;
    setSavingAutomation(true); setNotice(null); setError(null);
    try {
      await fetchJson("/api/automation", { method: "PUT", headers: { "Content-Type": "application/json", "X-LedgerLens-Intent": "configure-snapshot-schedule" }, body: JSON.stringify({ enabled, expectedRevision: schedule.revision }) });
      await onReload();
      setNotice(enabled ? "자동 기록 설정을 저장했습니다. 실제 트리거 확인 전에는 활성으로 보지 않습니다." : "자동 기록을 껐습니다.");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "자동 기록 설정을 변경하지 못했습니다."); }
    finally { setSavingAutomation(false); }
  }

  return (
    <div className="content-screen data-screen">
      <PageLead title="Data & Records" description="조회 연결, 스냅샷, 자동 기록 상태를 관리합니다. 이 화면에서 주문이나 계좌 변경은 수행하지 않습니다." />
      <TossCredentialSettings onConnectionChanged={onReload} />
      <section className="connection-register">
        <div className="section-heading-inline"><div><h2>연결 상태</h2><p>브라우저에는 마스킹된 식별자와 읽기 상태만 표시합니다.</p></div></div>
        <dl className="connection-list">
          <div><dt>소스</dt><dd>{data.portfolio.mode === "demo" ? "Demo sample" : data.portfolio.mode === "relay" ? "Fixed-egress relay" : "Direct API"}</dd></div>
          <div><dt>계좌</dt><dd>{data.portfolio.account.maskedNumber} · {data.portfolio.account.type}</dd></div>
          <div><dt>마지막 조회</dt><dd>{formatAsOf(data.portfolio.asOf)} KST</dd></div>
          <div><dt>권한 경계</dt><dd>Read only · 주문 미지원</dd></div>
        </dl>
        {data.portfolio.notices.length ? <ul className="notice-list">{data.portfolio.notices.map((item) => <li key={item}>{item}</li>)}</ul> : null}
      </section>
      <section className="record-controls">
        <div>
          <h2>수동 스냅샷</h2>
          <p>현재 포트폴리오를 다시 조회한 뒤 D1에 한 시점으로 저장합니다. Demo에서는 저장하지 않습니다.</p>
          <button className="primary-button" type="button" disabled={capturing || data.portfolio.mode === "demo"} onClick={capture}>{capturing ? "기록 중…" : "현재 상태 기록"}</button>
        </div>
        <div>
          <h2>평일 자동 기록</h2>
          <p>{data.automation ? `${automationLabel(data.automation.status)} · 월–금 07:10 KST 목표` : "자동 기록 상태를 확인할 수 없습니다."}</p>
          {data.automation?.schedule ? (
            <button className="secondary-button" type="button" disabled={savingAutomation || (!data.automation.canManageSchedule && !data.automation.schedule.enabled)} onClick={() => setAutomation(!data.automation?.schedule?.enabled)}>{savingAutomation ? "변경 중…" : data.automation.schedule.enabled ? "자동 기록 끄기" : "자동 기록 켜기"}</button>
          ) : null}
        </div>
      </section>
      {error ? <StatusNotice tone="danger">{error}</StatusNotice> : null}
      {notice ? <StatusNotice>{notice}</StatusNotice> : null}
      <ExternalAssetCsvTransfer
        payload={data.externalAssets}
        mode={data.portfolio.mode}
        onImported={onExternalAssetsChanged}
      />
      <section className="automation-runs">
        <div className="section-heading-inline"><div><h2>최근 자동 기록 실행</h2><p>운영 메타데이터만 표시하며 포트폴리오 payload나 비밀값은 포함하지 않습니다.</p></div></div>
        {data.automation?.recentRuns.length ? (
          <div className="table-scroll compact-table"><table><thead><tr><th>예정 시각</th><th>상태</th><th>시도</th><th>완료</th></tr></thead><tbody>{data.automation.recentRuns.map((run) => <tr key={run.id}><td>{formatDate(run.scheduledFor, true)}</td><td>{run.status}</td><td>{run.attemptCount}</td><td>{run.finishedAt ? formatDate(run.finishedAt, true) : "—"}</td></tr>)}</tbody></table></div>
        ) : <p className="empty-row">자동 기록 실행 이력이 없습니다.</p>}
      </section>
    </div>
  );
}

export default function HomePage() {
  const [view, setView] = useState<WorkspaceView>("review");
  const [period, setPeriod] = useState<HistoryPeriod>(90);
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [partialWarning, setPartialWarning] = useState<string | null>(null);
  const wholeAssetHistoryRequest = useRef(0);

  const loadData = useCallback(async (initial = false) => {
    wholeAssetHistoryRequest.current += 1;
    if (initial) setLoading(true); else setRefreshing(true);
    setError(null);
    setPartialWarning(null);
    try {
      const portfolio = await fetchJson<PortfolioPayload>("/api/portfolio");
      const results = await Promise.allSettled([
        fetchJson<HistoryPayload>("/api/history?limit=365"),
        fetchJson<CashFlowsPayload>("/api/cash-flows?limit=365"),
        fetchJson<AnalyticsPayload>("/api/analytics?limit=365"),
        fetchJson<AutomationPayload>("/api/automation?limit=10"),
        fetchJson<CapitalPlanPayload>("/api/capital-plan"),
        fetchJson<ReviewJournalPayload>("/api/reviews?limit=12"),
        fetchJson<ExternalAssetsPayload>("/api/external-assets"),
        fetchJson<WholeAssetHistoryPayload>("/api/whole-asset-history?months=24"),
      ]);
      const failed = results.filter((result) => result.status === "rejected").length;
      const value = <T,>(index: number, fallback: T): T => {
        const result = results[index];
        return result.status === "fulfilled" ? result.value as T : fallback;
      };
      setData({
        portfolio,
        history: value(0, EMPTY_HISTORY),
        cashFlows: value(1, EMPTY_CASH_FLOWS),
        analytics: value(2, EMPTY_ANALYTICS),
        automation: value<AutomationPayload | null>(3, null),
        capitalPlan: value(4, portfolio.mode === "demo" ? { status: "demo", plan: null } : EMPTY_PLAN),
        reviewJournal: value(5, portfolio.mode === "demo" ? { status: "demo", reviews: [], count: 0 } : EMPTY_REVIEWS),
        externalAssets: value(6, portfolio.mode === "demo"
          ? { ...EMPTY_EXTERNAL_ASSETS, status: "demo" }
          : EMPTY_EXTERNAL_ASSETS),
        wholeAssetHistory: value(7, portfolio.mode === "demo"
          ? { ...EMPTY_WHOLE_ASSET_HISTORY, status: "demo" }
          : EMPTY_WHOLE_ASSET_HISTORY),
      });
      if (failed) setPartialWarning(`${failed}개 보조 데이터 영역을 불러오지 못했습니다. 현재 포트폴리오는 계속 확인할 수 있습니다.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "포트폴리오를 불러오지 못했습니다.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadData(true); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadData]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const initialView = viewFromHash();
      if (initialView) setView(initialView);
    }, 0);
    const onHashChange = () => {
      const nextView = viewFromHash();
      if (nextView) {
        setView(nextView);
        focusWorkspaceHeading();
      }
    };
    window.addEventListener("hashchange", onHashChange);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("hashchange", onHashChange);
    };
  }, []);

  function changeView(next: WorkspaceView) {
    setView(next);
    window.history.pushState(null, "", `#${next}`);
    window.scrollTo({
      top: 0,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
    focusWorkspaceHeading();
  }

  function updatePlan(plan: CapitalPlanView) {
    setData((current) => current ? { ...current, capitalPlan: { status: "ready", plan } } : current);
  }

  function addReview(review: ReviewJournalEntry) {
    setData((current) => current ? {
      ...current,
      reviewJournal: {
        status: "ready",
        reviews: [review, ...current.reviewJournal.reviews.filter((item) => item.id !== review.id)],
        count: current.reviewJournal.reviews.some((item) => item.id === review.id)
          ? current.reviewJournal.count
          : current.reviewJournal.count + 1,
      },
    } : current);
  }

  function updateReview(review: ReviewJournalEntry) {
    setData((current) => current ? {
      ...current,
      reviewJournal: {
        ...current.reviewJournal,
        reviews: current.reviewJournal.reviews.map((item) => item.id === review.id ? review : item),
      },
    } : current);
  }

  async function updateExternalAssets(payload: ExternalAssetsPayload): Promise<void> {
    const requestId = wholeAssetHistoryRequest.current + 1;
    wholeAssetHistoryRequest.current = requestId;
    setData((current) => current ? { ...current, externalAssets: payload } : current);
    try {
      const wholeAssetHistory = await fetchJson<WholeAssetHistoryPayload>("/api/whole-asset-history?months=24");
      if (wholeAssetHistoryRequest.current !== requestId) return;
      setData((current) => current ? { ...current, wholeAssetHistory } : current);
      setPartialWarning((current) => current === WHOLE_ASSET_HISTORY_RELOAD_WARNING ? null : current);
    } catch {
      if (wholeAssetHistoryRequest.current === requestId) {
        setPartialWarning(WHOLE_ASSET_HISTORY_RELOAD_WARNING);
      }
    }
  }

  const mode = data?.portfolio.mode ?? "demo";

  return (
    <div className="app-shell">
      <WorkspaceNav active={view} onChange={changeView} mode={mode} />
      <main id="workspace-main" tabIndex={-1}>
        <div className="workspace-toolbar">
          <div>
            <span>{data ? `${data.portfolio.account.maskedNumber} · ${formatAsOf(data.portfolio.asOf)}` : "LedgerLens workspace"}</span>
            {data?.portfolio.mode === "demo" ? <strong>Demo</strong> : <strong>Read only</strong>}
          </div>
          <button type="button" onClick={() => void loadData(false)} disabled={refreshing || loading}>
            <RefreshIcon />
            {refreshing ? "새로고침 중" : "새로고침"}
          </button>
        </div>
        {partialWarning ? <div className="workspace-message"><StatusNotice tone="warning">{partialWarning}</StatusNotice></div> : null}
        {loading ? (
          <div className="loading-workspace" aria-live="polite" aria-busy="true">
            <div className="loading-line long" /><div className="loading-line" />
            <div className="loading-chart" />
            <span>자산 대시보드와 저장 기록을 불러오는 중…</span>
          </div>
        ) : error || !data ? (
          <div className="fatal-state" role="alert">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2.8 20h18.4L12 3Z" /><path d="M12 9v5M12 17.5h.01" /></svg>
            <h1>워크스페이스를 열지 못했습니다</h1>
            <p>{error ?? "필수 포트폴리오 응답이 없습니다."}</p>
            <button className="primary-button" type="button" onClick={() => void loadData(true)}>다시 시도</button>
          </div>
        ) : (
          <>
            {view === "review" ? (
              <>
                <DashboardWorkspace
                  data={data}
                  period={period}
                  onPeriodChange={setPeriod}
                  onNavigate={changeView}
                />
                <details className="dashboard-review-drawer">
                  <summary>
                    <span><strong>10분 정기 Review</strong>데이터 신뢰도 → 계획 페이스 → 관측 가능한 변화 → 다음 행동을 기록합니다.</span>
                    <span aria-hidden="true">열기</span>
                  </summary>
                  <ReviewWorkspace data={data} period={period} onPeriodChange={setPeriod} onNavigate={changeView} onReviewAdded={addReview} onReviewUpdated={updateReview} />
                </details>
              </>
            ) : null}
            {view === "performance" ? <PerformanceScreen data={data} period={period} onPeriodChange={setPeriod} /> : null}
            {view === "portfolio" ? <PortfolioScreen data={data} onExternalAssetsChanged={updateExternalAssets} /> : null}
            {view === "plan" ? <PlanScreen data={data} onPlanSaved={updatePlan} onDataReload={() => loadData(false)} /> : null}
            {view === "data" ? <DataScreen data={data} onReload={() => loadData(false)} onExternalAssetsChanged={updateExternalAssets} /> : null}
          </>
        )}
      </main>
      <footer className="app-footer">
        <span>LedgerLens</span>
        <p>읽기 전용 자산 분석 · 저장된 데이터 범위 안에서만 설명합니다.</p>
      </footer>
    </div>
  );
}
