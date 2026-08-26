import assert from "node:assert/strict";
import "./trusted-platform-auth.mjs";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const mockedWorkersModule = "\0ledgerlens-test-cloudflare-workers";
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
        name: "ledgerlens-test-cloudflare-workers",
        resolveId(source) {
          if (source === "cloudflare:workers") return mockedWorkersModule;
          return null;
        },
        load(id) {
          if (id === mockedWorkersModule) return "export const env = Object.freeze({});";
          return null;
        },
      },
    ],
    server: { middlewareMode: true },
  });
});

after(async () => {
  await vite?.close();
});

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

function assertPrivateNoStore(response) {
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(response.headers.get("cloudflare-cdn-cache-control"), "no-store");
}

test("history ownership requires explicit loopback opt-in or a platform identity", async () => {
  const { HistoryIdentityError, resolveHistoryOwner } = await vite.ssrLoadModule(
    "/lib/history/identity.ts",
  );
  const previousLocalOptIn = process.env.LEDGERLENS_ALLOW_LOCAL_HISTORY;
  const previousPlatformTrust = process.env.LEDGERLENS_TRUST_PLATFORM_AUTH;

  try {
    delete process.env.LEDGERLENS_ALLOW_LOCAL_HISTORY;
    for (const url of ["http://localhost/api/history", "http://127.0.0.1/api/history"] ) {
      assert.throws(
        () => resolveHistoryOwner(new Request(url)),
        (error) =>
          error instanceof HistoryIdentityError &&
          error.status === 401 &&
          error.code === "history-owner-required",
      );
    }

    process.env.LEDGERLENS_ALLOW_LOCAL_HISTORY = "TRUE";
    assert.throws(
      () => resolveHistoryOwner(new Request("http://localhost/api/history")),
      (error) => error instanceof HistoryIdentityError && error.status === 401,
    );

    process.env.LEDGERLENS_ALLOW_LOCAL_HISTORY = "true";
    assert.equal(
      resolveHistoryOwner(new Request("http://localhost/api/history")),
      "local-development-owner",
    );

    delete process.env.LEDGERLENS_TRUST_PLATFORM_AUTH;
    assert.throws(
      () => resolveHistoryOwner(
        new Request("https://ledger.example/api/history", {
          headers: { "oai-authenticated-user-id": "owner-123" },
        }),
      ),
      (error) => error instanceof HistoryIdentityError && error.status === 401,
    );

    process.env.LEDGERLENS_TRUST_PLATFORM_AUTH = "true";
    assert.equal(
      resolveHistoryOwner(
        new Request("https://ledger.example/api/history", {
          headers: { "oai-authenticated-user-id": "  owner-123  " },
        }),
      ),
      "owner-123",
    );
    assert.throws(
      () => resolveHistoryOwner(new Request("https://ledger.example/api/history")),
      (error) =>
        error instanceof HistoryIdentityError &&
        error.status === 401 &&
        error.code === "history-owner-required",
    );
  } finally {
    if (previousLocalOptIn === undefined) {
      delete process.env.LEDGERLENS_ALLOW_LOCAL_HISTORY;
    } else {
      process.env.LEDGERLENS_ALLOW_LOCAL_HISTORY = previousLocalOptIn;
    }
    if (previousPlatformTrust === undefined) {
      delete process.env.LEDGERLENS_TRUST_PLATFORM_AUTH;
    } else {
      process.env.LEDGERLENS_TRUST_PLATFORM_AUTH = previousPlatformTrust;
    }
  }
});

test("public Demo history reads return an empty no-store ledger without owner access", async () => {
  const { GET } = await vite.ssrLoadModule("/app/api/history/route.ts");
  const keys = [
    "TOSS_DIRECT_API_ENABLED",
    "TOSS_CLIENT_ID",
    "TOSS_CLIENT_SECRET",
    "TOSS_RELAY_URL",
    "TOSS_RELAY_TOKEN",
    "LEDGERLENS_ALLOW_LOCAL_HISTORY",
    "LEDGERLENS_TRUST_PLATFORM_AUTH",
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    const response = await GET(new Request("https://public.example/api/history?limit=30"));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { snapshots: [], count: 0 });
    assertPrivateNoStore(response);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("capture rejects missing intent, cross-origin requests, and invalid idempotency keys", async () => {
  const { POST } = await vite.ssrLoadModule("/app/api/history/route.ts");
  const url = "https://ledger.example/api/history";
  const cases = [
    {
      headers: {},
      status: 428,
      code: "capture-intent-required",
    },
    {
      headers: { "X-LedgerLens-Intent": "CAPTURE" },
      status: 428,
      code: "capture-intent-required",
    },
    {
      headers: { "X-LedgerLens-Intent": "capture" },
      status: 403,
      code: "same-origin-required",
    },
    {
      headers: {
        "X-LedgerLens-Intent": "capture",
        Origin: "https://attacker.example",
      },
      status: 403,
      code: "same-origin-required",
    },
    {
      headers: {
        "X-LedgerLens-Intent": "capture",
        Origin: "https://ledger.example",
        "Sec-Fetch-Site": "cross-site",
      },
      status: 403,
      code: "same-origin-required",
    },
    {
      headers: {
        "X-LedgerLens-Intent": "capture",
        Origin: "https://ledger.example",
      },
      status: 400,
      code: "invalid-idempotency-key",
    },
    {
      headers: {
        "X-LedgerLens-Intent": "capture",
        Origin: "https://ledger.example",
        "Idempotency-Key": "short",
      },
      status: 400,
      code: "invalid-idempotency-key",
    },
  ];

  for (const expectation of cases) {
    const response = await POST(new Request(url, { method: "POST", headers: expectation.headers }));
    assert.equal(response.status, expectation.status);
    assert.equal(await responseCode(response), expectation.code);
    assertPrivateNoStore(response);
  }

  const wrongPort = await POST(
    new Request("http://localhost:3000/api/history", {
      method: "POST",
      headers: {
        "X-LedgerLens-Intent": "capture",
        Origin: "http://localhost:3001",
        "Idempotency-Key": "capture-1234",
      },
    }),
  );
  assert.equal(wrongPort.status, 403);
  assert.equal(await responseCode(wrongPort), "same-origin-required");

  const directKeys = [
    "TOSS_DIRECT_API_ENABLED",
    "TOSS_CLIENT_ID",
    "TOSS_CLIENT_SECRET",
    "TOSS_RELAY_URL",
    "TOSS_RELAY_TOKEN",
    "TOSS_RELAY_ACCOUNT_KEY",
  ];
  const previousDirect = Object.fromEntries(
    directKeys.map((key) => [key, process.env[key]]),
  );
  try {
    process.env.TOSS_DIRECT_API_ENABLED = "true";
    process.env.TOSS_CLIENT_ID = "validation-direct-client";
    process.env.TOSS_CLIENT_SECRET = "validation-direct-secret";
    delete process.env.TOSS_RELAY_URL;
    delete process.env.TOSS_RELAY_TOKEN;
    delete process.env.TOSS_RELAY_ACCOUNT_KEY;
    const validEnvelopeWithoutOwner = await POST(
      new Request(url, {
        method: "POST",
        headers: {
          "X-LedgerLens-Intent": "capture",
          Origin: "https://ledger.example",
          "Idempotency-Key": "capture-1234",
        },
      }),
    );
    assert.equal(validEnvelopeWithoutOwner.status, 401);
    assert.equal(await responseCode(validEnvelopeWithoutOwner), "history-owner-required");
  } finally {
    restoreEnvironment(previousDirect);
  }
});

test("history limit accepts only one canonical integer from 1 through 365", async () => {
  const { GET } = await vite.ssrLoadModule("/app/api/history/route.ts");
  const invalidQueries = [
    "limit=",
    "limit=0",
    "limit=366",
    "limit=-1",
    "limit=01",
    "limit=1.5",
    "limit=1e2",
    "limit=1&limit=2",
  ];

  for (const query of invalidQueries) {
    const response = await GET(new Request(`https://ledger.example/api/history?${query}`));
    assert.equal(response.status, 400, query);
    assert.equal(await responseCode(response), "invalid-limit", query);
    assertPrivateNoStore(response);
  }

  const directKeys = [
    "TOSS_DIRECT_API_ENABLED",
    "TOSS_CLIENT_ID",
    "TOSS_CLIENT_SECRET",
    "TOSS_RELAY_URL",
    "TOSS_RELAY_TOKEN",
    "TOSS_RELAY_ACCOUNT_KEY",
  ];
  const previousDirect = Object.fromEntries(
    directKeys.map((key) => [key, process.env[key]]),
  );
  try {
    process.env.TOSS_DIRECT_API_ENABLED = "true";
    process.env.TOSS_CLIENT_ID = "validation-direct-client";
    process.env.TOSS_CLIENT_SECRET = "validation-direct-secret";
    delete process.env.TOSS_RELAY_URL;
    delete process.env.TOSS_RELAY_TOKEN;
    delete process.env.TOSS_RELAY_ACCOUNT_KEY;
    for (const suffix of ["", "?limit=1", "?limit=365"]) {
      const response = await GET(new Request(`https://ledger.example/api/history${suffix}`));
      assert.equal(response.status, 401, suffix || "default limit");
      assert.equal(await responseCode(response), "history-owner-required");
    }
  } finally {
    restoreEnvironment(previousDirect);
  }
});

test("demo portfolios are rejected before D1 is accessed", async () => {
  const [{ capturePortfolioSnapshot }, { createDemoPortfolio }] = await Promise.all([
    vite.ssrLoadModule("/lib/history/storage.ts"),
    vite.ssrLoadModule("/lib/portfolio/demo.ts"),
  ]);
  const portfolio = createDemoPortfolio({
    connection: { configured: false, missing: [] },
    reason: "not-configured",
    now: () => new Date("2026-08-07T00:00:00.000Z"),
  });

  await assert.rejects(
    capturePortfolioSnapshot(portfolio, {
      ownerId: "owner-123",
      accountKey: "account-123",
      idempotencyKey: "capture-1234",
    }),
    /Only a live portfolio can be captured/,
  );
});

test("history route uses the shared server loader and never self-fetches", async () => {
  const route = await readFile(new URL("../app/api/history/route.ts", import.meta.url), "utf8");
  const loadIndex = route.indexOf("await loadCurrentPortfolio()");
  const liveGuardIndex = route.indexOf('portfolio.mode !== "live"', loadIndex);
  const captureIndex = route.indexOf("await capturePortfolioSnapshot", liveGuardIndex);

  assert.ok(loadIndex >= 0, "history capture must use the shared portfolio loader");
  assert.ok(liveGuardIndex > loadIndex, "live mode must be checked after loading");
  assert.ok(captureIndex > liveGuardIndex, "persistence must happen after the live-mode guard");
  assert.doesNotMatch(route, /\bfetch\s*\(/);
  assert.match(route, /Cache-Control["']?:\s*["']private, no-store, max-age=0["']/);
  assert.match(route, /Cloudflare-CDN-Cache-Control["']?:\s*["']no-store["']/);
});

test("D1 schema stores exact decimals as TEXT and enforces isolation indexes", async () => {
  const [hostingExampleText, schema, storage, migrationNames] = await Promise.all([
    readFile(new URL("../.openai/hosting.example.json", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/history/storage.ts", import.meta.url), "utf8"),
    readdir(new URL("../drizzle/", import.meta.url)),
  ]);
  const sqlNames = migrationNames.filter((name) => name.endsWith(".sql")).sort();
  assert.ok(sqlNames.length > 0, "at least one generated D1 migration is required");
  const migration = (
    await Promise.all(
      sqlNames.map((name) => readFile(new URL(`../drizzle/${name}`, import.meta.url), "utf8")),
    )
  ).join("\n");

  assert.equal(JSON.parse(hostingExampleText).d1, "DB");
  assert.match(migration, /CREATE TABLE [`"]portfolio_snapshots[`"]/i);
  assert.match(migration, /CREATE TABLE [`"]portfolio_holding_snapshots[`"]/i);

  const decimalColumns = [
    "equity_value_krw",
    "purchase_value_krw",
    "profit_loss_krw",
    "profit_loss_rate",
    "daily_profit_loss_krw",
    "daily_profit_loss_rate",
    "buying_power_krw",
    "buying_power_usd",
    "usd_krw_rate",
    "total_tracked_value_krw",
    "quantity",
    "last_price",
    "average_purchase_price",
    "market_value_native",
    "market_value_krw",
    "profit_loss_native",
    "daily_profit_loss_native",
  ];
  for (const column of decimalColumns) {
    assert.match(
      migration,
      new RegExp("[`\\\"]" + column + "[`\\\"]\\s+text\\s+NOT NULL", "i"),
      `${column} must use exact TEXT storage`,
    );
  }
  assert.doesNotMatch(migration, /\b(?:real|double|float)\b/i);
  assert.doesNotMatch(schema, /\breal\s*\(/);

  assert.match(
    migration,
    /CREATE UNIQUE INDEX [`"]idx_portfolio_snapshots_owner_idempotency[`"].*\([`"]owner_id[`"],[`"]idempotency_key[`"]\)/is,
  );
  assert.match(
    migration,
    /CREATE INDEX [`"]idx_portfolio_snapshots_owner_account_captured[`"].*\([`"]owner_id[`"],[`"]account_key[`"],[`"]captured_at[`"]\)/is,
  );
  assert.match(migration, /FOREIGN KEY.*REFERENCES [`"]portfolio_snapshots[`"].*ON DELETE cascade/is);

  assert.match(storage, /const statements = \[/);
  assert.match(storage, /await database\.batch\(statements\)/);
  assert.match(storage, /INSERT OR IGNORE INTO portfolio_snapshots/);
  assert.match(storage, /PRAGMA optimize/);
  assert.doesNotMatch(storage, /database\.prepare\(INSERT_(?:SNAPSHOT|HOLDING)\)[\s\S]*?\.run\(/);
});
