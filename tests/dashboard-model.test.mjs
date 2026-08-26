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

test("dashboard groups brokerage cash and manual assets exactly once", async () => {
  const { buildDashboardAssetBreakdown } = await vite.ssrLoadModule(
    "/lib/dashboard/model.ts",
  );
  const result = buildDashboardAssetBreakdown({
    portfolio: {
      equityValueKrw: "100",
      buyingPowerKrw: "20",
      buyingPowerUsd: "2",
      usdKrwRate: "10",
    },
    externalAssets: [
      { kind: "cash", valueKrw: "5" },
      { kind: "deposit", valueKrw: "7" },
      { kind: "savings", valueKrw: "3" },
      { kind: "pension", valueKrw: "11" },
      { kind: "insurance", valueKrw: "13" },
      { kind: "property", valueKrw: "17" },
      { kind: "crypto", valueKrw: "19" },
      { kind: "other", valueKrw: "23" },
    ],
    externalTotalValueKrw: "98",
  });

  assert.equal(result.brokerageCashKrw, "40");
  assert.equal(result.externalValueKrw, "98");
  assert.equal(result.totalValueKrw, "238");
  assert.deepEqual(result.buckets, [
    { key: "cash", valueKrw: "45" },
    { key: "deposits", valueKrw: "10" },
    { key: "pensionInsurance", valueKrw: "24" },
    { key: "equities", valueKrw: "100" },
    { key: "other", valueKrw: "59" },
  ]);
});

test("dashboard keeps a truncated external total as unclassified value", async () => {
  const { buildDashboardAssetBreakdown } = await vite.ssrLoadModule(
    "/lib/dashboard/model.ts",
  );
  const result = buildDashboardAssetBreakdown({
    portfolio: {
      equityValueKrw: "0",
      buyingPowerKrw: "0",
      buyingPowerUsd: "0",
      usdKrwRate: "0",
    },
    externalAssets: [{ kind: "deposit", valueKrw: "90.25" }],
    externalTotalValueKrw: "100.75",
  });

  assert.equal(result.totalValueKrw, "100.75");
  assert.equal(result.buckets.find((bucket) => bucket.key === "deposits").valueKrw, "90.25");
  assert.equal(result.buckets.find((bucket) => bucket.key === "other").valueKrw, "10.5");
});

test("whole-asset growth requires reliable history and current manual assets", async () => {
  const { canShowWholeAssetGrowth } = await vite.ssrLoadModule(
    "/lib/dashboard/model.ts",
  );

  assert.equal(canShowWholeAssetGrowth({
    wholeAssetHistoryStatus: "ready",
    externalAssetsStatus: "ready",
    pointCount: 2,
  }), true);
  assert.equal(canShowWholeAssetGrowth({
    wholeAssetHistoryStatus: "ready",
    externalAssetsStatus: "unavailable",
    pointCount: 2,
  }), false);
  assert.equal(canShowWholeAssetGrowth({
    wholeAssetHistoryStatus: "insufficient-history",
    externalAssetsStatus: "ready",
    pointCount: 2,
  }), false);
});
