import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const mockedWorkersModule = "\0ledgerlens-test-cloudflare-workers-review";
let vite;

before(async () => {
  vite = await createServer({
    root,
    configFile: false,
    appType: "custom",
    logLevel: "silent",
    resolve: { alias: [{ find: "@", replacement: root }] },
    plugins: [{
      name: "ledgerlens-test-cloudflare-workers-review",
      resolveId(source) {
        return source === "cloudflare:workers" ? mockedWorkersModule : null;
      },
      load(id) {
        if (id === mockedWorkersModule) {
          return "export const env = globalThis.__ledgerlensReviewWorkersEnv ?? {};";
        }
        return null;
      },
    }],
    server: { middlewareMode: true },
  });
});

after(async () => {
  await vite?.close();
});

test("plan pace uses an exact zero-return line and a remaining capital gap", async () => {
  const { calculatePlanPace } = await vite.ssrLoadModule("/lib/review/analysis.ts");
  const pace = calculatePlanPace({
    startAssetKrw: "100000000",
    targetAssetKrw: "200000000",
    currentAssetKrw: "160000000",
    startDate: "2026-01-01",
    targetDate: "2026-01-11",
    asOf: "2026-01-05T15:00:00.000Z",
  });
  assert.equal(pace.status, "active");
  assert.equal(pace.elapsedRatio, "0.5");
  assert.equal(pace.plannedAssetKrw, "150000000");
  assert.equal(pace.paceDifferenceKrw, "10000000");
  assert.equal(pace.targetGapKrw, "40000000");
  assert.equal(pace.remainingDays, 5);
  assert.ok(Number(pace.requiredMonthlyContributionKrw) > 0);
});

test("review attribution reconciles total change without claiming price or FX contribution", async () => {
  const { calculateReviewAttribution } = await vite.ssrLoadModule("/lib/review/analysis.ts");
  const snapshots = [
    {
      id: "start",
      capturedAt: "2026-01-01T00:00:00.000Z",
      equityValueKrw: "80000000",
      profitLossKrw: "10000000",
      buyingPowerKrw: "20000000",
      totalTrackedValueKrw: "100000000",
      usdKrwRate: "1300",
      holdingCount: 3,
    },
    {
      id: "end",
      capturedAt: "2026-02-01T00:00:00.000Z",
      equityValueKrw: "105000000",
      profitLossKrw: "15000000",
      buyingPowerKrw: "25000000",
      totalTrackedValueKrw: "130000000",
      usdKrwRate: "1430",
      holdingCount: 3,
    },
  ];
  const result = calculateReviewAttribution(snapshots, [{
    id: "flow",
    occurredAt: "2026-01-15T00:00:00.000Z",
    createdAt: "2026-01-15T01:00:00.000Z",
    kind: "contribution",
    amountKrw: "10000000",
    note: "정기 투자금",
  }]);
  assert.deepEqual(result, {
    grossChangeKrw: "30000000",
    netCashFlowKrw: "10000000",
    holdingValueChangeKrw: "25000000",
    cashAndSettlementResidualKrw: "-5000000",
    unrealizedProfitLossChangeKrw: "5000000",
    usdKrwRateChange: "0.1",
    dominant: "holding-value",
    flowCount: 1,
  });

  const usdCashChanged = calculateReviewAttribution([
    { ...snapshots[0], totalTrackedValueKrw: "100000000", buyingPowerKrw: "10000000" },
    { ...snapshots[1], totalTrackedValueKrw: "140000000", buyingPowerKrw: "15000000" },
  ], [{
    id: "flow",
    occurredAt: "2026-01-15T00:00:00.000Z",
    createdAt: "2026-01-15T01:00:00.000Z",
    kind: "contribution",
    amountKrw: "10000000",
    note: "정기 투자금",
  }]);
  assert.equal(usdCashChanged.cashAndSettlementResidualKrw, "5000000");
  assert.equal(
    Number(usdCashChanged.netCashFlowKrw) +
      Number(usdCashChanged.holdingValueChangeKrw) +
      Number(usdCashChanged.cashAndSettlementResidualKrw),
    Number(usdCashChanged.grossChangeKrw),
  );
});

test("live and stored views share one exact total including USD buying power", async () => {
  const { calculateTotalTrackedValueKrw } = await vite.ssrLoadModule("/lib/portfolio/tracked.ts");
  assert.equal(calculateTotalTrackedValueKrw({
    equityValueKrw: "1000000.125",
    buyingPowerKrw: "150000",
    buyingPowerUsd: "10.5",
    usdKrwRate: "1310.25",
  }), "1163757.75");
});

test("data reliability requires an explicit cash-flow answer and reports observation gaps", async () => {
  const { calculateReviewReliability } = await vite.ssrLoadModule("/lib/review/analysis.ts");
  const input = {
    snapshotTimestamps: [
      "2026-01-01T00:00:00.000Z",
      "2026-01-05T00:00:00.000Z",
      "2026-01-10T00:00:00.000Z",
    ],
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-11T00:00:00.000Z",
    planConfigured: true,
  };
  const unknown = calculateReviewReliability({ ...input, cashFlowConfirmation: "unknown" });
  assert.equal(unknown.readiness, "check");
  assert.match(unknown.limitations.join(" "), /외부 입출금/);
  const complete = calculateReviewReliability({ ...input, cashFlowConfirmation: "complete" });
  assert.equal(complete.readiness, "ready");
  assert.equal(complete.observationDays, 3);
  assert.equal(complete.periodDays, 10);
  assert.equal(complete.gapCount, 2);
});

test("review input is bounded, explicit, and status changes use revisions", async () => {
  const {
    parseNewReviewJournalEntry,
    parseReviewStatusUpdate,
    ReviewValidationError,
  } = await vite.ssrLoadModule("/lib/review/validation.ts");
  const valid = {
    periodStartedAt: "2026-01-01T00:00:00.000Z",
    periodEndedAt: "2026-02-01T00:00:00.000Z",
    cashFlowConfirmation: "complete",
    action: "  목표 배분 편차의 원인 확인  ",
    snapshotCount: 18,
    planRevision: 2,
  };
  assert.deepEqual(parseNewReviewJournalEntry(valid), { ...valid, action: valid.action.trim() });
  assert.deepEqual(parseReviewStatusUpdate({
    id: `rv_${"a".repeat(40)}`,
    status: "resolved",
    expectedRevision: 1,
  }), {
    id: `rv_${"a".repeat(40)}`,
    status: "resolved",
    expectedRevision: 1,
  });
  for (const input of [
    { ...valid, cashFlowConfirmation: "unknown" },
    { ...valid, action: "" },
    { ...valid, action: `확인${"a".repeat(240)}` },
    { ...valid, snapshotCount: 366 },
    { ...valid, unexpected: true },
  ]) {
    assert.throws(
      () => parseNewReviewJournalEntry(input),
      (error) => error instanceof ReviewValidationError && error.code === "invalid-review",
    );
  }
});

test("review route is no-store and demo writes are refused", async () => {
  const previous = {
    TOSS_CLIENT_ID: process.env.TOSS_CLIENT_ID,
    TOSS_CLIENT_SECRET: process.env.TOSS_CLIENT_SECRET,
    TOSS_DIRECT_API_ENABLED: process.env.TOSS_DIRECT_API_ENABLED,
    TOSS_RELAY_URL: process.env.TOSS_RELAY_URL,
    TOSS_RELAY_TOKEN: process.env.TOSS_RELAY_TOKEN,
    TOSS_RELAY_ACCOUNT_KEY: process.env.TOSS_RELAY_ACCOUNT_KEY,
  };
  for (const key of Object.keys(previous)) delete process.env[key];
  try {
    const route = await vite.ssrLoadModule("/app/api/reviews/route.ts");
    const response = await route.GET(new Request("https://ledgerlens.test/api/reviews?limit=12"));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
    assert.deepEqual(await response.json(), { status: "demo", reviews: [], count: 0 });

    const write = await route.POST(new Request("https://ledgerlens.test/api/reviews", {
      method: "POST",
      headers: {
        Origin: "https://ledgerlens.test",
        "Content-Type": "application/json",
        "Idempotency-Key": "review-demo-1234",
        "X-LedgerLens-Intent": "record-review",
      },
      body: "{}",
    }));
    assert.equal(write.status, 409);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("review schema and UI disclose the unsupported attribution boundary", async () => {
  const [migration, storage, planStorage, reviewUi] = await Promise.all([
    readFile(new URL("../drizzle/0005_redundant_tattoo.sql", import.meta.url), "utf8"),
    readFile(new URL("../lib/review/storage.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/planning/storage.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ReviewWorkspace.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(migration, /CREATE TABLE [`"]review_journal[`"]/i);
  assert.match(migration, /ADD [`"]start_asset_krw[`"] text;/i);
  assert.doesNotMatch(migration, /start_asset_krw.*DEFAULT '0'.*NOT NULL/i);
  assert.match(storage, /INSERT OR IGNORE INTO review_journal/);
  assert.doesNotMatch(storage, /\bDELETE\s+FROM\s+review_journal\b/i);
  assert.match(planStorage, /hasConfirmedStartAsset/);
  assert.match(planStorage, /startAssetKrw: hasConfirmedStartAsset \? input\.startAssetKrw : null/);
  assert.match(reviewUi, /가격과 환율 기여도는 거래 원장 없이 분리하지 않습니다/);
  assert.match(reviewUi, /이 기간 외부 입출금을 모두 기록했습니까/);
  assert.match(reviewUi, /Discovery 3\/10/);
});
