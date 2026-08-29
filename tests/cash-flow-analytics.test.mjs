import assert from "node:assert/strict";
import "./trusted-platform-auth.mjs";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const mockedWorkersModule = "\0ledgerlens-test-cloudflare-workers-phase-3";
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
        name: "ledgerlens-test-cloudflare-workers-phase-3",
        resolveId(source) {
          if (source === "cloudflare:workers") return mockedWorkersModule;
          return null;
        },
        load(id) {
          if (id === mockedWorkersModule) {
            return `export const env = new Proxy({}, {
              get(_target, key) {
                return globalThis.__ledgerlensPhase3WorkersEnv?.[key];
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

test("manual cash-flow input accepts only canonical immutable ledger records", async () => {
  const { CashFlowValidationError, parseManualCashFlow } = await vite.ssrLoadModule(
    "/lib/cashflow/validation.ts",
  );
  const now = new Date("2026-08-07T00:05:00.000Z");
  const valid = parseManualCashFlow(
    {
      kind: "contribution",
      amountKrw: "900719925474099312345.25",
      occurredAt: "2026-08-07T09:00:00+09:00",
      note: "  외부 계좌 입금  ",
    },
    now,
  );

  assert.deepEqual(valid, {
    kind: "contribution",
    amountKrw: "900719925474099312345.25",
    occurredAt: "2026-08-07T00:00:00.000Z",
    note: "외부 계좌 입금",
  });

  const invalid = [
    [null, "invalid-body"],
    [{ ...valid, extra: true }, "invalid-body"],
    [{ ...valid, kind: "trade" }, "invalid-kind"],
    [{ ...valid, amountKrw: 1000 }, "invalid-amount"],
    ...["0", "0.0", "01", "1.", "1.0", "-1", "+1", "1e3", "9".repeat(41)].map(
      (amountKrw) => [{ ...valid, amountKrw }, "invalid-amount"],
    ),
    [{ ...valid, occurredAt: "2026-08-07T00:00:00" }, "invalid-occurred-at"],
    [{ ...valid, occurredAt: "2026-02-29T00:00:00.000Z" }, "invalid-occurred-at"],
    [{ ...valid, occurredAt: "2026-02-30T00:00:00.000Z" }, "invalid-occurred-at"],
    [{ ...valid, occurredAt: "2026-04-31T00:00:00.000Z" }, "invalid-occurred-at"],
    [{ ...valid, occurredAt: "2026-08-07T24:00:00.000Z" }, "invalid-occurred-at"],
    [{ ...valid, occurredAt: "2026-08-07T23:60:00.000Z" }, "invalid-occurred-at"],
    [{ ...valid, occurredAt: "2026-08-07T23:59:60.000Z" }, "invalid-occurred-at"],
    [{ ...valid, occurredAt: "2026-08-07T00:00:00+14:01" }, "invalid-occurred-at"],
    [{ ...valid, occurredAt: "2026-08-07T00:10:00.001Z" }, "occurred-at-in-future"],
    [{ ...valid, note: `bad\u0000note` }, "invalid-note"],
    [{ ...valid, note: "가".repeat(201) }, "invalid-note"],
  ];

  for (const [input, code] of invalid) {
    assert.throws(
      () => parseManualCashFlow(input, now),
      (error) => error instanceof CashFlowValidationError && error.code === code,
      code,
    );
  }
});

test("cash-flow idempotency is account-scoped and rejects payload changes after insert races", async () => {
  const existing = {
    id: "cf_existing",
    occurredAt: "2026-08-07T00:00:00.000Z",
    createdAt: "2026-08-07T00:00:01.000Z",
    kind: "contribution",
    amountKrw: "1000",
    note: "external deposit",
  };
  const firstBindings = [];
  const database = {
    prepare(sql) {
      return {
        bindings: [],
        bind(...bindings) {
          this.bindings = bindings;
          return this;
        },
        async run() {
          return { meta: { changes: 0 } };
        },
        async first() {
          if (/FROM cash_flows/.test(sql)) firstBindings.push([...this.bindings]);
          return /FROM cash_flows/.test(sql) ? existing : null;
        },
      };
    },
    async batch(statements) {
      return statements.map(() => ({ meta: { changes: 0 } }));
    },
  };
  globalThis.__ledgerlensPhase3WorkersEnv = { DB: database };

  try {
    const {
      CashFlowIdempotencyConflictError,
      cashFlowPayloadMatches,
      recordCashFlow,
    } = await vite.ssrLoadModule("/lib/cashflow/storage.ts");
    const samePayload = {
      occurredAt: existing.occurredAt,
      kind: existing.kind,
      amountKrw: existing.amountKrw,
      note: existing.note,
    };
    assert.equal(cashFlowPayloadMatches(existing, samePayload), true);
    assert.equal(
      cashFlowPayloadMatches(existing, { ...samePayload, amountKrw: "1001" }),
      false,
    );

    const identity = {
      ownerId: "owner-123",
      accountKey: "direct:account-a",
      idempotencyKey: "cash-flow-race-1234",
    };
    const replay = await recordCashFlow(
      samePayload,
      identity,
      new Date("2026-08-07T00:01:00.000Z"),
    );
    assert.equal(replay.created, false);
    assert.deepEqual(firstBindings.at(-1), [
      identity.ownerId,
      identity.accountKey,
      identity.idempotencyKey,
    ]);

    await assert.rejects(
      recordCashFlow(
        { ...samePayload, note: "different immutable payload" },
        identity,
        new Date("2026-08-07T00:01:00.000Z"),
      ),
      (error) => error instanceof CashFlowIdempotencyConflictError,
    );
  } finally {
    delete globalThis.__ledgerlensPhase3WorkersEnv;
  }
});

test("cash-flow POST enforces explicit intent, same origin, idempotency, JSON, and body bounds", async () => {
  const { POST } = await vite.ssrLoadModule("/app/api/cash-flows/route.ts");
  const url = "https://ledger.example/api/cash-flows";
  const securityCases = [
    [{}, 428, "cash-flow-intent-required"],
    [{ "X-LedgerLens-Intent": "RECORD-CASH-FLOW" }, 428, "cash-flow-intent-required"],
    [{ "X-LedgerLens-Intent": "record-cash-flow" }, 403, "same-origin-required"],
    [
      { "X-LedgerLens-Intent": "record-cash-flow", Origin: "https://attacker.example" },
      403,
      "same-origin-required",
    ],
    [
      {
        "X-LedgerLens-Intent": "record-cash-flow",
        Origin: "https://ledger.example",
        "Sec-Fetch-Site": "cross-site",
      },
      403,
      "same-origin-required",
    ],
    [
      {
        "X-LedgerLens-Intent": "record-cash-flow",
        Origin: "https://ledger.example",
      },
      400,
      "invalid-idempotency-key",
    ],
  ];

  for (const [headers, status, code] of securityCases) {
    const response = await POST(new Request(url, { method: "POST", headers }));
    assert.equal(response.status, status);
    assert.equal(await responseCode(response), code);
    assertPrivateNoStore(response);
  }

  const environmentKeys = [
    "TOSS_DIRECT_API_ENABLED",
    "TOSS_CLIENT_ID",
    "TOSS_CLIENT_SECRET",
    "TOSS_RELAY_URL",
    "TOSS_RELAY_TOKEN",
  ];
  const previous = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  try {
    process.env.TOSS_DIRECT_API_ENABLED = "true";
    process.env.TOSS_CLIENT_ID = "phase-3-test-client";
    process.env.TOSS_CLIENT_SECRET = "phase-3-test-secret";
    delete process.env.TOSS_RELAY_URL;
    delete process.env.TOSS_RELAY_TOKEN;

    const baseHeaders = {
      "X-LedgerLens-Intent": "record-cash-flow",
      Origin: "https://ledger.example",
      "Idempotency-Key": "cash-flow-test-1234",
      "oai-authenticated-user-id": "owner-123",
    };
    const bodyCases = [
      [{ headers: baseHeaders, body: "{}" }, 415, "json-required"],
      [
        { headers: { ...baseHeaders, "Content-Type": "application/json" }, body: "{" },
        400,
        "invalid-json",
      ],
      [
        {
          headers: { ...baseHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "contribution",
            amountKrw: "0",
            occurredAt: "2026-08-07T00:00:00.000Z",
            note: "",
          }),
        },
        400,
        "invalid-amount",
      ],
      [
        {
          headers: { ...baseHeaders, "Content-Type": "application/json" },
          body: `{"padding":"${"x".repeat(4096)}"}`,
        },
        413,
        "body-too-large",
      ],
    ];

    for (const [init, status, code] of bodyCases) {
      const response = await POST(new Request(url, { method: "POST", ...init }));
      assert.equal(response.status, status, code);
      assert.equal(await responseCode(response), code);
      assertPrivateNoStore(response);
    }
  } finally {
    restoreEnvironment(previous);
  }
});

test("demo cash-flow writes are refused before D1 access", async () => {
  const { POST } = await vite.ssrLoadModule("/app/api/cash-flows/route.ts");
  const environmentKeys = [
    "TOSS_DIRECT_API_ENABLED",
    "TOSS_CLIENT_ID",
    "TOSS_CLIENT_SECRET",
    "TOSS_RELAY_URL",
    "TOSS_RELAY_TOKEN",
  ];
  const previous = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  try {
    for (const key of environmentKeys) delete process.env[key];
    const response = await POST(
      new Request("https://ledger.example/api/cash-flows", {
        method: "POST",
        headers: {
          "X-LedgerLens-Intent": "record-cash-flow",
          Origin: "https://ledger.example",
          "Idempotency-Key": "cash-flow-demo-1234",
          "oai-authenticated-user-id": "owner-123",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          kind: "contribution",
          amountKrw: "1000000",
          occurredAt: "2026-08-07T00:00:00.000Z",
          note: "demo must never persist",
        }),
      }),
    );
    assert.equal(response.status, 409);
    assert.equal(await responseCode(response), "live-portfolio-required");
    assertPrivateNoStore(response);
  } finally {
    restoreEnvironment(previous);
  }
});

test("public Demo cash-flow and analytics reads require neither identity nor D1", async () => {
  const [{ GET: getCashFlows }, { GET: getAnalytics }] = await Promise.all([
    vite.ssrLoadModule("/app/api/cash-flows/route.ts"),
    vite.ssrLoadModule("/app/api/analytics/route.ts"),
  ]);
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
    let response = await getCashFlows(new Request("https://public.example/api/cash-flows?limit=30"));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { cashFlows: [], count: 0 });
    assertPrivateNoStore(response);

    response = await getAnalytics(new Request("https://public.example/api/analytics?limit=30"));
    assert.equal(response.status, 200);
    const analytics = await response.json();
    assert.equal(analytics.status, "demo");
    assert.equal(analytics.period, null);
    assert.equal(analytics.metrics, null);
    assertPrivateNoStore(response);
  } finally {
    restoreEnvironment(previous);
  }
});

test("cash-flow and analytics limits accept only one canonical bounded integer", async () => {
  const [{ GET: getCashFlows }, { GET: getAnalytics }] = await Promise.all([
    vite.ssrLoadModule("/app/api/cash-flows/route.ts"),
    vite.ssrLoadModule("/app/api/analytics/route.ts"),
  ]);
  const invalidCommon = ["limit=", "limit=0", "limit=366", "limit=01", "limit=1.5", "limit=2&limit=3"];
  for (const query of invalidCommon) {
    for (const handler of [getCashFlows, getAnalytics]) {
      const response = await handler(new Request(`https://ledger.example/api/test?${query}`));
      assert.equal(response.status, 400, query);
      assert.equal(await responseCode(response), "invalid-limit", query);
      assertPrivateNoStore(response);
    }
  }
  const analyticsOne = await getAnalytics(
    new Request("https://ledger.example/api/analytics?limit=1"),
  );
  assert.equal(analyticsOne.status, 400);
  assert.equal(await responseCode(analyticsOne), "invalid-limit");
});

test("Modified Dietz fixtures use tracked value, signed external flows, and exact decimals", async () => {
  const { calculateModifiedDietzMetrics } = await vite.ssrLoadModule(
    "/lib/analytics/calculate.ts",
  );
  const snapshots = [
    {
      id: "end",
      capturedAt: "2026-01-11T00:00:00.000Z",
      totalTrackedValueKrw: "1170",
      equityValueKrw: "999999999",
    },
    {
      id: "start",
      capturedAt: "2026-01-01T00:00:00.000Z",
      totalTrackedValueKrw: "1000",
      equityValueKrw: "1",
    },
  ];
  const cashFlows = [
    {
      id: "included-contribution",
      occurredAt: "2026-01-06T00:00:00.000Z",
      createdAt: "2026-01-06T00:00:01.000Z",
      kind: "contribution",
      amountKrw: "100",
      note: "external deposit",
    },
    {
      id: "included-withdrawal",
      occurredAt: "2026-01-09T00:00:00.000Z",
      createdAt: "2026-01-09T00:00:01.000Z",
      kind: "withdrawal",
      amountKrw: "50",
      note: "external withdrawal",
    },
    {
      id: "excluded-start-boundary",
      occurredAt: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:01.000Z",
      kind: "contribution",
      amountKrw: "500",
      note: "already reflected in start value",
    },
    {
      id: "excluded-after-period",
      occurredAt: "2026-01-12T00:00:00.000Z",
      createdAt: "2026-01-12T00:00:01.000Z",
      kind: "withdrawal",
      amountKrw: "900",
      note: "outside period",
    },
  ];

  assert.deepEqual(calculateModifiedDietzMetrics(snapshots, cashFlows), {
    startTrackedValueKrw: "1000",
    endTrackedValueKrw: "1170",
    grossChangeKrw: "170",
    contributionsKrw: "100",
    withdrawalsKrw: "50",
    netCashFlowKrw: "50",
    adjustedGainKrw: "120",
    modifiedDietzReturn: "0.115384615385",
    flowCount: 2,
  });

  const zeroDenominator = calculateModifiedDietzMetrics(
    [
      { id: "zero", capturedAt: "2026-01-01T00:00:00.000Z", totalTrackedValueKrw: "0" },
      { id: "ten", capturedAt: "2026-01-02T00:00:00.000Z", totalTrackedValueKrw: "10" },
    ],
    [],
  );
  assert.equal(zeroDenominator.adjustedGainKrw, "10");
  assert.equal(zeroDenominator.modifiedDietzReturn, null);
});

test("Phase 3 storage is exact, indexed, immutable, and no-store", async () => {
  const [schema, storage, cashRoute, analyticsRoute, page, readmeKo, migrationNames] =
    await Promise.all([
      readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
      readFile(new URL("../lib/cashflow/storage.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/cash-flows/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/analytics/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
      readFile(new URL("../README.md", import.meta.url), "utf8"),
      readdir(new URL("../drizzle/", import.meta.url)),
    ]);
  const sqlNames = migrationNames.filter((name) => name.endsWith(".sql")).sort();
  const migration = (
    await Promise.all(
      sqlNames.map((name) => readFile(new URL(`../drizzle/${name}`, import.meta.url), "utf8")),
    )
  ).join("\n");

  assert.match(migration, /CREATE TABLE [`"]cash_flows[`"]/i);
  assert.match(migration, /[`"]amount_krw[`"]\s+text\s+NOT NULL/i);
  assert.doesNotMatch(migration, /\b(?:real|double|float)\b/i);
  assert.doesNotMatch(schema, /\breal\s*\(/);
  assert.match(
    migration,
    /CREATE UNIQUE INDEX [`"]idx_cash_flows_owner_account_idempotency[`"].*\([`"]owner_id[`"],[`"]account_key[`"],[`"]idempotency_key[`"]\)/is,
  );
  assert.match(migration, /DROP INDEX [`"]idx_cash_flows_owner_idempotency[`"]/i);
  assert.match(
    migration,
    /CREATE INDEX [`"]idx_cash_flows_owner_account_occurred[`"].*\([`"]owner_id[`"],[`"]account_key[`"],[`"]occurred_at[`"]\)/is,
  );
  assert.match(
    migration,
    /CHECK\s*\([^)]*[`"]kind[`"] IN \('contribution', 'withdrawal'\)\)/i,
  );
  assert.match(migration, /CHECK\s*\([^)]*[`"]source[`"] = 'manual'\)/i);

  assert.match(storage, /INSERT OR IGNORE INTO cash_flows/);
  assert.match(
    storage,
    /WHERE owner_id = \? AND account_key = \? AND idempotency_key = \?/,
  );
  assert.match(storage, /CashFlowIdempotencyConflictError/);
  assert.doesNotMatch(storage, /\b(?:UPDATE|DELETE)\s+(?:FROM\s+)?cash_flows\b/i);
  assert.doesNotMatch(
    cashRoute,
    /export\s+(?:(?:async\s+)?function|const)\s+(?:DELETE|PATCH|PUT)\b/,
  );
  assert.doesNotMatch(
    analyticsRoute,
    /export\s+(?:(?:async\s+)?function|const)\s+(?:POST|DELETE|PATCH|PUT)\b/,
  );

  for (const route of [cashRoute, analyticsRoute]) {
    assert.match(route, /Cache-Control["']?:\s*["']private, no-store, max-age=0["']/);
    assert.match(route, /Cloudflare-CDN-Cache-Control["']?:\s*["']no-store["']/);
  }

  assert.doesNotMatch(page, /\b(?:TWR|XIRR)\b/i);
  assert.match(page, /추적 자산 기준 Modified Dietz 추정치/);
  assert.match(page, /외부 사이의 입출금만 기록/);
  assert.match(page, /주식 매매나 계좌 안의 환전은 현금흐름이 아니/);
  assert.match(analyticsRoute, /매매와 환전은 현금 흐름으로 기록하지 마세요/);
  assert.match(analyticsRoute, /주문 가능 금액을 실제 현금 잔액과 같다고 볼 수 없습니다/);
  assert.match(readmeKo, /계좌 바깥에서 들어온 입금/);
  assert.match(readmeKo, /종목 매매/);
  assert.match(readmeKo, /환전/);
  assert.match(readmeKo, /추적 자산 기준 기간 추정치/);
});
