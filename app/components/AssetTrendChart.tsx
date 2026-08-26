"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatCompactKrw, formatDate, formatKrw, numeric } from "../lib/format";
import type { CashFlowEntry, HistorySnapshot } from "../lib/ui-types";

interface AssetTrendChartProps {
  snapshots: HistorySnapshot[];
  cashFlows?: CashFlowEntry[];
  targetAssetKrw?: string | null;
  planLine?: {
    startAssetKrw: string;
    targetAssetKrw: string;
    startDate: string;
    targetDate: string;
  } | null;
  compact?: boolean;
}

interface ChartPoint {
  id: string;
  timestamp: number;
  capturedAt: string;
  value: number;
  exactValue: string;
  isLive: boolean;
  planValue: number | null;
}

function planValueAt(
  timestamp: number,
  planLine: NonNullable<AssetTrendChartProps["planLine"]>,
): number | null {
  const startedAt = Date.parse(`${planLine.startDate}T00:00:00+09:00`);
  const targetAt = Date.parse(`${planLine.targetDate}T00:00:00+09:00`);
  if (!Number.isFinite(startedAt) || !Number.isFinite(targetAt) || targetAt <= startedAt) return null;
  const progress = Math.max(0, Math.min(1, (timestamp - startedAt) / (targetAt - startedAt)));
  return numeric(planLine.startAssetKrw) +
    (numeric(planLine.targetAssetKrw) - numeric(planLine.startAssetKrw)) * progress;
}

function interpolatedPoint(points: ChartPoint[], occurredAt: string): ChartPoint | null {
  const target = Date.parse(occurredAt);
  if (
    !Number.isFinite(target) ||
    points.length === 0 ||
    target < points[0].timestamp ||
    target > points[points.length - 1].timestamp
  ) return null;
  const rightIndex = points.findIndex((point) => point.timestamp >= target);
  const right = points[Math.max(0, rightIndex)];
  const left = points[Math.max(0, rightIndex - 1)];
  if (!left || !right || left.timestamp === right.timestamp) return right ?? left ?? null;
  const progress = (target - left.timestamp) / (right.timestamp - left.timestamp);
  const value = left.value + (right.value - left.value) * progress;
  return {
    id: `flow-${occurredAt}`,
    timestamp: target,
    capturedAt: occurredAt,
    value,
    exactValue: String(value),
    isLive: false,
    planValue: null,
  };
}

export function AssetTrendChart({
  snapshots,
  cashFlows = [],
  targetAssetKrw = null,
  planLine = null,
  compact = false,
}: AssetTrendChartProps) {
  const points = snapshots
    .map((snapshot) => ({
      id: String(snapshot.id),
      timestamp: Date.parse(snapshot.capturedAt),
      capturedAt: snapshot.capturedAt,
      value: numeric(snapshot.totalTrackedValueKrw),
      exactValue: String(snapshot.totalTrackedValueKrw ?? "0"),
      isLive: String(snapshot.id) === "live-current",
      planValue: planLine ? planValueAt(Date.parse(snapshot.capturedAt), planLine) : null,
    }))
    .filter((point) => Number.isFinite(point.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp);

  if (points.length < 2) {
    return (
      <div className={`chart-empty ${compact ? "compact" : ""}`}>
        <svg viewBox="0 0 320 112" aria-hidden="true">
          <path d="M16 88h288M16 56h288M16 24h288" />
          <path d="M22 78l58-8 52 3 62-24 48 7 58-30" />
        </svg>
        <div>
          <strong>비교할 기록이 더 필요합니다</strong>
          <p>서로 다른 시점의 스냅샷이 2개 이상 쌓이면 자산 성장 흐름을 표시합니다.</p>
        </div>
      </div>
    );
  }

  const min = Math.min(...points.map((point) => point.value));
  const max = Math.max(...points.map((point) => point.value));
  const target = targetAssetKrw ? numeric(targetAssetKrw) : 0;
  const showTarget = target > 0 && target <= max * 1.25 && target >= min * 0.75;
  const markers = cashFlows
    .slice(0, 8)
    .map((flow) => ({ flow, point: interpolatedPoint(points, flow.occurredAt) }))
    .filter((entry): entry is { flow: CashFlowEntry; point: ChartPoint } => entry.point !== null);
  const livePoint = points.find((point) => point.isLive) ?? null;

  return (
    <div className={`trend-chart ${compact ? "compact" : ""}`}>
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <LineChart data={points} margin={{ top: 16, right: 12, bottom: 6, left: compact ? 0 : 12 }}>
          <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="2 6" vertical={false} />
          <XAxis
            dataKey="timestamp"
            type="number"
            domain={["dataMin", "dataMax"]}
            tickFormatter={(value) => formatDate(new Date(Number(value)).toISOString()).replace(/\d{4}년\s?/, "")}
            tick={{ fill: "var(--quiet)", fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            minTickGap={36}
          />
          <YAxis
            domain={["auto", "auto"]}
            tickFormatter={(value) => formatCompactKrw(value)}
            tick={{ fill: "var(--quiet)", fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            width={compact ? 54 : 70}
          />
          <Tooltip
            cursor={{ stroke: "var(--chart-cursor)", strokeDasharray: "3 4" }}
            labelFormatter={(value) => formatDate(new Date(Number(value)).toISOString(), true)}
            formatter={(value) => [formatKrw(Number(value)), "추적 자산"]}
            contentStyle={{
              border: "1px solid var(--line-strong)",
              borderRadius: "10px",
              background: "var(--surface)",
              color: "var(--ink)",
              boxShadow: "var(--shadow-float)",
              fontSize: "12px",
            }}
          />
          {showTarget ? (
            <ReferenceLine
              y={target}
              stroke="var(--warning)"
              strokeDasharray="6 5"
              label={{ value: "목표", position: "insideTopRight", fill: "var(--warning)", fontSize: 11 }}
            />
          ) : null}
          <Line
            type="linear"
            dataKey="value"
            stroke="var(--accent)"
            strokeWidth={compact ? 2 : 2.5}
            dot={false}
            activeDot={{ r: 4, fill: "var(--accent)", stroke: "var(--surface)", strokeWidth: 2 }}
            isAnimationActive={false}
          />
          {planLine ? (
            <Line
              type="linear"
              dataKey="planValue"
              stroke="var(--warning)"
              strokeWidth={1.5}
              strokeDasharray="7 6"
              dot={false}
              activeDot={false}
              isAnimationActive={false}
            />
          ) : null}
          {livePoint ? (
            <ReferenceDot
              x={livePoint.timestamp}
              y={livePoint.value}
              r={5}
              fill="var(--surface)"
              stroke="var(--accent)"
              strokeWidth={2.5}
            />
          ) : null}
          {markers.map(({ flow, point }) => (
            <ReferenceDot
              key={flow.id}
              x={point.timestamp}
              y={point.value}
              r={3.5}
              fill={flow.kind === "contribution" ? "var(--positive)" : "var(--negative)"}
              stroke="var(--surface)"
              strokeWidth={1.5}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
      {planLine ? (
        <div className="chart-legend" aria-hidden="true"><span><i />실제 추적 자산</span><span><b />무수익 계획선</span></div>
      ) : null}
      <table className="sr-only">
        <caption>자산 기록의 날짜별 추적 자산</caption>
        <thead><tr><th>날짜</th><th>추적 자산</th></tr></thead>
        <tbody>
          {points.map((point) => (
            <tr key={point.id}><td>{formatDate(point.capturedAt, true)}{point.isLive ? " (현재 조회)" : ""}</td><td>{formatKrw(point.exactValue)}</td></tr>
          ))}
        </tbody>
      </table>
      <dl className="sr-only">
        {targetAssetKrw ? <><dt>목표 자산</dt><dd>{formatKrw(targetAssetKrw)}</dd></> : null}
        {planLine ? <><dt>무수익 계획선</dt><dd>{formatDate(planLine.startDate)} {formatKrw(planLine.startAssetKrw)}에서 {formatDate(planLine.targetDate)} {formatKrw(planLine.targetAssetKrw)}까지 균등 적립</dd></> : null}
        {markers.map(({ flow }) => (
          <div key={`text-${flow.id}`}>
            <dt>{flow.kind === "contribution" ? "외부 입금" : "외부 출금"}</dt>
            <dd>{formatDate(flow.occurredAt, true)} · {formatKrw(flow.amountKrw)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
