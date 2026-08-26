import assert from "node:assert/strict";
import "./trusted-platform-auth.mjs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const mockedWorkersModule = "\0ledgerlens-test-cloudflare-workers-external-assets-csv";
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
        name: "ledgerlens-test-cloudflare-workers-external-assets-csv",
        resolveId(source) {
          if (source === "cloudflare:workers") return mockedWorkersModule;
          return null;
        },
        load(id) {
          if (id === mockedWorkersModule) {
            return `export const env = new Proxy({}, {
              get(_target, key) {
                return globalThis.__ledgerlensExternalAssetsCsvWorkersEnv?.[key];
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
  delete globalThis.__ledgerlensExternalAssetsCsvWorkersEnv;
  await vite?.close();
});

const ENVIRONMENT_KEYS = [
  "TOSS_DIRECT_API_ENABLED",
  "TOSS_CLIENT_ID",
  "TOSS_CLIENT_SECRET",
  "TOSS_ACCOUNT_SEQ",
  "TOSS_RELAY_URL",
  "TOSS_RELAY_TOKEN",
  "TOSS_RELAY_ACCOUNT_KEY",
];

const BASE_ASSET = {
  kind: "deposit",
  name: "=SUM(1,2)",
  institution: "'OPPD Bank",
  currency: "KRW",
  balance: "900719925474099312345.25",
  valueKrw: "900719925474099312345.25",
  valuedAt: "2020-08-25",
  maturityDate: "2027-08-25",
  annualRatePercent: "3.25",
  note: "@검토, 다음 줄\r\n\"인용\"",
};

function restoreEnvironment(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function clearPortfolioEnvironment() {
  for (const key of ENVIRONMENT_KEYS) delete process.env[key];
}

function configureRelayEnvironment() {
  clearPortfolioEnvironment();
  process.env.TOSS_RELAY_URL = "https://relay.example";
  process.env.TOSS_RELAY_TOKEN = "t".repeat(32);
  process.env.TOSS_RELAY_ACCOUNT_KEY = "csv-test-account";
}

function assertPrivateNoStore(response) {
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(response.headers.get("cloudflare-cdn-cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
}

async function responseCode(response) {
  return (await response.json()).error?.code;
}

function createMockDatabase() {
  const assets = new Map();
  const snapshots = new Map();

  function findByIdempotency(ownerId, accountKey, idempotencyKey) {
    return [...assets.values()].find(
      (asset) =>
        asset.ownerId === ownerId &&
        asset.accountKey === accountKey &&
        asset.idempotencyKey === idempotencyKey,
    );
  }

  function publicRecord(asset) {
    if (!asset) return null;
    return structuredClone({
      id: asset.id,
      kind: asset.kind,
      name: asset.name,
      institution: asset.institution,
      currency: asset.currency,
      balance: asset.balance,
      valueKrw: asset.valueKrw,
      valuedAt: asset.valuedAt,
      maturityDate: asset.maturityDate,
      annualRatePercent: asset.annualRatePercent,
      note: asset.note,
      source: asset.source,
      revision: asset.revision,
      createdAt: asset.createdAt,
      updatedAt: asset.updatedAt,
    });
  }

  class Statement {
    constructor(sql) {
      this.sql = sql;
      this.bindings = [];
    }

    bind(...bindings) {
      this.bindings = bindings;
      return this;
    }

    async run() {
      if (/^\s*INSERT OR IGNORE INTO external_assets \(/.test(this.sql)) {
        const [
          id,
          ownerId,
          accountKey,
          idempotencyKey,
          kind,
          name,
          institution,
          currency,
          balance,
          valueKrw,
          valuedAt,
          maturityDate,
          annualRatePercent,
          note,
          createdAt,
          updatedAt,
        ] = this.bindings;
        if (assets.has(id) || findByIdempotency(ownerId, accountKey, idempotencyKey)) {
          return { meta: { changes: 0 } };
        }
        assets.set(id, {
          id,
          ownerId,
          accountKey,
          idempotencyKey,
          kind,
          name,
          institution,
          currency,
          balance,
          valueKrw,
          valuedAt,
          maturityDate,
          annualRatePercent,
          note,
          source: "manual",
          revision: 1,
          createdAt,
          updatedAt,
        });
        return { meta: { changes: 1 } };
      }

      if (/^\s*INSERT OR IGNORE INTO external_asset_snapshots/.test(this.sql)) {
        const [snapshotId, capturedAt, assetId, ownerId, accountKey] = this.bindings;
        const asset = assets.get(assetId);
        if (
          snapshots.has(snapshotId) ||
          !asset ||
          asset.ownerId !== ownerId ||
          asset.accountKey !== accountKey ||
          asset.revision !== 1
        ) {
          return { meta: { changes: 0 } };
        }
        snapshots.set(snapshotId, { assetId, capturedAt, revision: 1 });
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }

    async first() {
      if (!/FROM external_assets/.test(this.sql)) return null;
      if (/idempotency_key = \?/.test(this.sql)) {
        return publicRecord(findByIdempotency(...this.bindings));
      }
      return null;
    }

    async all() {
      if (!/FROM external_assets/.test(this.sql)) return { results: [] };
      const [ownerId, accountKey, limit] = this.bindings;
      const matching = [...assets.values()]
        .filter((asset) => asset.ownerId === ownerId && asset.accountKey === accountKey)
        .sort(
          (left, right) =>
            right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id),
        );
      if (!/LIMIT \?/.test(this.sql)) {
        return {
          results: matching.map((asset) => ({
            valueKrw: asset.valueKrw,
            updatedAt: asset.updatedAt,
          })),
        };
      }
      return { results: matching.slice(0, limit).map(publicRecord) };
    }
  }

  return {
    assets,
    snapshots,
    prepare(sql) {
      return new Statement(sql);
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
}

test("CSV export/import is exact, RFC4180-safe, formula-safe, and reversible", async () => {
  const {
    createExternalAssetCsvIdempotencyKey,
    parseExternalAssetsCsv,
    serializeExternalAssetsCsv,
  } = await vite.ssrLoadModule("/lib/assets/csv.ts");
  const closed = {
    ...BASE_ASSET,
    kind: "cash",
    name: "+종료 자산",
    institution: "",
    balance: "0",
    valueKrw: "0",
    maturityDate: null,
    annualRatePercent: null,
    note: "",
  };
  const csv = serializeExternalAssetsCsv([BASE_ASSET, BASE_ASSET, closed]);

  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.match(csv, /\r\n/);
  assert.match(csv, /"'=SUM\(1,2\)"/);
  assert.match(csv, /"''OPPD Bank"/);
  assert.doesNotMatch(csv, /,"=SUM\(1,2\)",/);

  const preview = parseExternalAssetsCsv(csv, new Date("2026-08-25T01:00:00.000Z"));
  assert.equal(preview.rowCount, 3);
  assert.equal(preview.totalValueKrw, "1801439850948198624690.5");
  assert.deepEqual(preview.rows.map((row) => row.input), [
    BASE_ASSET,
    BASE_ASSET,
    closed,
  ]);
  assert.equal(preview.kindCounts.deposit, 2);
  assert.equal(preview.kindCounts.cash, 1);
  assert.match(preview.warnings.join(" "), /수식 실행 방지/);
  assert.match(preview.warnings.join(" "), /반복 행 1건/);
  assert.match(preview.warnings.join(" "), /종료 자산 1건/);

  const firstKey = await createExternalAssetCsvIdempotencyKey(preview.rows[0]);
  assert.equal(firstKey, await createExternalAssetCsvIdempotencyKey(preview.rows[0]));
  assert.notEqual(firstKey, await createExternalAssetCsvIdempotencyKey(preview.rows[1]));
  assert.match(firstKey, /^csv:[a-f0-9]{64}$/);
});

test("public external-asset CSV fixture is valid and unmistakably Demo data", async () => {
  const { parseExternalAssetsCsv } = await vite.ssrLoadModule("/lib/assets/csv.ts");
  const csv = await readFile(
    new URL("../examples/external-assets.demo.csv", import.meta.url),
    "utf8",
  );
  const preview = parseExternalAssetsCsv(csv, new Date("2026-08-25T01:00:00.000Z"));

  assert.equal(preview.rowCount, 3);
  assert.equal(preview.totalValueKrw, "25000000");
  assert.ok(preview.rows.every((row) => row.input.name.startsWith("[DEMO]")));
  assert.ok(preview.rows.every((row) => row.input.note === "가상 데이터"));
});

test("CSV parser rejects malformed, malicious, ambiguous, and oversized input", async () => {
  const {
    EXTERNAL_ASSET_CSV_COLUMNS,
    ExternalAssetCsvError,
    parseExternalAssetsCsv,
    serializeExternalAssetsCsv,
  } = await vite.ssrLoadModule("/lib/assets/csv.ts");
  const header = EXTERNAL_ASSET_CSV_COLUMNS.map((column) => `"${column}"`).join(",");
  const row = serializeExternalAssetsCsv([
    { ...BASE_ASSET, name: "plain", institution: "bank", note: "" },
  ])
    .slice(1)
    .split("\r\n")[1];
  const expectCode = (text, code) => {
    assert.throws(
      () => parseExternalAssetsCsv(text, new Date("2026-08-25T01:00:00.000Z")),
      (error) => error instanceof ExternalAssetCsvError && error.code === code,
      code,
    );
  };

  expectCode("", "empty-csv");
  expectCode(`${header}\r\n${row}\u0000\r\n`, "csv-nul-character");
  expectCode(
    `${header.replace('"name"', '"kind"')}\r\n${row}\r\n`,
    "duplicate-csv-header",
  );
  expectCode(
    `${header.replace('"kind","name"', '"name","kind"')}\r\n${row}\r\n`,
    "invalid-csv-header",
  );
  expectCode(`${header}\r\n${row},"extra"\r\n`, "invalid-csv-column-count");
  expectCode(`${header}\r\nplain"broken,rest\r\n`, "malformed-csv");
  expectCode(`${header}\r\n"unclosed`, "malformed-csv");
  expectCode(`${header}\r${row}`, "malformed-csv");
  expectCode(
    `${header}\r\n${row
      .replace('"2020-08-25"', '"2999-01-01"')
      .replace('"2027-08-25"', '"2999-12-31"')}\r\n`,
    "future-valued-at",
  );
  expectCode(
    `${header}\r\n${Array.from({ length: 251 }, () => row).join("\r\n")}\r\n`,
    "csv-row-limit-exceeded",
  );
});

test("CSV routes enforce authorization, media, size, demo safety, and no-store", async () => {
  const [{ POST }, { GET }, csvModule] = await Promise.all([
    vite.ssrLoadModule("/app/api/external-assets/import/route.ts"),
    vite.ssrLoadModule("/app/api/external-assets/export/route.ts"),
    vite.ssrLoadModule("/lib/assets/csv.ts"),
  ]);
  const previous = Object.fromEntries(
    ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
  );
  globalThis.__ledgerlensExternalAssetsCsvWorkersEnv = {
    DB: {
      prepare() {
        throw new Error("D1 must not be accessed in demo or preview mode");
      },
    },
  };
  const csv = csvModule.serializeExternalAssetsCsv([
    { ...BASE_ASSET, name: "preview", institution: "bank", note: "" },
  ]);
  const url = "https://ledger.example/api/external-assets/import";
  const baseHeaders = {
    "Content-Type": "text/csv; charset=UTF-8",
    "X-LedgerLens-Intent": "import-external-assets",
    Origin: "https://ledger.example",
  };

  try {
    clearPortfolioEnvironment();
    const missingIntent = await POST(
      new Request(`${url}?dryRun=true`, {
        method: "POST",
        headers: { "Content-Type": "text/csv", Origin: "https://ledger.example" },
        body: csv,
      }),
    );
    assert.equal(missingIntent.status, 428);
    assert.equal(await responseCode(missingIntent), "external-asset-import-intent-required");

    const wrongOrigin = await POST(
      new Request(`${url}?dryRun=true`, {
        method: "POST",
        headers: { ...baseHeaders, Origin: "https://attacker.example" },
        body: csv,
      }),
    );
    assert.equal(wrongOrigin.status, 403);
    assert.equal(await responseCode(wrongOrigin), "same-origin-required");

    const preview = await POST(
      new Request(`${url}?dryRun=true`, {
        method: "POST",
        headers: baseHeaders,
        body: csv,
      }),
    );
    assert.equal(preview.status, 200);
    const previewBody = await preview.json();
    assert.equal(previewBody.status, "preview");
    assert.equal(previewBody.rowCount, 1);
    assert.equal(previewBody.totalValueKrw, BASE_ASSET.valueKrw);
    assertPrivateNoStore(preview);

    const missingKey = await POST(
      new Request(url, { method: "POST", headers: baseHeaders, body: csv }),
    );
    assert.equal(missingKey.status, 400);
    assert.equal(await responseCode(missingKey), "invalid-idempotency-key");

    const demoCommit = await POST(
      new Request(url, {
        method: "POST",
        headers: { ...baseHeaders, "Idempotency-Key": "csv-import-0001" },
        body: csv,
      }),
    );
    assert.equal(demoCommit.status, 409);
    assert.equal(await responseCode(demoCommit), "live-portfolio-required");

    const wrongMedia = await POST(
      new Request(`${url}?dryRun=true`, {
        method: "POST",
        headers: { ...baseHeaders, "Content-Type": "application/csv" },
        body: csv,
      }),
    );
    assert.equal(wrongMedia.status, 415);
    assert.equal(await responseCode(wrongMedia), "csv-required");

    const wrongCharset = await POST(
      new Request(`${url}?dryRun=true`, {
        method: "POST",
        headers: { ...baseHeaders, "Content-Type": "text/csv; charset=euc-kr" },
        body: csv,
      }),
    );
    assert.equal(wrongCharset.status, 415);
    assert.equal(await responseCode(wrongCharset), "utf8-csv-required");

    const oversized = await POST(
      new Request(`${url}?dryRun=true`, {
        method: "POST",
        headers: baseHeaders,
        body: new Uint8Array(csvModule.EXTERNAL_ASSET_CSV_MAX_BYTES + 1),
      }),
    );
    assert.equal(oversized.status, 413);
    assert.equal(await responseCode(oversized), "csv-too-large");

    const invalidUtf8 = await POST(
      new Request(`${url}?dryRun=true`, {
        method: "POST",
        headers: baseHeaders,
        body: new Uint8Array([0xff]),
      }),
    );
    assert.equal(invalidUtf8.status, 400);
    assert.equal(await responseCode(invalidUtf8), "invalid-csv-encoding");

    const invalidDryRun = await POST(
      new Request(`${url}?dryRun=yes`, {
        method: "POST",
        headers: baseHeaders,
        body: csv,
      }),
    );
    assert.equal(invalidDryRun.status, 400);
    assert.equal(await responseCode(invalidDryRun), "invalid-dry-run");

    const exported = await GET(
      new Request("https://ledger.example/api/external-assets/export"),
    );
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get("content-type"), /^text\/csv; charset=utf-8/);
    assert.match(exported.headers.get("content-disposition"), /^attachment;/);
    assert.deepEqual(
      [...new Uint8Array(await exported.arrayBuffer()).slice(0, 3)],
      [0xef, 0xbb, 0xbf],
    );
    assertPrivateNoStore(exported);
  } finally {
    restoreEnvironment(previous);
  }
});

test("confirmed CSV import creates once, replays across request keys, and exports all rows", async () => {
  const [{ POST }, { GET }, csvModule] = await Promise.all([
    vite.ssrLoadModule("/app/api/external-assets/import/route.ts"),
    vite.ssrLoadModule("/app/api/external-assets/export/route.ts"),
    vite.ssrLoadModule("/lib/assets/csv.ts"),
  ]);
  const previous = Object.fromEntries(
    ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
  );
  const database = createMockDatabase();
  globalThis.__ledgerlensExternalAssetsCsvWorkersEnv = { DB: database };
  const closed = {
    ...BASE_ASSET,
    kind: "cash",
    name: "closed",
    institution: "",
    balance: "0",
    valueKrw: "0",
    maturityDate: null,
    annualRatePercent: null,
    note: "",
  };
  const csv = csvModule.serializeExternalAssetsCsv([
    { ...BASE_ASSET, name: "live", institution: "bank", note: "" },
    closed,
  ]);
  const url = "https://ledger.example/api/external-assets/import";
  const headers = {
    "Content-Type": "text/csv",
    "X-LedgerLens-Intent": "import-external-assets",
    Origin: "https://ledger.example",
    "oai-authenticated-user-id": "owner-csv-test",
  };

  try {
    configureRelayEnvironment();
    const first = await POST(
      new Request(url, {
        method: "POST",
        headers: { ...headers, "Idempotency-Key": "csv-request-0001" },
        body: csv,
      }),
    );
    assert.equal(first.status, 201);
    const firstBody = await first.json();
    assert.equal(firstBody.status, "imported");
    assert.equal(firstBody.rowCount, 2);
    assert.equal(firstBody.createdCount, 2);
    assert.equal(firstBody.replayedCount, 0);
    assert.equal(firstBody.payload.count, 2);
    assert.equal(firstBody.payload.totalValueKrw, BASE_ASSET.valueKrw);
    assert.equal(database.assets.size, 2);
    assert.equal(database.snapshots.size, 2);

    const replay = await POST(
      new Request(url, {
        method: "POST",
        headers: { ...headers, "Idempotency-Key": "csv-request-0002" },
        body: csv,
      }),
    );
    assert.equal(replay.status, 200);
    const replayBody = await replay.json();
    assert.equal(replayBody.createdCount, 0);
    assert.equal(replayBody.replayedCount, 2);
    assert.equal(database.assets.size, 2);
    assert.equal(database.snapshots.size, 2);

    const exported = await GET(
      new Request("https://ledger.example/api/external-assets/export", {
        headers: { "oai-authenticated-user-id": "owner-csv-test" },
      }),
    );
    assert.equal(exported.status, 200);
    const roundTrip = csvModule.parseExternalAssetsCsv(
      await exported.text(),
      new Date("2026-08-25T01:00:00.000Z"),
    );
    assert.equal(roundTrip.rowCount, 2);
    assert.deepEqual(
      new Set(roundTrip.rows.map((row) => row.input.name)),
      new Set(["live", "closed"]),
    );

    const template = [...database.assets.values()][0];
    for (let index = 1; database.assets.size <= 250; index += 1) {
      const id = `ea_${index.toString(16).padStart(40, "0")}`;
      if (!database.assets.has(id)) {
        database.assets.set(id, {
          ...template,
          id,
          idempotencyKey: `seed-${index}`,
        });
      }
    }
    const overLimit = await GET(
      new Request("https://ledger.example/api/external-assets/export", {
        headers: { "oai-authenticated-user-id": "owner-csv-test" },
      }),
    );
    assert.equal(overLimit.status, 409);
    assert.equal(
      await responseCode(overLimit),
      "external-asset-export-limit-exceeded",
    );
  } finally {
    restoreEnvironment(previous);
  }
});

test("CSV source contracts keep reads bounded and row idempotency content-derived", async () => {
  const [storage, importRoute, exportRoute] = await Promise.all([
    readFile(new URL("../lib/assets/storage.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../app/api/external-assets/import/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/api/external-assets/export/route.ts", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(
    storage,
    /listExternalAssetsForExport[\s\S]*WHERE owner_id = \? AND account_key = \?|listExternalAssetsForExport[\s\S]*prepare\(LIST_EXTERNAL_ASSETS\)/,
  );
  assert.match(storage, /requireBulkLimit\(limit\)/);
  assert.match(exportRoute, /EXTERNAL_ASSET_CSV_MAX_ROWS \+ 1/);
  assert.match(importRoute, /createExternalAssetCsvIdempotencyKey\(row\)/);
  assert.match(importRoute, /Promise\.all\([\s\S]*preview\.rows\.map/);
  assert.doesNotMatch(importRoute, /idempotencyKey:\s*request\.headers/);
  assert.match(importRoute, /same CSV[\s\S]*replays completed inserts|same canonical rows/);
});
