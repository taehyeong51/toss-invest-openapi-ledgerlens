"use client";

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
  type TooltipValueType,
} from "recharts";
import { formatCompactKrw, formatDate, formatKrw, numeric } from "../lib/format";

export type WholeAssetHistoryStatus =
  | "loading"
  | "demo"
  | "unavailable"
  | "insufficient-history"
  | "ready";

export interface WholeAssetHistoryPoint {
  month: string;
  observedAt: string;
  portfolioValueKrw: string;
  externalValueKrw: string;
  totalRegisteredValueKrw: string;
  externalAssetCount?: number;
  portfolioCarriedForward?: boolean;
}

export interface WholeAssetHistoryPayload {
  status: WholeAssetHistoryStatus;
  points: WholeAssetHistoryPoint[];
  count?: number;
  warnings?: string[];
}

export interface WholeAssetCurrentPoint {
  month?: string;
  observedAt: string;
  portfolioValueKrw: string;
  externalValueKrw: string;
  totalRegisteredValueKrw: string;
  externalAssetCount?: number;
}

interface WholeAssetTrendChartProps {
  payload: WholeAssetHistoryPayload;
  currentPoint?: WholeAssetCurrentPoint | null;
}

interface ChartPoint extends WholeAssetHistoryPoint {
  portfolioValue: number;
  externalValue: number;
  totalRegisteredValue: number;
  isCurrent: boolean;
}

function kstMonth(value: string): string | null {
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

function validMonth(value: string | undefined): value is string {
  return Boolean(value && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(value));
}

function monthLabel(value: string): string {
  const matched = value.match(/^(\d{4})-(\d{2})$/);
  if (!matched) return value;
  return `${matched[1]}년 ${Number(matched[2])}월`;
}

function mergedPoints(
  history: WholeAssetHistoryPoint[],
  currentPoint: WholeAssetCurrentPoint | null | undefined,
): ChartPoint[] {
  const byMonth = new Map<string, WholeAssetHistoryPoint & { isCurrent: boolean }>();

  history.forEach((point) => {
    const month = validMonth(point.month) ? point.month : kstMonth(point.observedAt);
    if (!month) return;
    const existing = byMonth.get(month);
    if (!existing || point.observedAt.localeCompare(existing.observedAt) >= 0) {
      byMonth.set(month, { ...point, month, isCurrent: false });
    }
  });

  if (currentPoint) {
    const month = validMonth(currentPoint.month)
      ? currentPoint.month
      : kstMonth(currentPoint.observedAt);
    if (month) {
      byMonth.set(month, {
        ...currentPoint,
        month,
        portfolioCarriedForward: false,
        isCurrent: true,
      });
    }
  }

  return [...byMonth.values()]
    .sort((left, right) => left.month.localeCompare(right.month))
    .map((point) => ({
      ...point,
      portfolioValue: numeric(point.portfolioValueKrw),
      externalValue: numeric(point.externalValueKrw),
      totalRegisteredValue: numeric(point.totalRegisteredValueKrw),
    }));
}

function WholeAssetTooltip({ active, payload }: TooltipContentProps<TooltipValueType, number | string>) {
  if (!active || !payload.length) return null;
  const point = payload[0]?.payload as ChartPoint | undefined;
  if (!point) return null;

  return (
    <div className="whole-asset-tooltip">
      <strong>{monthLabel(point.month)}{point.isCurrent ? " · 현재 조회" : ""}</strong>
      <dl>
        <div><dt>등록 자산 합계</dt><dd>{formatKrw(point.totalRegisteredValueKrw)}</dd></div>
        <div><dt>증권 계좌</dt><dd>{formatKrw(point.portfolioValueKrw)}</dd></div>
        <div><dt>수동 등록</dt><dd>{formatKrw(point.externalValueKrw)}</dd></div>
      </dl>
      {point.portfolioCarriedForward ? <p>증권 계좌는 직전 관측값을 이어서 표시했습니다.</p> : null}
    </div>
  );
}

function TrendState({ status }: { status: WholeAssetHistoryStatus }) {
  const copy = status === "loading"
    ? {
        title: "월별 기록을 불러오는 중입니다",
        description: "증권 계좌 스냅샷과 수동 자산 평가 이력을 합치고 있습니다.",
        role: "status" as const,
      }
    : status === "demo"
      ? {
          title: "데모에서는 실제 월별 기록을 만들지 않습니다",
          description: "라이브 저장소를 연결하고 서로 다른 달의 기록이 쌓이면 등록 자산 추이를 확인할 수 있습니다.",
          role: "note" as const,
        }
      : status === "unavailable"
        ? {
            title: "월별 자산 기록을 불러오지 못했습니다",
            description: "현재 합계는 볼 수 있지만, 과거 흐름은 저장소 연결을 확인한 뒤 다시 불러와야 합니다.",
            role: "alert" as const,
          }
        : {
            title: "비교할 월별 기록이 더 필요합니다",
            description: "서로 다른 달의 관측값이 2개 이상 쌓이면 증권 계좌와 수동 등록 자산의 흐름을 함께 표시합니다.",
            role: "note" as const,
          };

  return (
    <div className={`whole-asset-state ${status}`} role={copy.role}>
      <svg viewBox="0 0 320 112" aria-hidden="true">
        <path d="M16 88h288M16 56h288M16 24h288" />
        <path d="M22 78l58-8 52 3 62-24 48 7 58-30" />
      </svg>
      <div><strong>{copy.title}</strong><p>{copy.description}</p></div>
    </div>
  );
}

export function WholeAssetTrendChart({ payload, currentPoint = null }: WholeAssetTrendChartProps) {
  const points = mergedPoints(payload.points, currentPoint);
  const current = points.find((point) => point.isCurrent) ?? null;
  const blockedStatus = payload.status === "loading" || payload.status === "demo" || payload.status === "unavailable";
  const visibleStatus: WholeAssetHistoryStatus = blockedStatus
    ? payload.status
    : points.length < 2
      ? "insufficient-history"
      : "ready";

  return (
    <section className="whole-asset-trend" aria-labelledby="whole-asset-trend-title">
      <div className="whole-asset-trend-heading">
        <div>
          <h2 id="whole-asset-trend-title">월별 등록 자산 추이</h2>
          <p>증권 계좌 스냅샷과 해당 월까지 직접 확인한 수동 자산 평가액을 한 흐름으로 봅니다.</p>
        </div>
        <span className="whole-asset-trend-scope">성과 계산 제외</span>
      </div>

      {visibleStatus !== "ready" ? (
        <TrendState status={visibleStatus} />
      ) : (
        <>
          <div className="whole-asset-chart" aria-hidden="true">
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <ComposedChart data={points} margin={{ top: 18, right: 12, bottom: 6, left: 8 }}>
                <CartesianGrid stroke="var(--line)" strokeDasharray="2 6" vertical={false} />
                <XAxis
                  dataKey="month"
                  tickFormatter={(value) => monthLabel(String(value)).replace(/^\d{4}년\s/, "")}
                  tick={{ fill: "var(--quiet)", fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={28}
                />
                <YAxis
                  domain={["auto", "auto"]}
                  tickFormatter={(value) => formatCompactKrw(value)}
                  tick={{ fill: "var(--quiet)", fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  width={70}
                />
                <Tooltip
                  cursor={{ stroke: "var(--muted)", strokeDasharray: "3 4" }}
                  content={WholeAssetTooltip}
                />
                <Area
                  type="linear"
                  dataKey="totalRegisteredValue"
                  fill="var(--accent-soft)"
                  stroke="var(--accent)"
                  strokeWidth={2.5}
                  dot={false}
                  activeDot={{ r: 4, fill: "var(--accent)", stroke: "var(--surface)", strokeWidth: 2 }}
                  isAnimationActive={false}
                />
                <Line
                  type="linear"
                  dataKey="portfolioValue"
                  stroke="var(--muted)"
                  strokeWidth={1.5}
                  strokeDasharray="6 5"
                  dot={false}
                  activeDot={false}
                  isAnimationActive={false}
                />
                <Line
                  type="linear"
                  dataKey="externalValue"
                  stroke="var(--warning)"
                  strokeWidth={1.5}
                  strokeDasharray="2 5"
                  dot={false}
                  activeDot={false}
                  isAnimationActive={false}
                />
                {current ? (
                  <ReferenceDot
                    x={current.month}
                    y={current.totalRegisteredValue}
                    r={5}
                    fill="var(--surface)"
                    stroke="var(--accent)"
                    strokeWidth={2.5}
                  />
                ) : null}
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          <div className="whole-asset-chart-legend" aria-hidden="true">
            <span><i className="total" />등록 자산 합계</span>
            <span><i className="portfolio" />증권 계좌</span>
            <span><i className="external" />수동 등록</span>
          </div>

          <table className="sr-only">
            <caption>월별 등록 자산 합계, 증권 계좌 평가액, 수동 등록 자산 평가액</caption>
            <thead><tr><th>월</th><th>등록 자산 합계</th><th>증권 계좌</th><th>수동 등록</th><th>관측 상태</th></tr></thead>
            <tbody>
              {points.map((point) => (
                <tr key={point.month}>
                  <td>{monthLabel(point.month)}</td>
                  <td>{formatKrw(point.totalRegisteredValueKrw)}</td>
                  <td>{formatKrw(point.portfolioValueKrw)}</td>
                  <td>{formatKrw(point.externalValueKrw)}</td>
                  <td>{point.isCurrent ? "현재 조회" : point.portfolioCarriedForward ? "증권 계좌 직전값 사용" : formatDate(point.observedAt, true)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <p className="whole-asset-trend-disclosure" role="note">
        이 그래프의 증감에는 자산을 새로 등록하거나 평가 기준을 갱신한 영향이 섞입니다. 투자 수익률이나 순자산 성과로 해석하지 마세요.
      </p>
      {payload.warnings?.length ? (
        <ul className="whole-asset-trend-warnings">
          {payload.warnings.map((warning) => <li key={warning}>{warning}</li>)}
        </ul>
      ) : null}
    </section>
  );
}
