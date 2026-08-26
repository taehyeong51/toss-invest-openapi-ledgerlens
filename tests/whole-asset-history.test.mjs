import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const mockedWorkersModule = "\0ledgerlens-test-cloudflare-workers-whole-assets";
let vite;

before(async () => {
  vite = await createServer({
    root,
    configFile: false,
    appType: "custom",
    logLevel: "silent",
    resolve: { alias: [{ find: "@", replacement: root }] },
    plugins: [
      {
        name: "ledgerlens-test-cloudflare-workers-whole-assets",
        resolveId(source) {
          if (source === "cloudflare:workers") return mockedWorkersModule;
          return null;
        },
        load(id) {
          if (id === mockedWorkersModule) {
            return `export const env = new Proxy({}, {
              get(_target, key) {
                return globalThis.__ledgerlensWholeAssetsWorkersEnv?.[key];
              }
            });`;
          }
          return null;
        },
      },
    ],
    server: { middlewareMode: true },
  });
});

after(async () => {
  delete globalThis.__ledgerlensWholeAssetsWorkersEnv;
  await vite?.close();
});

function portfolio(id, capturedAt, totalTrackedValueKrw) {
  return {
    id,
    capturedAt,
    equityValueKrw: totalTrackedValueKrw,
    profitLossKrw: "0",
    buyingPowerKrw: "0",
    totalTrackedValueKrw,
    usdKrwRate: "1300",
    holdingCount: 1,
  };
}

function external(assetId, revision, capturedAt, valuedAt, valueKrw) {
  return { assetId, revision, capturedAt, valuedAt, valueKrw };
}

function restoreEnvironment(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test("whole-asset history is exact, continuous, correction-safe, and has no look-ahead", async () => {
  const { buildWholeAssetHistory } = await vite.ssrLoadModule(
    "/lib/assets/history.ts",
  );
  const portfolioSnapshots = [
    portfolio(
      "ps_january",
      "2026-01-15T00:00:00.000Z",
      "900719925474099312345.25",
    ),
    portfolio(
      "ps_march",
      "2026-03-10T00:00:00.000Z",
      "900719925474099312350.5",
    ),
  ];
  const externalSnapshots = [
    external("ea_a", 1, "2026-01-20T00:00:00.000Z", "2026-01-05", "5"),
    // This correction is known only in February and must not rewrite January.
    external("ea_a", 2, "2026-02-10T00:00:00.000Z", "2026-01-05", "7"),
    // A zero-valued revision closes the asset while retaining its audit trail.
    external("ea_a", 3, "2026-03-05T00:00:00.000Z", "2026-03-05", "0"),
    // 15:30 UTC is April 1 in Korea, so this must not enter the March point.
    external("ea_b", 1, "2026-03-31T15:30:00.000Z", "2026-03-31", "11"),
    // It was captured earlier, but its future valuation date prevents look-ahead.
    external("ea_c", 1, "2026-02-10T00:00:00.000Z", "2026-04-01", "13"),
  ];

  const result = buildWholeAssetHistory(
    portfolioSnapshots,
    externalSnapshots,
    60,
  );

  assert.equal(result.status, "ready");
  assert.equal(result.scope.performanceIncluded, false);
  assert.equal(result.scope.historicalScope, "registered-as-of-observation");
  assert.deepEqual(result.points.map((point) => point.month), [
    "2026-01",
    "2026-02",
    "2026-03",
    "2026-04",
  ]);
  assert.deepEqual(
    result.points.map((point) => point.externalValueKrw),
    ["5", "7", "0", "24"],
  );
  assert.deepEqual(
    result.points.map((point) => point.totalRegisteredValueKrw),
    [
      "900719925474099312350.25",
      "900719925474099312352.25",
      "900719925474099312350.5",
      "900719925474099312374.5",
    ],
  );
  assert.deepEqual(
    result.points.map((point) => point.activeExternalAssetCount),
    [1, 1, 0, 2],
  );
  assert.deepEqual(
    result.points.map((point) => point.portfolioCarriedForward),
    [false, true, false, true],
  );
  assert.equal(result.points[0].observedAt, "2026-01-15T00:00:00.000Z");
  assert.equal(result.points[1].observedAt, "2026-01-15T00:00:00.000Z");
  assert.equal(result.points[2].latestExternalValuedAt, "2026-03-05");
  assert.match(result.warnings.join(" "), /투자 수익률이 아닙니다/);
  assert.match(result.warnings.join(" "), /이월했습니다/);

  const latestThree = buildWholeAssetHistory(
    portfolioSnapshots,
    externalSnapshots,
    3,
  );
  assert.deepEqual(latestThree.points.map((point) => point.month), [
    "2026-02",
    "2026-03",
    "2026-04",
  ]);
});

test("whole-asset history reports demo and insufficient states explicitly", async () => {
  const { buildWholeAssetHistory, createDemoWholeAssetHistory } =
    await vite.ssrLoadModule("/lib/assets/history.ts");

  assert.deepEqual(createDemoWholeAssetHistory(), {
    status: "demo",
    points: [],
    count: 0,
    scope: {
      performanceIncluded: false,
      historicalScope: "registered-as-of-observation",
    },
    warnings: ["데모 모드에서는 개인 자산 이력을 저장하지 않습니다."],
  });

  const empty = buildWholeAssetHistory([], [], 24);
  assert.equal(empty.status, "insufficient-history");
  assert.equal(empty.count, 0);

  const single = buildWholeAssetHistory(
    [portfolio("ps_only", "2026-08-25T01:00:00.000Z", "10")],
    [],
    24,
  );
  assert.equal(single.status, "insufficient-history");
  assert.equal(single.count, 1);
  assert.throws(() => buildWholeAssetHistory([], [], 0), RangeError);
  assert.throws(() => buildWholeAssetHistory([], [], 61), RangeError);
});

test("whole-asset history route validates months and is demo-safe before D1", async () => {
  const { GET } = await vite.ssrLoadModule(
    "/app/api/whole-asset-history/route.ts",
  );
  const environmentKeys = [
    "TOSS_DIRECT_API_ENABLED",
    "TOSS_CLIENT_ID",
    "TOSS_CLIENT_SECRET",
    "TOSS_RELAY_URL",
    "TOSS_RELAY_TOKEN",
    "TOSS_RELAY_ACCOUNT_KEY",
  ];
  const previous = Object.fromEntries(
    environmentKeys.map((key) => [key, process.env[key]]),
  );
  globalThis.__ledgerlensWholeAssetsWorkersEnv = {
    DB: {
      prepare() {
        throw new Error("D1 must not be accessed in demo mode");
      },
    },
  };

  try {
    for (const key of environmentKeys) delete process.env[key];
    for (const query of [
      "months=",
      "months=0",
      "months=61",
      "months=01",
      "months=1.5",
      "months=1&months=2",
    ]) {
      const response = await GET(
        new Request(`https://ledger.example/api/whole-asset-history?${query}`),
      );
      assert.equal(response.status, 400, query);
      assert.equal((await response.json()).error.code, "invalid-months", query);
      assert.equal(
        response.headers.get("cache-control"),
        "private, no-store, max-age=0",
      );
    }

    for (const suffix of ["", "?months=1", "?months=60"]) {
      const response = await GET(
        new Request(`https://ledger.example/api/whole-asset-history${suffix}`),
      );
      assert.equal(response.status, 200, suffix || "default");
      const body = await response.json();
      assert.equal(body.status, "demo");
      assert.equal(body.scope.performanceIncluded, false);
      assert.equal(response.headers.get("cloudflare-cdn-cache-control"), "no-store");
    }
  } finally {
    restoreEnvironment(previous);
  }
});

test("whole-asset storage and route keep account isolation and bounded reads", async () => {
  const [storage, route] = await Promise.all([
    readFile(new URL("../lib/assets/storage.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../app/api/whole-asset-history/route.ts", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(
    storage,
    /FROM external_asset_snapshots[\s\S]*WHERE owner_id = \? AND account_key = \?[\s\S]*LIMIT \?/,
  );
  assert.match(
    storage,
    /ORDER BY captured_at DESC, revision DESC, valued_at DESC, asset_id DESC/,
  );
  assert.match(route, /listPortfolioSnapshots\(ownerId, accountKey,/);
  assert.match(route, /listExternalAssetSnapshots\(ownerId, accountKey,/);
  assert.match(route, /const MAX_SOURCE_ROWS = 10_000/);
  assert.match(route, /Cache-Control": "private, no-store, max-age=0"/);
  assert.doesNotMatch(route, /\bfetch\s*\(/);
});
