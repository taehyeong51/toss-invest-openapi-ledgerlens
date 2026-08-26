import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
let vite;

before(async () => {
  vite = await createServer({
    root,
    configFile: false,
    appType: "custom",
    logLevel: "silent",
    resolve: { alias: [{ find: "@", replacement: root }] },
    server: { middlewareMode: true },
  });
});

after(async () => {
  await vite?.close();
});

function asset(overrides) {
  return {
    id: "ea_default",
    kind: "other",
    name: "기타 자산",
    institution: "",
    currency: "KRW",
    balance: "1",
    valueKrw: "1",
    valuedAt: "2026-08-25",
    maturityDate: null,
    annualRatePercent: null,
    note: "",
    source: "manual",
    revision: 1,
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
    ...overrides,
  };
}

test("freshness uses an exclusive 45-calendar-day boundary", async () => {
  const { calculateExternalAssetDiagnostics } = await vite.ssrLoadModule(
    "/lib/assets/diagnostics.ts",
  );
  const result = calculateExternalAssetDiagnostics([
    asset({ id: "ea_45", name: "45일", valuedAt: "2026-07-11" }),
    asset({ id: "ea_46", name: "46일", valuedAt: "2026-07-10" }),
  ], "2026-08-25");

  assert.equal(result.staleCount, 1);
  assert.deepEqual(
    result.issues.map(({ code, assetId, daysSinceValuation }) => ({
      code,
      assetId,
      daysSinceValuation,
    })),
    [{ code: "valuation-stale", assetId: "ea_46", daysSinceValuation: 46 }],
  );
});

test("maturity includes today and day 30, excludes day 31, and separates overdue", async () => {
  const { calculateExternalAssetDiagnostics } = await vite.ssrLoadModule(
    "/lib/assets/diagnostics.ts",
  );
  const result = calculateExternalAssetDiagnostics([
    asset({
      id: "ea_overdue",
      name: "지남",
      valuedAt: "2026-08-01",
      maturityDate: "2026-08-24",
    }),
    asset({ id: "ea_today", name: "오늘", maturityDate: "2026-08-25" }),
    asset({ id: "ea_30", name: "30일", maturityDate: "2026-09-24" }),
    asset({ id: "ea_31", name: "31일", maturityDate: "2026-09-25" }),
  ], "2026-08-25");

  assert.equal(result.maturityOverdueCount, 1);
  assert.equal(result.maturityDueSoonCount, 2);
  assert.deepEqual(
    result.issues.map(({ code, assetId, daysUntilMaturity }) => ({
      code,
      assetId,
      daysUntilMaturity,
    })),
    [
      { code: "maturity-overdue", assetId: "ea_overdue", daysUntilMaturity: -1 },
      { code: "maturity-due-soon", assetId: "ea_today", daysUntilMaturity: 0 },
      { code: "maturity-due-soon", assetId: "ea_30", daysUntilMaturity: 30 },
    ],
  );
});

test("summary facts preserve exact large decimals and label concentration as a fact", async () => {
  const { calculateExternalAssetDiagnostics } = await vite.ssrLoadModule(
    "/lib/assets/diagnostics.ts",
  );
  const result = calculateExternalAssetDiagnostics([
    asset({
      id: "ea_cash",
      kind: "cash",
      name: "외화 현금",
      currency: "USD",
      valueKrw: "9007199254740993.1",
    }),
    asset({
      id: "ea_deposit",
      kind: "deposit",
      name: "예금",
      valueKrw: "0.2",
    }),
    asset({
      id: "ea_usd_other",
      name: "미국 기타",
      currency: "USD",
      valueKrw: "0.3",
    }),
  ], "2026-08-25");

  assert.equal(result.totalValueKrw, "9007199254740993.6");
  assert.equal(result.cashLikeValueKrw, "9007199254740993.3");
  assert.equal(result.usdValueKrw, "9007199254740993.4");
  assert.deepEqual(result.largestAsset, {
    assetId: "ea_cash",
    name: "외화 현금",
    valueKrw: "9007199254740993.1",
    share: "1",
  });
  assert.equal(result.issues.length, 0);
});

test("largest share uses exact decimal division and deterministic tie-breaking", async () => {
  const { calculateExternalAssetDiagnostics } = await vite.ssrLoadModule(
    "/lib/assets/diagnostics.ts",
  );
  const result = calculateExternalAssetDiagnostics([
    asset({ id: "ea_b", name: "나", valueKrw: "1" }),
    asset({ id: "ea_a", name: "가", valueKrw: "2" }),
  ], "2026-08-25");

  assert.equal(result.largestAsset.assetId, "ea_a");
  assert.equal(result.largestAsset.share, "0.666666666667");

  const tie = calculateExternalAssetDiagnostics([
    asset({ id: "ea_z", name: "같음", valueKrw: "2" }),
    asset({ id: "ea_a", name: "같음", valueKrw: "2" }),
  ], "2026-08-25");
  assert.equal(tie.largestAsset.assetId, "ea_a");
});

test("closed zero-value assets remain counted without creating review issues", async () => {
  const { calculateExternalAssetDiagnostics } = await vite.ssrLoadModule(
    "/lib/assets/diagnostics.ts",
  );
  const result = calculateExternalAssetDiagnostics([
    asset({
      id: "ea_closed",
      kind: "savings",
      balance: "0",
      valueKrw: "0",
      valuedAt: "2020-01-01",
      maturityDate: "2020-02-01",
    }),
  ], "2026-08-25");

  assert.equal(result.assetCount, 1);
  assert.equal(result.activeAssetCount, 0);
  assert.equal(result.analyzedCount, 0);
  assert.equal(result.totalValueKrw, "0");
  assert.equal(result.cashLikeValueKrw, "0");
  assert.equal(result.largestAsset, null);
  assert.deepEqual(result.issues, []);
});

test("issue ordering is stable regardless of input order and now uses KST", async () => {
  const { calculateExternalAssetDiagnostics } = await vite.ssrLoadModule(
    "/lib/assets/diagnostics.ts",
  );
  const assets = [
    asset({ id: "ea_stale_b", name: "나", valuedAt: "2026-01-02" }),
    asset({
      id: "ea_due",
      name: "만기",
      valuedAt: "2026-08-01",
      maturityDate: "2026-08-24",
    }),
    asset({ id: "ea_stale_a", name: "가", valuedAt: "2026-01-01" }),
  ];
  const forward = calculateExternalAssetDiagnostics(
    assets,
    "2026-08-24T15:30:00.000Z",
  );
  const reverse = calculateExternalAssetDiagnostics(
    assets.slice().reverse(),
    "2026-08-24T15:30:00.000Z",
  );

  assert.equal(forward.asOf, "2026-08-25");
  assert.deepEqual(forward.issues, reverse.issues);
  assert.deepEqual(
    forward.issues.map((issue) => issue.assetId),
    ["ea_due", "ea_stale_a", "ea_stale_b"],
  );
});
