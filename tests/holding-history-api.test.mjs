import assert from "node:assert/strict";
import "./trusted-platform-auth.mjs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const mockedWorkersModule = "\0ledgerlens-test-cloudflare-workers-holding-history";
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
        name: "ledgerlens-test-cloudflare-workers-holding-history",
        resolveId(source) {
          if (source === "cloudflare:workers") return mockedWorkersModule;
          return null;
        },
        load(id) {
          if (id === mockedWorkersModule) {
            return `export const env = new Proxy({}, {
              get(_target, key) {
                return globalThis.__ledgerlensHoldingHistoryWorkersEnv?.[key];
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
  delete globalThis.__ledgerlensHoldingHistoryWorkersEnv;
  await vite?.close();
});

function assertPrivateNoStore(response) {
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(response.headers.get("cloudflare-cdn-cache-control"), "no-store");
}

async function responseCode(response) {
  const body = await response.json();
  return body.error?.code;
}

function restoreEnvironment(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test("holding-history query accepts only one bounded canonical selector", async () => {
  const { GET } = await vite.ssrLoadModule("/app/api/holding-history/route.ts");
  const base = "https://ledger.example/api/holding-history";
  const cases = [
    ["", "invalid-symbol"],
    ["?symbol=AAPL&marketCountry=US&currency=USD&extra=1", "invalid-query"],
    ["?symbol=AAPL&symbol=QQQ&marketCountry=US&currency=USD", "invalid-symbol"],
    ["?symbol=AAPL%20INC&marketCountry=US&currency=USD", "invalid-symbol"],
    ["?symbol=AAPL&marketCountry=us&currency=USD", "invalid-market-country"],
    ["?symbol=AAPL&marketCountry=US&marketCountry=KR&currency=USD", "invalid-market-country"],
    ["?symbol=AAPL&marketCountry=US&currency=usd", "invalid-currency"],
    ["?symbol=AAPL&marketCountry=US&currency=USD&currency=KRW", "invalid-currency"],
    ["?symbol=AAPL&marketCountry=US&currency=USD&limit=", "invalid-limit"],
    ["?symbol=AAPL&marketCountry=US&currency=USD&limit=0", "invalid-limit"],
    ["?symbol=AAPL&marketCountry=US&currency=USD&limit=366", "invalid-limit"],
    ["?symbol=AAPL&marketCountry=US&currency=USD&limit=01", "invalid-limit"],
    ["?symbol=AAPL&marketCountry=US&currency=USD&limit=1.5", "invalid-limit"],
    ["?symbol=AAPL&marketCountry=US&currency=USD&limit=1&limit=2", "invalid-limit"],
  ];

  for (const [query, code] of cases) {
    const response = await GET(new Request(`${base}${query}`));
    assert.equal(response.status, 400, query || "missing selector");
    assert.equal(await responseCode(response), code, query || "missing selector");
    assertPrivateNoStore(response);
  }

  for (const suffix of [
    "?symbol=005930&marketCountry=KR&currency=KRW",
    "?symbol=BRK.B&marketCountry=US&currency=USD&limit=1",
    "?symbol=AAPL&marketCountry=US&currency=USD&limit=365",
  ]) {
    const response = await GET(new Request(`${base}${suffix}`));
    assert.equal(response.status, 401, suffix);
    assert.equal(await responseCode(response), "history-owner-required", suffix);
    assertPrivateNoStore(response);
  }
});

test("demo holding history is empty and never touches D1", async () => {
  const environmentKeys = [
    "TOSS_DIRECT_API_ENABLED",
    "TOSS_CLIENT_ID",
    "TOSS_CLIENT_SECRET",
    "TOSS_RELAY_URL",
    "TOSS_RELAY_TOKEN",
    "TOSS_RELAY_ACCOUNT_KEY",
  ];
  const previous = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  let databaseReads = 0;
  globalThis.__ledgerlensHoldingHistoryWorkersEnv = new Proxy(
    {},
    {
      get(_target, key) {
        if (key === "DB") databaseReads += 1;
        return undefined;
      },
    },
  );

  try {
    for (const key of environmentKeys) delete process.env[key];
    const { GET } = await vite.ssrLoadModule("/app/api/holding-history/route.ts");
    const response = await GET(
      new Request(
        "https://ledger.example/api/holding-history?symbol=AAPL&marketCountry=US&currency=USD",
        { headers: { "oai-authenticated-user-id": "owner-123" } },
      ),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: "demo",
      holding: null,
      points: [],
      count: 0,
    });
    assert.equal(databaseReads, 0);
    assertPrivateNoStore(response);
  } finally {
    restoreEnvironment(previous);
    delete globalThis.__ledgerlensHoldingHistoryWorkersEnv;
  }
});

test("holding-history storage binds owner, account, identity, and limit in one exact query", async () => {
  const queryCalls = [];
  const rows = [
    {
      snapshotId: "ps_new",
      capturedAt: "2026-08-12T00:00:00.000Z",
      symbol: "AAPL",
      name: "Apple",
      marketCountry: "US",
      currency: "USD",
      quantity: "900719925474099312345.123",
      lastPrice: "214.3500",
      averagePurchasePrice: "183.20",
      marketValueNative: "1928367484.001",
      marketValueKrw: "2665899217882.9821824",
      profitLossNative: "264.775",
      profitLossRate: "0.17003",
      dailyProfitLossNative: "21.25",
      dailyProfitLossRate: "0.0118",
      usdKrwRate: "1382.4",
    },
    {
      snapshotId: "ps_old",
      capturedAt: "2026-08-11T00:00:00.000Z",
      symbol: "AAPL",
      name: "Apple Inc.",
      marketCountry: "US",
      currency: "USD",
      quantity: "8.5",
      lastPrice: "210",
      averagePurchasePrice: "183.20",
      marketValueNative: "1785",
      marketValueKrw: "2467584",
      profitLossNative: "227.8",
      profitLossRate: "0.14629",
      dailyProfitLossNative: "-1.5",
      dailyProfitLossRate: "-0.00084",
      usdKrwRate: "1382.4",
    },
  ];
  const database = {
    prepare(sql) {
      return {
        bindings: [],
        bind(...bindings) {
          this.bindings = bindings;
          return this;
        },
        async all() {
          queryCalls.push({ sql, bindings: [...this.bindings] });
          return { results: rows };
        },
      };
    },
    async batch(statements) {
      return statements.map(() => ({ meta: { changes: 0 } }));
    },
  };
  globalThis.__ledgerlensHoldingHistoryWorkersEnv = { DB: database };

  try {
    const { HistoryStorageError, listPortfolioHoldingHistory } = await vite.ssrLoadModule(
      "/lib/history/storage.ts",
    );
    const history = await listPortfolioHoldingHistory(
      "owner-a",
      "direct:account-a",
      { symbol: "AAPL", marketCountry: "US", currency: "USD" },
      90,
    );

    assert.deepEqual(queryCalls.at(-1).bindings, [
      "owner-a",
      "direct:account-a",
      "AAPL",
      "US",
      "USD",
      90,
    ]);
    assert.match(queryCalls.at(-1).sql, /INNER JOIN portfolio_holding_snapshots/);
    assert.match(queryCalls.at(-1).sql, /snapshots\.owner_id = \?/);
    assert.match(queryCalls.at(-1).sql, /snapshots\.account_key = \?/);
    assert.deepEqual(history.holding, {
      symbol: "AAPL",
      name: "Apple",
      marketCountry: "US",
      currency: "USD",
    });
    assert.equal(history.points.length, 2);
    assert.equal(history.points[0].quantity, "900719925474099312345.123");
    assert.equal(history.points[0].marketValueKrw, "2665899217882.9821824");
    assert.equal("symbol" in history.points[0], false);
    assert.equal("name" in history.points[0], false);

    await assert.rejects(
      listPortfolioHoldingHistory(
        "owner-a",
        "direct:account-a",
        { symbol: "AAPL", marketCountry: "US", currency: "USD" },
        366,
      ),
      (error) => error instanceof HistoryStorageError,
    );
  } finally {
    delete globalThis.__ledgerlensHoldingHistoryWorkersEnv;
  }
});

test("holding-history endpoint remains read-only, no-store, and account-isolated", async () => {
  const [route, storage] = await Promise.all([
    readFile(new URL("../app/api/holding-history/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/history/storage.ts", import.meta.url), "utf8"),
  ]);

  assert.match(route, /Cache-Control["']?:\s*["']private, no-store, max-age=0["']/);
  assert.match(route, /Cloudflare-CDN-Cache-Control["']?:\s*["']no-store["']/);
  assert.doesNotMatch(
    route,
    /export\s+(?:(?:async\s+)?function|const)\s+(?:POST|DELETE|PATCH|PUT)\b/,
  );
  assert.doesNotMatch(route, /\bfetch\s*\(/);
  assert.match(
    storage,
    /WHERE snapshots\.owner_id = \?[\s\S]*snapshots\.account_key = \?[\s\S]*holdings\.symbol = \?/,
  );
  assert.doesNotMatch(
    storage.match(/const LIST_HOLDING_HISTORY = `[\s\S]*?`;/)?.[0] ?? "",
    /\b(?:INSERT|UPDATE|DELETE)\b/i,
  );
});
