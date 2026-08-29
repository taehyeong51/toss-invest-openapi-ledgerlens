"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
  type TooltipValueType,
} from "recharts";
import {
  buildDashboardAssetBreakdown,
  canShowWholeAssetGrowth,
} from "@/lib/dashboard/model";
import {
  compareDecimal,
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
  AnalyticsPayload,
  ExternalAssetsPayload,
  HistoryPayload,
  HoldingHistoryPayload,
  HoldingItem,
  PortfolioPayload,
} from "../lib/ui-types";
import type {
  WholeAssetHistoryPayload,
  WholeAssetHistoryPoint,
} from "./WholeAssetTrendChart";
import type { WorkspaceView } from "./WorkspaceNav";

export type DashboardHistoryPeriod = 30 | 90 | 365 | "all";

interface DashboardWorkspaceData {
  portfolio: PortfolioPayload;
  history: HistoryPayload;
  externalAssets: ExternalAssetsPayload;
  wholeAssetHistory: WholeAssetHistoryPayload;
  analytics: AnalyticsPayload;
}

interface DashboardWorkspaceProps {
  data: DashboardWorkspaceData;
  period: DashboardHistoryPeriod;
  onPeriodChange: (period: DashboardHistoryPeriod) => void;
  onNavigate: (view: WorkspaceView) => void;
}

interface AssetDonutDatum {
  key: string;
  label: string;
  valueKrw: string;
  value: number;
  color: string;
}

interface GrowthDatum {
  month: string;
  axisLabel: string;
  tooltipLabel: string;
  observedAt: string;
  portfolioValueKrw: string;
  externalValueKrw: string;
  portfolioValue: number;
  externalValue: number;
  includesExternal: boolean;
}

interface ChangeDatum {
  key: string;
  label: string;
  valueKrw: string;
  value: number;
  fill: string;
}

const ASSET_LABELS: Record<string, { label: string; short: string; color: string }> = {
  cash: { label: "현금 · 주문 가능 금액", short: "현금", color: "var(--chart-cash)" },
  deposits: { label: "예금 · 적금", short: "예적금", color: "var(--chart-deposit)" },
  pensionInsurance: { label: "연금 · 보험", short: "연금/보험", color: "var(--chart-pension)" },
  equities: { label: "주식 · ETF", short: "주식/ETF", color: "var(--chart-equity)" },
  other: { label: "기타 · 분류 미조회", short: "기타", color: "var(--chart-other)" },
};

const PERIOD_OPTIONS: Array<{ value: DashboardHistoryPeriod; label: string }> = [
  { value: 30, label: "1M" },
  { value: 90, label: "3M" },
  { value: 365, label: "1Y" },
  { value: "all", label: "ALL" },
];

const GROWTH_WINDOWS = [6, 12, 24] as const;

function decimal(value: unknown): string {
  const text = String(value ?? "0").replace(/,/g, "");
  return /^-?\d+(?:\.\d+)?$/.test(text) ? text : "0";
}

function monthKey(value: string): string | null {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    timeZone: "Asia/Seoul",
  }).formatToParts(new Date(timestamp));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  return year && month ? `${year}-${month}` : null;
}

function monthLabel(value: string): string {
  const matched = /^(\d{4})-(\d{2})$/.exec(value);
  return matched ? `${matched[1]}.${matched[2]}` : value;
}

function shortDateLabel(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    month: "numeric",
    day: "numeric",
    timeZone: "Asia/Seoul",
  }).format(date);
}

function nativeMoney(value: unknown, currency: string): string {
  return currency === "KRW"
    ? formatKrw(decimal(value))
    : `${currency} ${formatDecimal(decimal(value), 2)}`;
}

function shareText(valueKrw: string, totalValueKrw: string): string {
  const total = numeric(totalValueKrw);
  if (total <= 0) return "등록 전";
  return `전체의 ${formatPercent(String(numeric(valueKrw) / total))}`;
}

function holdingKey(holding: HoldingItem): string {
  return `${holding.symbol}:${holding.marketCountry}:${holding.currency}`;
}

function buildGrowthData(
  payload: WholeAssetHistoryPayload,
  current: WholeAssetHistoryPoint,
  windowSize: number,
): GrowthDatum[] {
  const byMonth = new Map<string, WholeAssetHistoryPoint>();
  payload.points.forEach((point) => {
    const pointMonth = /^\d{4}-(?:0[1-9]|1[0-2])$/.test(point.month)
      ? point.month
      : monthKey(point.observedAt);
    if (!pointMonth) return;
    const existing = byMonth.get(pointMonth);
    if (!existing || point.observedAt.localeCompare(existing.observedAt) >= 0) {
      byMonth.set(pointMonth, { ...point, month: pointMonth });
    }
  });
  byMonth.set(current.month, current);
  return [...byMonth.values()]
    .sort((left, right) => left.month.localeCompare(right.month))
    .slice(-windowSize)
    .map((point) => ({
      month: point.month,
      axisLabel: monthLabel(point.month),
      tooltipLabel: monthLabel(point.month),
      observedAt: point.observedAt,
      portfolioValueKrw: point.portfolioValueKrw,
      externalValueKrw: point.externalValueKrw,
      portfolioValue: numeric(point.portfolioValueKrw),
      externalValue: numeric(point.externalValueKrw),
      includesExternal: true,
    }));
}

function buildPortfolioHistoryFallback(
  history: HistoryPayload,
  currentObservedAt: string,
  currentValueKrw: string,
  windowSize: number,
): GrowthDatum[] {
  const currentTimestamp = Date.parse(currentObservedAt);
  const cutoff = Number.isFinite(currentTimestamp)
    ? currentTimestamp - windowSize * 31 * 24 * 60 * 60 * 1_000
    : Number.NEGATIVE_INFINITY;
  const ordered = history.snapshots
    .filter((snapshot) => {
      const timestamp = Date.parse(snapshot.capturedAt);
      return Number.isFinite(timestamp) && timestamp >= cutoff && timestamp <= currentTimestamp;
    })
    .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt))
    .slice(-60)
    .map((snapshot) => ({
      month: monthKey(snapshot.capturedAt) ?? snapshot.capturedAt,
      axisLabel: shortDateLabel(snapshot.capturedAt),
      tooltipLabel: formatDate(snapshot.capturedAt, true),
      observedAt: snapshot.capturedAt,
      portfolioValueKrw: decimal(snapshot.totalTrackedValueKrw),
      externalValueKrw: "0",
      portfolioValue: numeric(snapshot.totalTrackedValueKrw),
      externalValue: 0,
      includesExternal: false,
    }));
  const latestTimestamp = Date.parse(ordered.at(-1)?.observedAt ?? "");
  if (
    Number.isFinite(currentTimestamp) &&
    (!Number.isFinite(latestTimestamp) || currentTimestamp > latestTimestamp)
  ) {
    ordered.push({
      month: monthKey(currentObservedAt) ?? currentObservedAt,
      axisLabel: shortDateLabel(currentObservedAt),
      tooltipLabel: `${formatDate(currentObservedAt, true)} · 현재 조회`,
      observedAt: currentObservedAt,
      portfolioValueKrw: currentValueKrw,
      externalValueKrw: "0",
      portfolioValue: numeric(currentValueKrw),
      externalValue: 0,
      includesExternal: false,
    });
  }
  return ordered;
}

function AssetTooltip({ active, payload }: TooltipContentProps<TooltipValueType, number | string>) {
  if (!active || !payload.length) return null;
  const datum = payload[0]?.payload as AssetDonutDatum | undefined;
  if (!datum) return null;
  return (
    <div className="dashboard-chart-tooltip">
      <strong>{datum.label}</strong>
      <span>{formatKrw(datum.valueKrw)}</span>
    </div>
  );
}

function GrowthTooltip({ active, payload }: TooltipContentProps<TooltipValueType, number | string>) {
  if (!active || !payload.length) return null;
  const datum = payload[0]?.payload as GrowthDatum | undefined;
  if (!datum) return null;
  return (
    <div className="dashboard-chart-tooltip">
      <strong>{datum.tooltipLabel}</strong>
      <span>토스 추적 자산 {formatKrw(datum.portfolioValueKrw)}</span>
      {datum.includesExternal ? <span>수동 등록 자산 {formatKrw(datum.externalValueKrw)}</span> : null}
    </div>
  );
}

function ChangeTooltip({ active, payload }: TooltipContentProps<TooltipValueType, number | string>) {
  if (!active || !payload.length) return null;
  const datum = payload[0]?.payload as ChangeDatum | undefined;
  if (!datum) return null;
  return (
    <div className="dashboard-chart-tooltip">
      <strong>{datum.label}</strong>
      <span>{signedKrw(datum.valueKrw)}</span>
    </div>
  );
}

function AssetGlyph({ assetKey }: { assetKey: string }) {
  const paths: Record<string, ReactNode> = {
    cash: <><rect x="4" y="7" width="16" height="11" rx="2" /><path d="M7 10h10M8 14h3" /></>,
    deposits: <><path d="M4 10h16M6 10v8M10 10v8M14 10v8M18 10v8M3 19h18M12 4l9 4H3l9-4Z" /></>,
    pensionInsurance: <><path d="M12 3 5 6v5c0 4.8 2.8 8 7 10 4.2-2 7-5.2 7-10V6l-7-3Z" /><path d="m9 12 2 2 4-5" /></>,
    equities: <><path d="M4 18V9M9 18V5M14 18v-7M19 18V3M3 18h18" /></>,
    other: <><circle cx="8" cy="8" r="3" /><circle cx="16" cy="8" r="3" /><circle cx="8" cy="16" r="3" /><circle cx="16" cy="16" r="3" /></>,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[assetKey]}</svg>;
}

function EmptyChart({ title, description }: { title: string; description: string }) {
  return (
    <div className="dashboard-empty-chart" role="note">
      <svg viewBox="0 0 240 96" aria-hidden="true">
        <path d="M10 78h220M10 50h220M10 22h220" />
        <path d="m15 70 43-8 41 3 42-23 38 8 46-28" />
      </svg>
      <strong>{title}</strong>
      <p>{description}</p>
    </div>
  );
}

function MiniSparkline({
  points,
  name,
  currency,
}: {
  points: HoldingHistoryPayload["points"];
  name: string;
  currency: string;
}) {
  const ordered = [...points]
    .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt))
    .slice(-24);
  if (ordered.length < 2) return <span className="dashboard-sparkline-empty">기록 부족</span>;
  const values = ordered.map((point) => numeric(point.lastPrice));
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const range = maximum - minimum || 1;
  const polyline = values.map((value, index) => {
    const x = (index / Math.max(1, values.length - 1)) * 86 + 3;
    const y = 29 - ((value - minimum) / range) * 24;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const firstValue = values[0];
  const lastValue = values.at(-1)!;
  const direction = lastValue >= firstValue ? "up" : "down";
  const directionLabel = lastValue > firstValue
    ? "상승"
    : lastValue < firstValue
      ? "하락"
      : "변동 없음";
  const firstPoint = ordered[0];
  const lastPoint = ordered.at(-1)!;
  const accessibleSummary = `${name} 저장 가격 추이. ${formatDate(firstPoint.capturedAt)}부터 ${formatDate(lastPoint.capturedAt)}까지 ${directionLabel}, ${nativeMoney(firstPoint.lastPrice, currency)}에서 ${nativeMoney(lastPoint.lastPrice, currency)}.`;
  return (
    <svg
      className={`dashboard-sparkline ${direction}`}
      viewBox="0 0 92 34"
      role="img"
      aria-label={accessibleSummary}
    >
      <polyline points={polyline} />
    </svg>
  );
}

function ReturnMeter({ rate }: { rate: unknown }) {
  const parsed = Math.max(-0.5, Math.min(0.5, numeric(rate)));
  const width = Math.max(3, Math.abs(parsed) / 0.5 * 50);
  return (
    <span className={`dashboard-return-meter ${parsed >= 0 ? "up" : "down"}`} aria-hidden="true">
      <span style={{ width: `${width}%` }} />
    </span>
  );
}

function DataBoundary({ data }: { data: DashboardWorkspaceData }) {
  const externalUnavailable = data.externalAssets.status === "unavailable";
  const truncated = data.externalAssets.count > data.externalAssets.assets.length;
  const historyReady = data.wholeAssetHistory.points.length >= 2;
  return (
    <div className="dashboard-boundary" role="note">
      <div>
        <span className={externalUnavailable ? "warning" : "ready"} aria-hidden="true" />
        <p><strong>현재 자산 범위</strong>{externalUnavailable ? "수동 자산 원장 확인 필요" : "증권 계좌와 수동 등록 자산 합산"}</p>
      </div>
      <div>
        <span className={historyReady ? "ready" : "warning"} aria-hidden="true" />
        <p><strong>월별 기록</strong>{historyReady ? `${data.wholeAssetHistory.points.length}개 월 관측값` : "비교 가능한 월 기록 부족"}</p>
      </div>
      <div>
        <span className={data.analytics.status === "ready" ? "ready" : "warning"} aria-hidden="true" />
        <p><strong>성과 계산</strong>{data.analytics.status === "ready" ? "증권 계좌 현금흐름 조정" : "저장 기록 또는 입출금 확인 필요"}</p>
      </div>
      {truncated ? <p className="dashboard-boundary-warning">자산군 합계의 일부는 목록 밖 금액이라 ‘기타 · 분류 미조회’로 표시합니다.</p> : null}
    </div>
  );
}

export function DashboardWorkspace({
  data,
  period,
  onPeriodChange,
  onNavigate,
}: DashboardWorkspaceProps) {
  const { portfolio, externalAssets, wholeAssetHistory, analytics } = data;
  const [growthWindow, setGrowthWindow] = useState<(typeof GROWTH_WINDOWS)[number]>(12);
  const [holdingHistory, setHoldingHistory] = useState<Record<string, HoldingHistoryPayload>>({});

  const breakdown = useMemo(() => buildDashboardAssetBreakdown({
    portfolio: {
      equityValueKrw: decimal(portfolio.summary.equityValueKrw),
      buyingPowerKrw: decimal(portfolio.summary.buyingPowerKrw),
      buyingPowerUsd: decimal(portfolio.summary.buyingPowerUsd),
      usdKrwRate: decimal(portfolio.summary.usdKrwRate),
    },
    externalAssets: externalAssets.assets.map((asset) => ({
      kind: asset.kind,
      valueKrw: asset.valueKrw,
    })),
    externalTotalValueKrw: externalAssets.totalValueKrw,
  }), [externalAssets.assets, externalAssets.totalValueKrw, portfolio.summary]);

  const assetData = useMemo<AssetDonutDatum[]>(() => breakdown.buckets
    .filter((bucket) => compareDecimal(bucket.valueKrw, "0") > 0)
    .map((bucket) => ({
      key: bucket.key,
      label: ASSET_LABELS[bucket.key].label,
      valueKrw: bucket.valueKrw,
      value: numeric(bucket.valueKrw),
      color: ASSET_LABELS[bucket.key].color,
    })), [breakdown.buckets]);

  const topBuckets = breakdown.buckets.filter((bucket) => bucket.key !== "other" || compareDecimal(bucket.valueKrw, "0") > 0);
  const currentMonth = monthKey(portfolio.asOf) ?? new Date().toISOString().slice(0, 7);
  const currentGrowthPoint: WholeAssetHistoryPoint = {
    month: currentMonth,
    observedAt: portfolio.asOf,
    portfolioValueKrw: exactSum(
      breakdown.brokerageCashKrw,
      decimal(portfolio.summary.equityValueKrw),
    ),
    externalValueKrw: breakdown.externalValueKrw,
    totalRegisteredValueKrw: breakdown.totalValueKrw,
    externalAssetCount: externalAssets.count,
    portfolioCarriedForward: false,
  };
  const growthData = buildGrowthData(wholeAssetHistory, currentGrowthPoint, growthWindow);
  const portfolioGrowthFallback = buildPortfolioHistoryFallback(
    data.history,
    portfolio.asOf,
    currentGrowthPoint.portfolioValueKrw,
    growthWindow,
  );
  const hasMonthlyGrowth = canShowWholeAssetGrowth({
    wholeAssetHistoryStatus: wholeAssetHistory.status,
    externalAssetsStatus: externalAssets.status,
    pointCount: growthData.length,
  });
  const visibleGrowthData = hasMonthlyGrowth ? growthData : portfolioGrowthFallback;
  const growthFallbackScope = externalAssets.status === "unavailable"
    ? "수동 자산 현재값을 확인할 수 없어 저장된 증권 계좌 평가액만 표시합니다."
    : wholeAssetHistory.status === "unavailable"
      ? "월별 전체 자산 기록을 불러오지 못해 저장된 증권 계좌 평가액만 표시합니다."
      : "월별 전체 자산 기록이 부족해 저장된 증권 계좌 평가액만 표시합니다.";

  const marketData = portfolio.allocation
    .filter((item) => item.key !== "CASH" && numeric(item.valueKrw) > 0)
    .map((item, index) => ({
      key: item.key,
      label: item.label,
      valueKrw: decimal(item.valueKrw),
      value: numeric(item.valueKrw),
      color: index % 2 === 0 ? "var(--chart-equity)" : "var(--chart-market-alt)",
    }));

  const cashAssets = externalAssets.assets.filter((asset) => asset.kind === "cash");
  const deposits = externalAssets.assets
    .filter((asset) => asset.kind === "deposit" || asset.kind === "savings")
    .sort((left, right) => (left.maturityDate ?? "9999").localeCompare(right.maturityDate ?? "9999"));
  const topHoldings = useMemo(() => [...portfolio.holdings]
    .sort((left, right) => numeric(right.marketValueKrw) - numeric(left.marketValueKrw))
    .slice(0, 8), [portfolio.holdings]);

  useEffect(() => {
    if (portfolio.mode === "demo" || topHoldings.length === 0) {
      return;
    }
    let cancelled = false;
    const load = async () => {
      const results = await Promise.allSettled(topHoldings.map(async (holding) => {
        const search = new URLSearchParams({
          symbol: holding.symbol,
          marketCountry: holding.marketCountry,
          currency: holding.currency,
          limit: "90",
        });
        const response = await fetch(`/api/holding-history?${search.toString()}`, {
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
        if (!response.ok) throw new Error("holding-history-unavailable");
        return [holdingKey(holding), await response.json() as HoldingHistoryPayload] as const;
      }));
      if (cancelled) return;
      setHoldingHistory(Object.fromEntries(
        results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []),
      ));
    };
    void load();
    return () => { cancelled = true; };
  }, [portfolio.mode, topHoldings]);

  const changeData: ChangeDatum[] = analytics.metrics ? [
    {
      key: "contributions",
      label: "기록 입금",
      valueKrw: analytics.metrics.contributionsKrw,
      value: numeric(analytics.metrics.contributionsKrw),
      fill: "var(--chart-positive)",
    },
    {
      key: "withdrawals",
      label: "기록 출금",
      valueKrw: compareDecimal(analytics.metrics.withdrawalsKrw, "0") > 0
        ? `-${analytics.metrics.withdrawalsKrw}`
        : "0",
      value: -numeric(analytics.metrics.withdrawalsKrw),
      fill: "var(--chart-negative)",
    },
    {
      key: "adjusted",
      label: "현금흐름 조정 변화",
      valueKrw: analytics.metrics.adjustedGainKrw,
      value: numeric(analytics.metrics.adjustedGainKrw),
      fill: numeric(analytics.metrics.adjustedGainKrw) >= 0 ? "var(--chart-equity)" : "var(--chart-negative)",
    },
  ] : [];

  return (
    <div className="asset-dashboard">
      <section className="dashboard-hero" aria-labelledby="dashboard-title">
        <div className="dashboard-hero-copy">
          <span className="dashboard-eyebrow">토스증권 OPEN API · READ ONLY</span>
          <h1 id="dashboard-title" tabIndex={-1}><span>LedgerLens</span> 자산 포트폴리오</h1>
          <p>{portfolio.account.maskedNumber} · {formatAsOf(portfolio.asOf)} 기준</p>
        </div>
        <div className="dashboard-total">
          <span>{externalAssets.status === "unavailable" ? "현재 확인된 추적 자산" : "내 자산 한눈에 보기"}</span>
          <strong>{formatKrw(breakdown.totalValueKrw)}</strong>
          <small>투자 성과가 아닌 현재 등록 평가액 합계</small>
        </div>
      </section>

      <section className="dashboard-kpis" aria-label="자산군 요약">
        {topBuckets.map((bucket) => {
          const meta = ASSET_LABELS[bucket.key];
          return (
            <article className={`dashboard-kpi dashboard-kpi-${bucket.key}`} key={bucket.key}>
              <div className="dashboard-kpi-icon"><AssetGlyph assetKey={bucket.key} /></div>
              <div>
                <span>{meta.short}</span>
                <strong>{formatCompactKrw(bucket.valueKrw)}</strong>
                <small>{shareText(bucket.valueKrw, breakdown.totalValueKrw)}</small>
              </div>
            </article>
          );
        })}
      </section>

      <section className="dashboard-grid dashboard-grid-overview">
        <article className="dashboard-panel dashboard-allocation" aria-labelledby="asset-allocation-title">
          <div className="dashboard-panel-heading">
            <div><span>ALLOCATION</span><h2 id="asset-allocation-title">자산 구성</h2></div>
            <button type="button" onClick={() => onNavigate("portfolio")}>상세 보기</button>
          </div>
          {assetData.length ? (
            <div className="dashboard-donut-layout">
              <div className="dashboard-donut" aria-hidden="true">
                <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                  <PieChart>
                    <Pie data={assetData} dataKey="value" nameKey="label" innerRadius="64%" outerRadius="91%" paddingAngle={2} stroke="none">
                      {assetData.map((item) => <Cell key={item.key} fill={item.color} />)}
                    </Pie>
                    <Tooltip content={AssetTooltip} />
                  </PieChart>
                </ResponsiveContainer>
                <div><span>총 자산</span><strong>{formatCompactKrw(breakdown.totalValueKrw)}</strong></div>
              </div>
              <dl className="dashboard-legend">
                {assetData.map((item) => (
                  <div key={item.key}>
                    <dt><span style={{ background: item.color }} />{ASSET_LABELS[item.key].short}</dt>
                    <dd>{formatCompactKrw(item.valueKrw)}<small>{shareText(item.valueKrw, breakdown.totalValueKrw).replace("전체의 ", "")}</small></dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : <EmptyChart title="표시할 자산이 없습니다" description="증권 계좌를 연결하거나 수동 자산을 등록하면 구성이 나타납니다." />}
        </article>

        <article className="dashboard-panel dashboard-growth" aria-labelledby="asset-growth-title">
          <div className="dashboard-panel-heading">
            <div><span>{hasMonthlyGrowth ? "MONTHLY HISTORY" : "SAVED HISTORY"}</span><h2 id="asset-growth-title">{hasMonthlyGrowth ? "월별 자산 성장 추이" : "최근 증권 자산 변화"}</h2></div>
            <div className="dashboard-segments" role="group" aria-label="월별 자산 표시 기간">
              {GROWTH_WINDOWS.map((windowSize) => (
                <button key={windowSize} type="button" aria-pressed={growthWindow === windowSize} onClick={() => setGrowthWindow(windowSize)}>
                  {windowSize === 6 ? "6M" : windowSize === 12 ? "1Y" : "ALL"}
                </button>
              ))}
            </div>
          </div>
          {visibleGrowthData.length >= 2 ? (
            <>
              <div className="dashboard-growth-chart" aria-hidden="true">
                <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                  <AreaChart data={visibleGrowthData} margin={{ top: 18, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeDasharray="2 7" />
                    <XAxis dataKey="axisLabel" tick={{ fill: "var(--quiet)", fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={28} />
                    <YAxis tickFormatter={formatCompactKrw} tick={{ fill: "var(--quiet)", fontSize: 11 }} tickLine={false} axisLine={false} width={68} />
                    <Tooltip content={GrowthTooltip} cursor={{ stroke: "var(--chart-cursor)", strokeDasharray: "3 4" }} />
                    <Area type="linear" dataKey="portfolioValue" name="토스 추적 자산" stackId="assets" fill="var(--chart-equity-soft)" stroke="var(--chart-equity)" strokeWidth={2} />
                    {hasMonthlyGrowth ? <Area type="linear" dataKey="externalValue" name="수동 등록 자산" stackId="assets" fill="var(--chart-deposit-soft)" stroke="var(--chart-deposit)" strokeWidth={1.5} /> : null}
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              <table className="sr-only">
                <caption>{hasMonthlyGrowth ? "월별 등록 자산 추이" : "저장 시점별 증권 자산 변화"}</caption>
                <thead>
                  <tr><th>시점</th><th>토스 추적 자산</th>{hasMonthlyGrowth ? <th>수동 등록 자산</th> : null}</tr>
                </thead>
                <tbody>
                  {visibleGrowthData.map((point) => (
                    <tr key={`${point.observedAt}:${point.month}`}>
                      <td>{point.tooltipLabel}</td>
                      <td>{formatKrw(point.portfolioValueKrw)}</td>
                      {hasMonthlyGrowth ? <td>{formatKrw(point.externalValueKrw)}</td> : null}
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="dashboard-chart-legend"><span><i className="equity" />토스 추적 자산</span>{hasMonthlyGrowth ? <span><i className="external" />수동 등록 자산</span> : <span>월별 전체 자산 기록 전 · 저장 시점 기준</span>}</div>
            </>
          ) : <EmptyChart title="비교할 저장 기록이 더 필요합니다" description={growthFallbackScope} />}
          <p className="dashboard-scope-note">{hasMonthlyGrowth ? "등록 평가액 추이이며 투자 수익률이 아닙니다." : growthFallbackScope} 수동 자산은 성과 계산에서 제외됩니다.</p>
        </article>
      </section>

      <section className="dashboard-grid dashboard-grid-ledgers">
        <article className="dashboard-panel" aria-labelledby="cash-title">
          <div className="dashboard-panel-heading"><div><span>CASH POSITION</span><h2 id="cash-title">현금 보유 현황</h2></div><button type="button" onClick={() => onNavigate("data")}>관리</button></div>
          <div className="dashboard-table-wrap">
            <table className="dashboard-table">
              <thead><tr><th>구분</th><th>기관</th><th>기준일</th><th className="numeric-cell">평가액</th></tr></thead>
              <tbody>
                <tr><td><strong>증권 주문 가능 금액</strong><small>결제 완료 현금 잔액과 다를 수 있음</small></td><td>토스증권</td><td>{formatDate(portfolio.asOf)}</td><td className="numeric-cell">{formatKrw(breakdown.brokerageCashKrw)}</td></tr>
                {cashAssets.map((asset) => <tr key={asset.id}><td><strong>{asset.name}</strong><small>수동 등록</small></td><td>{asset.institution || "—"}</td><td>{formatDate(asset.valuedAt)}</td><td className="numeric-cell">{formatKrw(asset.valueKrw)}</td></tr>)}
              </tbody>
            </table>
          </div>
          {!cashAssets.length ? <p className="dashboard-table-note">수동 등록 현금은 없습니다. 증권 주문 가능 금액만 별도로 표시합니다.</p> : null}
        </article>

        <article className="dashboard-panel" aria-labelledby="deposit-title">
          <div className="dashboard-panel-heading"><div><span>MATURITY CALENDAR</span><h2 id="deposit-title">예적금 보유 현황</h2></div><button type="button" onClick={() => onNavigate("data")}>등록</button></div>
          {deposits.length ? (
            <div className="dashboard-table-wrap">
              <table className="dashboard-table">
                <thead><tr><th>상품</th><th>기관</th><th>만기</th><th>금리</th><th className="numeric-cell">평가액</th></tr></thead>
                <tbody>{deposits.map((asset) => <tr key={asset.id}><td><strong>{asset.name}</strong><small>{asset.kind === "deposit" ? "예금" : "적금"}</small></td><td>{asset.institution || "—"}</td><td>{asset.maturityDate ? formatDate(asset.maturityDate) : "미등록"}</td><td>{asset.annualRatePercent ? `${formatDecimal(asset.annualRatePercent, 2)}%` : "—"}</td><td className="numeric-cell">{formatKrw(asset.valueKrw)}</td></tr>)}</tbody>
              </table>
            </div>
          ) : <EmptyChart title="등록된 예적금이 없습니다" description="데이터 화면에서 잔액, 금리, 만기일을 입력하면 만기 순서로 정리합니다." />}
        </article>
      </section>

      <section className="dashboard-grid dashboard-grid-analysis">
        <article className="dashboard-panel dashboard-market" aria-labelledby="market-title">
          <div className="dashboard-panel-heading"><div><span>STOCK MIX</span><h2 id="market-title">시장별 주식 포트폴리오</h2></div><span className="dashboard-status-chip">섹터 분류 준비 중</span></div>
          {marketData.length ? (
            <div className="dashboard-donut-layout compact">
              <div className="dashboard-donut small" aria-hidden="true">
                <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                  <PieChart><Pie data={marketData} dataKey="value" nameKey="label" innerRadius="62%" outerRadius="91%" paddingAngle={3} stroke="none">{marketData.map((item) => <Cell key={item.key} fill={item.color} />)}</Pie><Tooltip content={AssetTooltip} /></PieChart>
                </ResponsiveContainer>
                <div><span>주식</span><strong>{formatCompactKrw(decimal(portfolio.summary.equityValueKrw))}</strong></div>
              </div>
              <dl className="dashboard-legend">{marketData.map((item) => <div key={item.key}><dt><span style={{ background: item.color }} />{item.label}</dt><dd>{formatCompactKrw(item.valueKrw)}<small>{shareText(item.valueKrw, decimal(portfolio.summary.equityValueKrw)).replace("전체의 ", "")}</small></dd></div>)}</dl>
            </div>
          ) : <EmptyChart title="보유 주식이 없습니다" description="연결된 계좌의 국내·미국 주식 평가액을 시장별로 표시합니다." />}
          <p className="dashboard-scope-note">종목 응답에 섹터 메타데이터가 없어 현재는 국내·미국 시장 기준으로 표시합니다.</p>
        </article>

        <article className="dashboard-panel dashboard-change" aria-labelledby="change-title">
          <div className="dashboard-panel-heading">
            <div><span>PERIOD CHANGE</span><h2 id="change-title">증권 계좌 기간 변화</h2></div>
            <div className="dashboard-segments" role="group" aria-label="성과 분석 기간">{PERIOD_OPTIONS.map((option) => <button key={String(option.value)} type="button" aria-pressed={period === option.value} onClick={() => onPeriodChange(option.value)}>{option.label}</button>)}</div>
          </div>
          {analytics.metrics && changeData.length ? (
            <>
              <div className="dashboard-change-summary">
                <div><span>시작</span><strong>{formatCompactKrw(analytics.metrics.startTrackedValueKrw)}</strong></div>
                <div><span>종료</span><strong>{formatCompactKrw(analytics.metrics.endTrackedValueKrw)}</strong></div>
                <div><span>조정 변화</span><strong className={signedClass(analytics.metrics.adjustedGainKrw)}>{signedKrw(analytics.metrics.adjustedGainKrw)}</strong></div>
              </div>
              <div className="dashboard-change-chart" aria-hidden="true">
                <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                  <BarChart data={changeData} margin={{ top: 16, right: 6, bottom: 0, left: 0 }}>
                    <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeDasharray="2 7" />
                    <XAxis dataKey="label" tick={{ fill: "var(--quiet)", fontSize: 11 }} tickLine={false} axisLine={false} />
                    <YAxis tickFormatter={formatCompactKrw} tick={{ fill: "var(--quiet)", fontSize: 11 }} tickLine={false} axisLine={false} width={68} />
                    <Tooltip content={ChangeTooltip} cursor={{ fill: "var(--surface-muted)" }} />
                    <Bar dataKey="value" radius={[5, 5, 0, 0]}>{changeData.map((item) => <Cell key={item.key} fill={item.fill} />)}</Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <table className="sr-only">
                <caption>증권 계좌 기간 변화 구성</caption>
                <thead><tr><th>항목</th><th>금액</th></tr></thead>
                <tbody>{changeData.map((item) => <tr key={item.key}><td>{item.label}</td><td>{signedKrw(item.valueKrw)}</td></tr>)}</tbody>
              </table>
            </>
          ) : <EmptyChart title="성과 기록이 더 필요합니다" description="서로 다른 시점의 증권 스냅샷과 입출금 확인이 갖춰지면 조정 변화를 표시합니다." />}
          <p className="dashboard-scope-note">실현손익이 아니라 저장된 증권 평가액과 기록한 외부 입출금으로 계산한 변화입니다.</p>
        </article>
      </section>

      <section className="dashboard-panel dashboard-holdings" aria-labelledby="holdings-title">
        <div className="dashboard-panel-heading"><div><span>HOLDINGS DETAIL</span><h2 id="holdings-title">보유 종목 상세</h2></div><button type="button" onClick={() => onNavigate("portfolio")}>전체 포트폴리오</button></div>
        {topHoldings.length ? (
          <div className="dashboard-table-wrap">
            <table className="dashboard-table dashboard-holdings-table">
              <thead><tr><th>종목</th><th>시장</th><th className="numeric-cell">수량</th><th className="numeric-cell">평균 매입가</th><th className="numeric-cell">현재가</th><th className="numeric-cell">평가액</th><th>누적 수익률</th><th>오늘</th><th>저장 가격 추이</th></tr></thead>
              <tbody>{topHoldings.map((holding) => {
                const history = holdingHistory[holdingKey(holding)];
                return <tr key={holdingKey(holding)}>
                  <td><strong>{holding.name}</strong><small>{holding.symbol}</small></td>
                  <td>{holding.marketCountry}</td>
                  <td className="numeric-cell">{formatDecimal(holding.quantity, 4)}</td>
                  <td className="numeric-cell">{nativeMoney(holding.averagePurchasePrice, holding.currency)}</td>
                  <td className="numeric-cell">{nativeMoney(holding.lastPrice, holding.currency)}</td>
                  <td className="numeric-cell"><strong>{formatKrw(holding.marketValueKrw)}</strong></td>
                  <td><div className={`dashboard-return ${signedClass(holding.profitLossRate)}`}><span>{formatPercent(holding.profitLossRate)}</span><ReturnMeter rate={holding.profitLossRate} /></div></td>
                  <td className={signedClass(holding.dailyProfitLossRate)}>{formatPercent(holding.dailyProfitLossRate)}</td>
                  <td><MiniSparkline points={history?.points ?? []} name={holding.name} currency={holding.currency} /></td>
                </tr>;
              })}</tbody>
            </table>
          </div>
        ) : <EmptyChart title="보유 종목이 없습니다" description="토스증권 계좌가 연결되면 종목별 평가액과 수익률을 자동으로 표시합니다." />}
        <p className="dashboard-scope-note">수익률 막대는 현재 평균 매입가 대비 누적 수익률입니다. 선은 저장된 스냅샷의 가격 기록이 2개 이상일 때만 표시합니다.</p>
      </section>

      <DataBoundary data={data} />
    </div>
  );
}
