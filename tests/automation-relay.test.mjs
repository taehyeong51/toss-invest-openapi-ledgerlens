import assert from "node:assert/strict";
import "./trusted-platform-auth.mjs";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const mockedWorkersModule = "\0ledgerlens-test-cloudflare-workers-phase-4a";
const RELAY_ACCOUNT_REF = "primary-account-ref";
const RELAY_TOKEN = "phase-4a-relay-shared-token-0123456789";
const FIXED_NOW = Date.parse("2026-08-07T00:05:00.000Z");
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
        name: "ledgerlens-test-cloudflare-workers-phase-4a",
        resolveId(source) {
          if (source === "cloudflare:workers") return mockedWorkersModule;
          return null;
        },
        load(id) {
          if (id === mockedWorkersModule) {
            return `export const env = new Proxy({}, {
              get(_target, key) {
                return globalThis.__ledgerlensPhase4WorkersEnv?.[key];
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
  delete globalThis.__ledgerlensPhase4WorkersEnv;
  await vite?.close();
});

function restoreEnvironment(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function environmentSnapshot(keys) {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function assertPrivateNoStore(response) {
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(response.headers.get("cloudflare-cdn-cache-control"), "no-store");
  assert.equal(response.headers.get("pragma"), "no-cache");
}

async function responseCode(response) {
  return (await response.json()).error?.code;
}

function validPortfolio(asOf = "2026-08-07T00:05:00.000Z") {
  return {
    mode: "live",
    asOf,
    account: { maskedNumber: "•••• 1234", type: "BROKERAGE" },
    summary: {
      equityValueKrw: "1000000",
      purchaseValueKrw: "900000",
      profitLossKrw: "100000",
      profitLossRate: "0.11111111",
      dailyProfitLossKrw: "5000",
      dailyProfitLossRate: "0.005",
      buyingPowerKrw: "200000",
      buyingPowerUsd: "10.25",
      usdKrwRate: "1382.4",
    },
    allocation: [
      { key: "KR", label: "국내 주식", valueKrw: "600000", weight: "0.5", targetWeight: "0.45" },
      { key: "US", label: "미국 주식", valueKrw: "400000", weight: "0.33333333", targetWeight: "0.45" },
      { key: "CASH", label: "매수 여력", valueKrw: "200000", weight: "0.16666667", targetWeight: "0.1" },
    ],
    holdings: [],
    notices: [],
    connection: { configured: true, missing: [] },
  };
}

function relayJsonResponse(body, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  headers.set("X-LedgerLens-Account-Ref", RELAY_ACCOUNT_REF);
  return new Response(JSON.stringify(body), { ...init, headers });
}

test("relay parser accepts only a fresh canonical, masked, account-safe public contract", async () => {
  const { PortfolioRelayError, parseRelayPortfolio } = await vite.ssrLoadModule(
    "/lib/portfolio/relay.ts",
  );
  const parsed = parseRelayPortfolio(validPortfolio(), { now: () => FIXED_NOW });
  assert.equal(parsed.mode, "live");
  assert.equal(parsed.account.maskedNumber, "•••• 1234");
  assert.deepEqual(parsed.allocation.map(({ key }) => key), ["KR", "US", "CASH"]);
  assert.deepEqual(parsed.connection, { configured: true, missing: [] });

  const invalidCases = [
    [validPortfolio("2026-08-07T00:05:00Z"), "invalid-relay-response"],
    [validPortfolio("2026-08-06T23:59:59.999Z"), "stale-relay-response"],
    [validPortfolio("2026-08-07T00:06:00.001Z"), "future-relay-response"],
    [{ ...validPortfolio(), account: { maskedNumber: "12345678901", type: "BROKERAGE" } }, "invalid-relay-response"],
    [{ ...validPortfolio(), allocation: [validPortfolio().allocation[0], validPortfolio().allocation[0], validPortfolio().allocation[2]] }, "invalid-relay-response"],
  ];

  for (const [body, code] of invalidCases) {
    assert.throws(
      () => parseRelayPortfolio(body, { now: () => FIXED_NOW }),
      (error) => error instanceof PortfolioRelayError && error.code === code,
      code,
    );
  }
});

test("relay consumer pins GET, bearer auth, no-store, account reference, and redirect policy", async () => {
  const { fetchPortfolioFromRelay, PortfolioRelayError } = await vite.ssrLoadModule(
    "/lib/portfolio/relay.ts",
  );
  let observedInit;
  const portfolio = await fetchPortfolioFromRelay(
    { url: "https://relay.example/api/relay/portfolio", token: RELAY_TOKEN, accountKey: RELAY_ACCOUNT_REF },
    {
      now: () => FIXED_NOW,
      fetchImplementation: async (_input, init) => {
        observedInit = init;
        return relayJsonResponse(validPortfolio());
      },
    },
  );
  assert.equal(portfolio.mode, "live");
  assert.equal(observedInit.method, "GET");
  assert.equal(observedInit.redirect, "manual");
  assert.equal(observedInit.cache, "no-store");
  assert.equal(new Headers(observedInit.headers).get("authorization"), `Bearer ${RELAY_TOKEN}`);

  await assert.rejects(
    fetchPortfolioFromRelay(
      { url: "https://relay.example/api/relay/portfolio", token: RELAY_TOKEN, accountKey: RELAY_ACCOUNT_REF },
      {
        now: () => FIXED_NOW,
        fetchImplementation: async () =>
          new Response(null, { status: 302, headers: { Location: "https://attacker.example" } }),
      },
    ),
    (error) =>
      error instanceof PortfolioRelayError &&
      error.code === "relay-redirect-rejected" &&
      error.upstreamStatus === 302,
  );

  await assert.rejects(
    fetchPortfolioFromRelay(
      { url: "https://relay.example/api/relay/portfolio", token: RELAY_TOKEN, accountKey: "different-account" },
      { now: () => FIXED_NOW, fetchImplementation: async () => relayJsonResponse(validPortfolio()) },
    ),
    (error) => error instanceof PortfolioRelayError && error.code === "relay-account-mismatch",
  );
});

test("relay consumer enforces JSON, two MiB, timeout, and bounded Retry-After", async () => {
  const { fetchPortfolioFromRelay, PortfolioRelayError } = await vite.ssrLoadModule(
    "/lib/portfolio/relay.ts",
  );
  const configuration = {
    url: "https://relay.example/api/relay/portfolio",
    token: RELAY_TOKEN,
    accountKey: RELAY_ACCOUNT_REF,
  };

  await assert.rejects(
    fetchPortfolioFromRelay(configuration, {
      now: () => FIXED_NOW,
      fetchImplementation: async () =>
        new Response("not json", {
          headers: {
            "Content-Type": "text/plain",
            "X-LedgerLens-Account-Ref": RELAY_ACCOUNT_REF,
          },
        }),
    }),
    (error) => error instanceof PortfolioRelayError && error.code === "invalid-relay-response",
  );

  await assert.rejects(
    fetchPortfolioFromRelay(configuration, {
      now: () => FIXED_NOW,
      fetchImplementation: async () =>
        new Response(new Uint8Array(2 * 1024 * 1024 + 1), {
          headers: {
            "Content-Type": "application/json",
            "X-LedgerLens-Account-Ref": RELAY_ACCOUNT_REF,
          },
        }),
    }),
    (error) => error instanceof PortfolioRelayError && error.code === "relay-response-too-large",
  );

  await assert.rejects(
    fetchPortfolioFromRelay(configuration, {
      timeoutMs: 5,
      now: () => FIXED_NOW,
      fetchImplementation: async (_input, init) =>
        await new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    }),
    (error) => error instanceof PortfolioRelayError && error.code === "relay-timeout",
  );

  await assert.rejects(
    fetchPortfolioFromRelay(configuration, {
      now: () => FIXED_NOW,
      fetchImplementation: async () =>
        new Response(null, { status: 429, headers: { "Retry-After": "9000" } }),
    }),
    (error) =>
      error instanceof PortfolioRelayError &&
      error.code === "relay-unavailable" &&
      error.retryAfterSeconds === 3600,
  );
});

test("semantic relay route authenticates before state, rejects queries, and serves only Direct mode", async () => {
  const { GET } = await vite.ssrLoadModule("/app/api/relay/portfolio/route.ts");
  const keys = [
    "LEDGERLENS_RELAY_SHARED_TOKEN",
    "LEDGERLENS_RELAY_ACCOUNT_REF",
    "TOSS_DIRECT_API_ENABLED",
    "TOSS_CLIENT_ID",
    "TOSS_CLIENT_SECRET",
    "TOSS_RELAY_URL",
    "TOSS_RELAY_TOKEN",
    "TOSS_RELAY_ACCOUNT_KEY",
  ];
  const previous = environmentSnapshot(keys);
  try {
    for (const key of keys) delete process.env[key];
    let response = await GET(new Request("https://fixed.example/api/relay/portfolio"));
    assert.equal(response.status, 401);
    assert.equal(await responseCode(response), "relay-authentication-required");
    assertPrivateNoStore(response);

    process.env.LEDGERLENS_RELAY_SHARED_TOKEN = RELAY_TOKEN;
    const headers = { Authorization: `Bearer ${RELAY_TOKEN}` };
    response = await GET(
      new Request("https://fixed.example/api/relay/portfolio?upstream=https://attacker.example", { headers }),
    );
    assert.equal(response.status, 400);
    assert.equal(await responseCode(response), "relay-query-not-allowed");
    assertPrivateNoStore(response);

    process.env.TOSS_RELAY_URL = "https://another-relay.example/api/relay/portfolio";
    process.env.TOSS_RELAY_TOKEN = RELAY_TOKEN;
    process.env.TOSS_RELAY_ACCOUNT_KEY = RELAY_ACCOUNT_REF;
    response = await GET(new Request("https://fixed.example/api/relay/portfolio", { headers }));
    assert.equal(response.status, 422);
    assert.equal(await responseCode(response), "relay-direct-mode-required");
    assertPrivateNoStore(response);

    delete process.env.TOSS_RELAY_URL;
    delete process.env.TOSS_RELAY_TOKEN;
    delete process.env.TOSS_RELAY_ACCOUNT_KEY;
    process.env.TOSS_DIRECT_API_ENABLED = "true";
    process.env.TOSS_CLIENT_ID = "phase-4a-direct-client";
    process.env.TOSS_CLIENT_SECRET = "phase-4a-direct-secret";
    response = await GET(new Request("https://fixed.example/api/relay/portfolio", { headers }));
    assert.equal(response.status, 422);
    assert.equal(await responseCode(response), "relay-account-ref-required");
    assertPrivateNoStore(response);
  } finally {
    restoreEnvironment(previous);
  }
});

test("automation GET and PUT enforce strict query, intent, origin, JSON, body, fields, and revision", async () => {
  const { GET, PUT } = await vite.ssrLoadModule("/app/api/automation/route.ts");
  const url = "https://ledger.example/api/automation";

  for (const query of [
    "limit=",
    "limit=0",
    "limit=31",
    "limit=01",
    "limit=1.5",
    "limit=1e1",
    "limit=1&limit=2",
  ]) {
    const response = await GET(new Request(`${url}?${query}`));
    assert.equal(response.status, 400, query);
    assert.equal(await responseCode(response), "invalid-limit", query);
    assertPrivateNoStore(response);
  }
  let response = await GET(new Request(`${url}?owner=someone-else`));
  assert.equal(response.status, 400);
  assert.equal(await responseCode(response), "invalid-query");
  assertPrivateNoStore(response);
  const directKeys = [
    "TOSS_DIRECT_API_ENABLED",
    "TOSS_CLIENT_ID",
    "TOSS_CLIENT_SECRET",
    "TOSS_RELAY_URL",
    "TOSS_RELAY_TOKEN",
    "TOSS_RELAY_ACCOUNT_KEY",
  ];
  const previousDirect = environmentSnapshot(directKeys);
  try {
    process.env.TOSS_DIRECT_API_ENABLED = "true";
    process.env.TOSS_CLIENT_ID = "validation-direct-client";
    process.env.TOSS_CLIENT_SECRET = "validation-direct-secret";
    delete process.env.TOSS_RELAY_URL;
    delete process.env.TOSS_RELAY_TOKEN;
    delete process.env.TOSS_RELAY_ACCOUNT_KEY;
    for (const suffix of ["", "?limit=1", "?limit=30"]) {
      response = await GET(new Request(`${url}${suffix}`));
      assert.equal(response.status, 401, suffix || "default limit");
      assert.equal(await responseCode(response), "history-owner-required");
      assertPrivateNoStore(response);
    }
  } finally {
    restoreEnvironment(previousDirect);
  }

  const securityCases = [
    [{}, undefined, 428, "automation-intent-required"],
    [{ "X-LedgerLens-Intent": "CONFIGURE-SNAPSHOT-SCHEDULE" }, undefined, 428, "automation-intent-required"],
    [{ "X-LedgerLens-Intent": "configure-snapshot-schedule" }, undefined, 403, "same-origin-required"],
    [
      {
        "X-LedgerLens-Intent": "configure-snapshot-schedule",
        Origin: "https://attacker.example",
      },
      undefined,
      403,
      "same-origin-required",
    ],
    [
      {
        "X-LedgerLens-Intent": "configure-snapshot-schedule",
        Origin: "https://ledger.example",
        "Sec-Fetch-Site": "cross-site",
      },
      undefined,
      403,
      "same-origin-required",
    ],
  ];
  for (const [headers, body, status, code] of securityCases) {
    response = await PUT(new Request(url, { method: "PUT", headers, body }));
    assert.equal(response.status, status, code);
    assert.equal(await responseCode(response), code);
    assertPrivateNoStore(response);
  }

  const baseHeaders = {
    "X-LedgerLens-Intent": "configure-snapshot-schedule",
    Origin: "https://ledger.example",
  };
  response = await PUT(
    new Request(`${url}?owner=someone-else`, {
      method: "PUT",
      headers: baseHeaders,
    }),
  );
  assert.equal(response.status, 400);
  assert.equal(await responseCode(response), "query-not-allowed");

  const bodyCases = [
    [{ headers: baseHeaders, body: "{}" }, 415, "json-required"],
    [
      { headers: { ...baseHeaders, "Content-Type": "application/json" }, body: "{" },
      400,
      "invalid-json",
    ],
    ...[
      {},
      { enabled: true },
      { enabled: "true", expectedRevision: 0 },
      { enabled: true, expectedRevision: -1 },
      { enabled: true, expectedRevision: 1.5 },
      { enabled: true, expectedRevision: 2_147_483_648 },
      { enabled: true, expectedRevision: 0, ownerId: "owner-b" },
      { enabled: true, expectedRevision: 0, timezone: "UTC" },
    ].map((body) => [
      {
        headers: { ...baseHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      400,
      "invalid-automation-request",
    ]),
    [
      {
        headers: { ...baseHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ padding: "x".repeat(1024) }),
      },
      413,
      "body-too-large",
    ],
  ];
  for (const [init, status, code] of bodyCases) {
    response = await PUT(new Request(url, { method: "PUT", ...init }));
    assert.equal(response.status, status, code);
    assert.equal(await responseCode(response), code);
    assertPrivateNoStore(response);
  }
});

test("demo and Direct schedule enablement stop before D1 and upstream access", async () => {
  const { PUT } = await vite.ssrLoadModule("/app/api/automation/route.ts");
  const keys = [
    "TOSS_DIRECT_API_ENABLED",
    "TOSS_CLIENT_ID",
    "TOSS_CLIENT_SECRET",
    "TOSS_RELAY_URL",
    "TOSS_RELAY_TOKEN",
    "TOSS_RELAY_ACCOUNT_KEY",
  ];
  const previous = environmentSnapshot(keys);
  const originalFetch = globalThis.fetch;
  let databaseReads = 0;
  let upstreamCalls = 0;
  globalThis.__ledgerlensPhase4WorkersEnv = new Proxy(
    {},
    {
      get() {
        databaseReads += 1;
        throw new Error("non-relay enablement must not access D1");
      },
    },
  );
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    throw new Error("non-relay enablement must not access the network");
  };
  const request = () =>
    new Request("https://ledger.example/api/automation", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-LedgerLens-Intent": "configure-snapshot-schedule",
        Origin: "https://ledger.example",
        "oai-authenticated-user-id": "owner-a",
      },
      body: JSON.stringify({ enabled: true, expectedRevision: 0 }),
    });

  try {
    for (const key of keys) delete process.env[key];
    let response = await PUT(request());
    assert.equal(response.status, 409);
    assert.equal(await responseCode(response), "relay-required");

    process.env.TOSS_DIRECT_API_ENABLED = "true";
    process.env.TOSS_CLIENT_ID = "phase-4a-direct-client";
    process.env.TOSS_CLIENT_SECRET = "phase-4a-direct-secret";
    response = await PUT(request());
    assert.equal(response.status, 409);
    assert.equal(await responseCode(response), "relay-required");
    assert.equal(databaseReads, 0);
    assert.equal(upstreamCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.__ledgerlensPhase4WorkersEnv;
    restoreEnvironment(previous);
  }
});

test("public Demo automation status is identity-free and D1-free", async () => {
  const { GET } = await vite.ssrLoadModule("/app/api/automation/route.ts");
  const keys = [
    "TOSS_DIRECT_API_ENABLED",
    "TOSS_CLIENT_ID",
    "TOSS_CLIENT_SECRET",
    "TOSS_RELAY_URL",
    "TOSS_RELAY_TOKEN",
    "TOSS_RELAY_ACCOUNT_KEY",
    "LEDGERLENS_ALLOW_LOCAL_HISTORY",
    "LEDGERLENS_TRUST_PLATFORM_AUTH",
  ];
  const previous = environmentSnapshot(keys);
  let databaseReads = 0;
  globalThis.__ledgerlensPhase4WorkersEnv = new Proxy({}, {
    get() {
      databaseReads += 1;
      throw new Error("Demo automation GET must not access D1");
    },
  });
  try {
    for (const key of keys) delete process.env[key];
    const response = await GET(new Request("https://public.example/api/automation?limit=10"));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.source, "demo");
    assert.equal(body.status, "demo");
    assert.equal(body.canManageSchedule, false);
    assert.deepEqual(body.recentRuns, []);
    assert.equal(databaseReads, 0);
    assertPrivateNoStore(response);
  } finally {
    delete globalThis.__ledgerlensPhase4WorkersEnv;
    restoreEnvironment(previous);
  }
});

test("relay-ready automation exposes revision zero, enables once, and rejects a stale revision", async () => {
  const { GET, PUT } = await vite.ssrLoadModule("/app/api/automation/route.ts");
  let scheduleRow = null;
  const database = {
    prepare(sql) {
      return {
        sql,
        bindings: [],
        bind(...bindings) {
          this.bindings = bindings;
          return this;
        },
        async first() {
          if (/FROM snapshot_schedules/.test(this.sql)) return scheduleRow;
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          if (/INSERT OR IGNORE INTO snapshot_schedules/.test(this.sql)) {
            if (scheduleRow) return { meta: { changes: 0 } };
            const [id, ownerId, accountKey, createdAt, updatedAt] = this.bindings;
            scheduleRow = {
              id,
              ownerId,
              accountKey,
              enabled: 1,
              timezone: "Asia/Seoul",
              localTime: "07:10",
              weekdays: "1,2,3,4,5",
              revision: 1,
              createdAt,
              updatedAt,
              triggerVerifiedAt: null,
            };
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
      };
    },
    async batch(statements) {
      return statements.map(() => ({ meta: { changes: 0 } }));
    },
  };
  const keys = [
    "TOSS_DIRECT_API_ENABLED",
    "TOSS_CLIENT_ID",
    "TOSS_CLIENT_SECRET",
    "TOSS_RELAY_URL",
    "TOSS_RELAY_TOKEN",
    "TOSS_RELAY_ACCOUNT_KEY",
  ];
  const previous = environmentSnapshot(keys);
  globalThis.__ledgerlensPhase4WorkersEnv = { DB: database };
  try {
    process.env.TOSS_RELAY_URL = "https://relay.example/api/relay/portfolio";
    process.env.TOSS_RELAY_TOKEN = RELAY_TOKEN;
    process.env.TOSS_RELAY_ACCOUNT_KEY = RELAY_ACCOUNT_REF;
    delete process.env.TOSS_DIRECT_API_ENABLED;
    delete process.env.TOSS_CLIENT_ID;
    delete process.env.TOSS_CLIENT_SECRET;
    const headers = { "oai-authenticated-user-id": "owner-a" };
    let response = await GET(
      new Request("https://ledger.example/api/automation?limit=30", { headers }),
    );
    assert.equal(response.status, 200);
    assertPrivateNoStore(response);
    let body = await response.json();
    assert.equal(body.source, "relay");
    assert.equal(body.status, "ready");
    assert.equal(body.canManageSchedule, true);
    assert.deepEqual(
      {
        enabled: body.schedule.enabled,
        timezone: body.schedule.timezone,
        localTime: body.schedule.localTime,
        weekdays: body.schedule.weekdays,
        revision: body.schedule.revision,
        triggerVerifiedAt: body.schedule.triggerVerifiedAt,
      },
      {
        enabled: false,
        timezone: "Asia/Seoul",
        localTime: "07:10",
        weekdays: [1, 2, 3, 4, 5],
        revision: 0,
        triggerVerifiedAt: null,
      },
    );

    const putHeaders = {
      "Content-Type": "application/json",
      "X-LedgerLens-Intent": "configure-snapshot-schedule",
      Origin: "https://ledger.example",
      "oai-authenticated-user-id": "owner-a",
    };
    response = await PUT(
      new Request("https://ledger.example/api/automation", {
        method: "PUT",
        headers: putHeaders,
        body: JSON.stringify({ enabled: true, expectedRevision: 0 }),
      }),
    );
    assert.equal(response.status, 200);
    body = await response.json();
    assert.equal(body.updated, true);
    assert.equal(body.schedule.enabled, true);
    assert.equal(body.schedule.revision, 1);

    response = await GET(new Request("https://ledger.example/api/automation", { headers }));
    assert.equal(response.status, 200);
    body = await response.json();
    assert.equal(body.status, "awaiting-trigger");
    assert.equal(body.schedule.triggerVerifiedAt, null);

    scheduleRow = { ...scheduleRow, triggerVerifiedAt: "2000-01-01T00:00:00.000Z" };
    response = await GET(new Request("https://ledger.example/api/automation", { headers }));
    assert.equal(response.status, 200);
    body = await response.json();
    assert.equal(body.status, "degraded");

    scheduleRow = { ...scheduleRow, triggerVerifiedAt: null };

    response = await PUT(
      new Request("https://ledger.example/api/automation", {
        method: "PUT",
        headers: putHeaders,
        body: JSON.stringify({ enabled: false, expectedRevision: 0 }),
      }),
    );
    assert.equal(response.status, 409);
    assert.equal(await responseCode(response), "revision-conflict");
    assertPrivateNoStore(response);
  } finally {
    delete globalThis.__ledgerlensPhase4WorkersEnv;
    restoreEnvironment(previous);
  }
});

test("fixed automation slot maps weekday 07:10 KST to prior-day 22:10 UTC without side effects", async () => {
  const {
    automationScheduledSlot,
    runScheduledCaptures,
    scheduledCaptureIdempotencyKey,
    scheduledCaptureRunId,
  } = await vite.ssrLoadModule("/lib/automation/runner.ts");
  const mondayKst = Date.parse("2026-08-02T22:10:00.000Z");
  assert.equal(automationScheduledSlot(mondayKst)?.toISOString(), "2026-08-02T22:10:00.000Z");

  const calls = [];
  const invalid = await runScheduledCaptures(Date.parse("2026-08-02T22:11:00.000Z"), {
    getEnvironment: () => {
      calls.push("environment");
      throw new Error("invalid slot must stop first");
    },
    resolveAccountKey: async () => {
      calls.push("account");
      throw new Error("invalid slot must not resolve an account");
    },
    loadPortfolio: async () => {
      calls.push("portfolio");
      throw new Error("invalid slot must not load a portfolio");
    },
  });
  assert.deepEqual(invalid, {
    accepted: false,
    scheduledFor: null,
    scheduleCount: 0,
    claimedCount: 0,
    succeededCount: 0,
    failedCount: 0,
    retryableFailureCount: 0,
    terminalFailureCount: 0,
  });
  assert.deepEqual(calls, []);

  for (const source of ["demo", "direct"]) {
    const sourceCalls = [];
    const result = await runScheduledCaptures(mondayKst, {
      getEnvironment: () => ({ source }),
      resolveAccountKey: async () => {
        sourceCalls.push("account");
        throw new Error("non-relay mode must stop before D1/account work");
      },
      loadPortfolio: async () => {
        sourceCalls.push("portfolio");
        throw new Error("non-relay mode must stop before upstream work");
      },
    });
    assert.equal(result.accepted, false);
    assert.deepEqual(sourceCalls, []);
  }

  const key = scheduledCaptureIdempotencyKey("relay:abc123", "2026-08-02T22:10:00.000Z");
  assert.equal(key, "scheduled:v1:2026-08-02T22:10:00.000Z:relay:abc123");
  assert.equal(
    await scheduledCaptureRunId("owner-a", "relay:abc123", "2026-08-02T22:10:00.000Z"),
    await scheduledCaptureRunId("owner-a", "relay:abc123", "2026-08-02T22:10:00.000Z"),
  );
  assert.notEqual(
    await scheduledCaptureRunId("owner-a", "relay:abc123", "2026-08-02T22:10:00.000Z"),
    await scheduledCaptureRunId("owner-a", "relay:different", "2026-08-02T22:10:00.000Z"),
  );
});

test("an existing account-and-slot snapshot completes the run before the relay is called", async () => {
  const accountKey = `relay:${"a".repeat(64)}`;
  const scheduledFor = "2026-08-02T22:10:00.000Z";
  const ownerId = "owner-a";
  const schedule = {
    id: `sas_${"b".repeat(40)}`,
    ownerId,
    accountKey,
    enabled: 1,
    timezone: "Asia/Seoul",
    localTime: "07:10",
    weekdays: "1,2,3,4,5",
    revision: 1,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    triggerVerifiedAt: null,
  };
  const existingSnapshot = {
    id: `ps_${"c".repeat(40)}`,
    capturedAt: "2026-08-02T22:10:10.000Z",
    equityValueKrw: "1000",
    profitLossKrw: "100",
    buyingPowerKrw: "200",
    totalTrackedValueKrw: "1200",
    usdKrwRate: "1382.4",
    holdingCount: 1,
  };
  let runRow = null;
  let relayLoads = 0;
  const observed = [];
  const database = {
    prepare(sql) {
      return {
        sql,
        bindings: [],
        bind(...bindings) {
          this.bindings = bindings;
          return this;
        },
        async all() {
          observed.push({ operation: "all", sql: this.sql, bindings: [...this.bindings] });
          if (/FROM snapshot_schedules/.test(this.sql)) return { results: [schedule] };
          return { results: [] };
        },
        async first() {
          observed.push({ operation: "first", sql: this.sql, bindings: [...this.bindings] });
          if (/FROM snapshot_capture_runs/.test(this.sql)) return runRow;
          if (/FROM portfolio_snapshots/.test(this.sql)) return existingSnapshot;
          return null;
        },
        async run() {
          observed.push({ operation: "run", sql: this.sql, bindings: [...this.bindings] });
          if (/INSERT OR IGNORE INTO snapshot_capture_runs/.test(this.sql)) {
            const [id, storedOwnerId, storedAccountKey, slot, leaseToken, leaseExpiresAt, startedAt, createdAt, updatedAt] = this.bindings;
            runRow = {
              id,
              ownerId: storedOwnerId,
              accountKey: storedAccountKey,
              scheduledFor: slot,
              status: "running",
              attemptCount: 1,
              leaseToken,
              leaseExpiresAt,
              startedAt,
              finishedAt: null,
              snapshotId: null,
              errorCode: null,
              createdAt,
              updatedAt,
            };
            return { meta: { changes: 1 } };
          }
          if (/UPDATE snapshot_capture_runs/.test(this.sql) && /status = 'succeeded'/.test(this.sql)) {
            runRow = {
              ...runRow,
              status: "succeeded",
              finishedAt: this.bindings[0],
              snapshotId: this.bindings[1],
              leaseToken: null,
              leaseExpiresAt: null,
              updatedAt: this.bindings[2],
            };
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 1 } };
        },
      };
    },
    async batch(statements) {
      return statements.map(() => ({ meta: { changes: 0 } }));
    },
  };
  globalThis.__ledgerlensPhase4WorkersEnv = { DB: database };
  try {
    const { runScheduledCaptures } = await vite.ssrLoadModule("/lib/automation/runner.ts");
    const result = await runScheduledCaptures(Date.parse(scheduledFor), {
      now: () => new Date("2026-08-02T22:10:30.000Z"),
      getEnvironment: () => ({ source: "relay" }),
      resolveAccountKey: async () => accountKey,
      loadPortfolio: async () => {
        relayLoads += 1;
        throw new Error("the relay must not be loaded for an existing slot snapshot");
      },
    });
    assert.deepEqual(result, {
      accepted: true,
      scheduledFor,
      scheduleCount: 1,
      claimedCount: 1,
      succeededCount: 1,
      failedCount: 0,
      retryableFailureCount: 0,
      terminalFailureCount: 0,
    });
    assert.equal(relayLoads, 0);
    assert.equal(runRow.status, "succeeded");
    assert.equal(runRow.snapshotId, existingSnapshot.id);
    const enabledRead = observed.find(
      ({ operation, sql }) => operation === "all" && /FROM snapshot_schedules/.test(sql),
    );
    assert.deepEqual(enabledRead.bindings, [accountKey]);
    const snapshotRead = observed.find(
      ({ operation, sql }) => operation === "first" && /FROM portfolio_snapshots/.test(sql),
    );
    assert.deepEqual(snapshotRead.bindings, [
      ownerId,
      `scheduled:v1:${scheduledFor}:${accountKey}`,
    ]);
  } finally {
    delete globalThis.__ledgerlensPhase4WorkersEnv;
  }
});

test("automation storage sanitizes errors and SQL keeps owner/account/slot isolation", async () => {
  const executed = [];
  const database = {
    prepare(sql) {
      return {
        sql,
        bindings: [],
        bind(...bindings) {
          this.bindings = bindings;
          return this;
        },
        async run() {
          executed.push({ sql: this.sql, bindings: [...this.bindings] });
          return { meta: { changes: 1 } };
        },
      };
    },
    async batch(statements) {
      return statements.map(() => ({ meta: { changes: 0 } }));
    },
  };
  globalThis.__ledgerlensPhase4WorkersEnv = { DB: database };
  try {
    const { completeAutomationRunFailure } = await vite.ssrLoadModule(
      "/lib/automation/storage.ts",
    );
    await completeAutomationRunFailure(
      {
        id: "run-1",
        ownerId: "owner-a",
        accountKey: "relay:account-a",
        scheduledFor: "2026-08-02T22:10:00.000Z",
        status: "running",
        attemptCount: 1,
        leaseToken: "lease-1",
        leaseExpiresAt: "2026-08-02T22:11:00.000Z",
        startedAt: "2026-08-02T22:10:00.000Z",
        finishedAt: null,
        snapshotId: null,
        errorCode: null,
        createdAt: "2026-08-02T22:10:00.000Z",
        updatedAt: "2026-08-02T22:10:00.000Z",
      },
      "lease-1",
      "secret=value should never persist",
      true,
      new Date("2026-08-02T22:10:30.000Z"),
    );
    const update = executed.find(({ sql }) => /UPDATE snapshot_capture_runs/.test(sql));
    assert.ok(update);
    assert.equal(update.bindings[2], "automation-run-failed");
    assert.doesNotMatch(JSON.stringify(update.bindings), /secret=value/);
  } finally {
    delete globalThis.__ledgerlensPhase4WorkersEnv;
  }

  const [storage, runner, worker, relayRoute, routeNames] = await Promise.all([
    readFile(new URL("../lib/automation/storage.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/automation/runner.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/relay/portfolio/route.ts", import.meta.url), "utf8"),
    readdir(new URL("../app/api/", import.meta.url), { recursive: true }),
  ]);
  assert.match(
    storage,
    /UNIQUE INDEX IF NOT EXISTS idx_snapshot_capture_runs_owner_account_slot[\s\S]*?owner_id, account_key, scheduled_for/,
  );
  assert.match(storage, /WHERE owner_id = \? AND account_key = \?/);
  assert.match(runner, /findPortfolioSnapshot[\s\S]*?loadPortfolio/);
  assert.ok(
    runner.indexOf("await findPortfolioSnapshot") < runner.indexOf("await dependencies.loadPortfolio"),
    "an existing snapshot must be checked before the relay is loaded",
  );
  assert.doesNotMatch(runner, /cash-?flows?|cashflow/i);
  assert.match(worker, /async scheduled\s*\(/);
  assert.match(worker, /runScheduledCaptures\(controller\.scheduledTime\)/);
  assert.match(worker, /if\s*\(!result\.accepted\)[\s\S]*?controller\.noRetry\(\)/);
  assert.match(worker, /retryableFailureCount\s*>\s*0[\s\S]*?throw new Error/);
  assert.match(worker, /terminalFailureCount\s*>\s*0\)\s*controller\.noRetry\(\)/);
  assert.doesNotMatch(
    relayRoute,
    /export\s+(?:(?:async\s+)?function|const)\s+(?:POST|DELETE|PATCH|PUT)\b/,
  );
  assert.equal(routeNames.some((name) => /(?:^|[\\/])orders?(?:[\\/]|$)/i.test(name)), false);
});
