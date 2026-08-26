import assert from "node:assert/strict";
import "./trusted-platform-auth.mjs";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const mockedWorkersModule = "\0ledgerlens-test-cloudflare-workers-external-assets";
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
        name: "ledgerlens-test-cloudflare-workers-external-assets",
        resolveId(source) {
          if (source === "cloudflare:workers") return mockedWorkersModule;
          return null;
        },
        load(id) {
          if (id === mockedWorkersModule) {
            return `export const env = new Proxy({}, {
              get(_target, key) {
                return globalThis.__ledgerlensExternalAssetsWorkersEnv?.[key];
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
  delete globalThis.__ledgerlensExternalAssetsWorkersEnv;
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

      if (/^\s*UPDATE external_assets/.test(this.sql)) {
        const [
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
          updatedAt,
          id,
          ownerId,
          accountKey,
          expectedRevision,
        ] = this.bindings;
        const existing = assets.get(id);
        if (
          !existing ||
          existing.ownerId !== ownerId ||
          existing.accountKey !== accountKey ||
          existing.revision !== expectedRevision
        ) {
          return { meta: { changes: 0 } };
        }
        assets.set(id, {
          ...existing,
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
          updatedAt,
          revision: expectedRevision + 1,
        });
        return { meta: { changes: 1 } };
      }

      if (/^\s*INSERT OR IGNORE INTO external_asset_snapshots/.test(this.sql)) {
        const [snapshotId, capturedAt, assetId, ownerId, accountKey, revision] = this.bindings;
        const asset = assets.get(assetId);
        const expectedRevision = revision ?? 1;
        if (
          snapshots.has(snapshotId) ||
          !asset ||
          asset.ownerId !== ownerId ||
          asset.accountKey !== accountKey ||
          asset.revision !== expectedRevision
        ) {
          return { meta: { changes: 0 } };
        }
        snapshots.set(snapshotId, {
          ...publicRecord(asset),
          id: snapshotId,
          assetId,
          capturedAt,
          reason: /'created'/.test(this.sql) ? "created" : "updated",
        });
        return { meta: { changes: 1 } };
      }

      return { meta: { changes: 0 } };
    }

    async first() {
      if (!/FROM external_assets/.test(this.sql)) return null;
      if (/idempotency_key = \?/.test(this.sql)) {
        return publicRecord(findByIdempotency(...this.bindings));
      }
      if (/WHERE id = \?/.test(this.sql)) {
        const [id, ownerId, accountKey] = this.bindings;
        const asset = assets.get(id);
        return publicRecord(
          asset && asset.ownerId === ownerId && asset.accountKey === accountKey
            ? asset
            : null,
        );
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
      const results = matching
        .slice(0, limit)
        .map(publicRecord);
      return { results };
    }
  }

  const database = {
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
  return database;
}

const BASE_ASSET = {
  kind: "deposit",
  name: "비상금 예금",
  institution: "OPPD Bank",
  currency: "KRW",
  balance: "900719925474099312345.25",
  valueKrw: "900719925474099312345.25",
  valuedAt: "2026-08-25",
  maturityDate: "2027-08-25",
  annualRatePercent: "3.25",
  note: "  만기 후 재검토  ",
};

test("external-asset validation keeps exact decimals and rejects ambiguous values", async () => {
  const {
    ExternalAssetValidationError,
    parseExternalAssetInput,
    parseExternalAssetUpdate,
  } = await vite.ssrLoadModule("/lib/assets/validation.ts");
  const valid = parseExternalAssetInput(BASE_ASSET);
  assert.deepEqual(valid, { ...BASE_ASSET, note: "만기 후 재검토" });

  const invalid = [
    [{ ...BASE_ASSET, extra: true }, "invalid-body"],
    [{ ...BASE_ASSET, kind: "stock" }, "invalid-kind"],
    [{ ...BASE_ASSET, name: "   " }, "invalid-name"],
    [{ ...BASE_ASSET, currency: "krw" }, "invalid-currency"],
    [{ ...BASE_ASSET, currency: "EUR" }, "invalid-currency"],
    ...["0", "0.0", "01", "1.0", "-1", "+1", "1e3"].map((balance) => [
      { ...BASE_ASSET, balance },
      "invalid-balance",
    ]),
    [{ ...BASE_ASSET, valueKrw: "0" }, "invalid-value-krw"],
    [{ ...BASE_ASSET, valuedAt: "2026-02-29" }, "invalid-valued-at"],
    [{ ...BASE_ASSET, maturityDate: "2026-08-24" }, "invalid-maturity-date"],
    [{ ...BASE_ASSET, annualRatePercent: "100.1" }, "invalid-annual-rate"],
    [{ ...BASE_ASSET, note: "bad\u0000note" }, "invalid-note"],
  ];
  for (const [input, code] of invalid) {
    assert.throws(
      () => parseExternalAssetInput(input),
      (error) => error instanceof ExternalAssetValidationError && error.code === code,
      code,
    );
  }

  assert.throws(
    () =>
      parseExternalAssetUpdate({
        ...valid,
        id: "not-an-asset",
        expectedRevision: 1,
      }),
    (error) => error.code === "invalid-id",
  );
  assert.throws(
    () =>
      parseExternalAssetUpdate({
        ...valid,
        id: `ea_${"a".repeat(40)}`,
        expectedRevision: 0,
      }),
    (error) => error.code === "invalid-revision",
  );
  assert.deepEqual(
    parseExternalAssetUpdate({
      ...valid,
      id: `ea_${"a".repeat(40)}`,
      expectedRevision: 1,
      balance: "0",
      valueKrw: "0",
    }),
    {
      ...valid,
      id: `ea_${"a".repeat(40)}`,
      expectedRevision: 1,
      balance: "0",
      valueKrw: "0",
    },
  );
  assert.throws(
    () => parseExternalAssetUpdate({
      ...valid,
      id: `ea_${"a".repeat(40)}`,
      expectedRevision: 1,
      balance: "0",
    }),
    (error) => error.code === "invalid-zero-balance",
  );
});

test("external-asset storage is idempotent, revision-safe, snapshotted, and exact", async () => {
  const database = createMockDatabase();
  globalThis.__ledgerlensExternalAssetsWorkersEnv = { DB: database };
  const {
    ExternalAssetIdempotencyConflictError,
    ExternalAssetRevisionConflictError,
    createExternalAsset,
    createExternalAssetsPayload,
    listExternalAssets,
    summarizeExternalAssets,
    updateExternalAsset,
  } = await vite.ssrLoadModule("/lib/assets/storage.ts");

  const firstInput = { ...BASE_ASSET, note: "만기 후 재검토" };
  const firstIdentity = {
    ownerId: "owner-123",
    accountKey: "direct:account-a",
    idempotencyKey: "external-asset-0001",
  };
  await assert.rejects(
    createExternalAsset(
      { ...firstInput, valuedAt: "2026-08-26", maturityDate: "2027-08-26" },
      { ...firstIdentity, idempotencyKey: "external-asset-future" },
      new Date("2026-08-25T14:59:59.000Z"),
    ),
    (error) => error.code === "future-valued-at",
  );
  const first = await createExternalAsset(
    firstInput,
    firstIdentity,
    new Date("2026-08-25T01:00:00.000Z"),
  );
  assert.equal(first.created, true);
  assert.equal(first.asset.revision, 1);
  assert.equal(database.snapshots.size, 1);

  const replay = await createExternalAsset(
    firstInput,
    firstIdentity,
    new Date("2026-08-25T02:00:00.000Z"),
  );
  assert.equal(replay.created, false);
  assert.equal(replay.asset.createdAt, first.asset.createdAt);
  assert.equal(database.snapshots.size, 1);
  await assert.rejects(
    createExternalAsset(
      { ...firstInput, note: "different" },
      firstIdentity,
      new Date("2026-08-25T02:00:00.000Z"),
    ),
    (error) => error instanceof ExternalAssetIdempotencyConflictError,
  );

  const cashInput = {
    kind: "cash",
    name: "지갑",
    institution: "",
    currency: "KRW",
    balance: "0.75",
    valueKrw: "0.75",
    valuedAt: "2026-08-25",
    maturityDate: null,
    annualRatePercent: null,
    note: "",
  };
  const cash = await createExternalAsset(
    cashInput,
    {
      ownerId: firstIdentity.ownerId,
      accountKey: firstIdentity.accountKey,
      idempotencyKey: "external-asset-0002",
    },
    new Date("2026-08-25T01:30:00.000Z"),
  );

  const updated = await updateExternalAsset(
    {
      ...firstInput,
      id: first.asset.id,
      expectedRevision: 1,
      balance: "900719925474099312345.5",
      valueKrw: "900719925474099312345.5",
      note: "갱신",
    },
    { ownerId: firstIdentity.ownerId, accountKey: firstIdentity.accountKey },
    new Date("2026-08-25T03:00:00.000Z"),
  );
  assert.equal(updated.updated, true);
  assert.equal(updated.asset.revision, 2);
  assert.equal(database.snapshots.size, 3);
  assert.deepEqual(
    [...database.snapshots.values()]
      .filter((snapshot) => snapshot.assetId === first.asset.id)
      .map((snapshot) => [snapshot.revision, snapshot.valueKrw, snapshot.reason]),
    [
      [1, "900719925474099312345.25", "created"],
      [2, "900719925474099312345.5", "updated"],
    ],
  );

  await assert.rejects(
    updateExternalAsset(
      {
        ...firstInput,
        id: first.asset.id,
        expectedRevision: 1,
      },
      { ownerId: firstIdentity.ownerId, accountKey: firstIdentity.accountKey },
    ),
    (error) =>
      error instanceof ExternalAssetRevisionConflictError && error.actualRevision === 2,
  );
  assert.equal(database.snapshots.size, 3);

  const assets = await listExternalAssets(
    firstIdentity.ownerId,
    firstIdentity.accountKey,
    100,
  );
  const summary = await summarizeExternalAssets(
    firstIdentity.ownerId,
    firstIdentity.accountKey,
  );
  const payload = createExternalAssetsPayload("ready", assets, summary);
  assert.equal(payload.count, 2);
  assert.equal(payload.totalValueKrw, "900719925474099312346.25");
  assert.equal(payload.lastUpdatedAt, "2026-08-25T03:00:00.000Z");

  const limited = await listExternalAssets(
    firstIdentity.ownerId,
    firstIdentity.accountKey,
    1,
  );
  const limitedPayload = createExternalAssetsPayload("ready", limited, summary);
  assert.equal(limitedPayload.assets.length, 1);
  assert.equal(limitedPayload.count, 2);
  assert.equal(limitedPayload.totalValueKrw, "900719925474099312346.25");

  const closed = await updateExternalAsset(
    {
      ...cashInput,
      id: cash.asset.id,
      expectedRevision: 1,
      balance: "0",
      valueKrw: "0",
    },
    { ownerId: firstIdentity.ownerId, accountKey: firstIdentity.accountKey },
    new Date("2026-08-25T04:00:00.000Z"),
  );
  assert.equal(closed.asset.valueKrw, "0");
  assert.equal(closed.asset.revision, 2);
  assert.equal(database.snapshots.size, 4);
  assert.equal(
    (await summarizeExternalAssets(firstIdentity.ownerId, firstIdentity.accountKey))
      .totalValueKrw,
    "900719925474099312345.5",
  );
});

test("external-asset routes enforce write intent and reject demo writes before D1", async () => {
  const { GET, POST, PUT } = await vite.ssrLoadModule(
    "/app/api/external-assets/route.ts",
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
  const throwingDatabase = {
    prepare() {
      throw new Error("D1 must not be accessed in demo mode");
    },
  };
  globalThis.__ledgerlensExternalAssetsWorkersEnv = { DB: throwingDatabase };

  try {
    for (const key of environmentKeys) delete process.env[key];
    const url = "https://ledger.example/api/external-assets";
    const authenticated = { "oai-authenticated-user-id": "owner-123" };

    const demo = await GET(new Request(url, { headers: authenticated }));
    assert.equal(demo.status, 200);
    assert.deepEqual(await demo.json(), {
      status: "demo",
      assets: [],
      count: 0,
      totalValueKrw: "0",
      lastUpdatedAt: null,
    });
    assertPrivateNoStore(demo);

    const localDemo = await GET(new Request("http://localhost:3000/api/external-assets"));
    assert.equal(localDemo.status, 200);
    assert.equal((await localDemo.json()).status, "demo");

    for (const query of ["limit=", "limit=0", "limit=101", "limit=01", "limit=2&limit=3"]) {
      const response = await GET(new Request(`${url}?${query}`, { headers: authenticated }));
      assert.equal(response.status, 400, query);
      assert.equal(await responseCode(response), "invalid-limit", query);
    }

    const missingIntent = await POST(
      new Request(url, { method: "POST", headers: authenticated }),
    );
    assert.equal(missingIntent.status, 428);
    assert.equal(await responseCode(missingIntent), "external-asset-intent-required");

    const missingOrigin = await POST(
      new Request(url, {
        method: "POST",
        headers: {
          ...authenticated,
          "X-LedgerLens-Intent": "create-external-asset",
        },
      }),
    );
    assert.equal(missingOrigin.status, 403);
    assert.equal(await responseCode(missingOrigin), "same-origin-required");

    const missingIdempotency = await POST(
      new Request(url, {
        method: "POST",
        headers: {
          ...authenticated,
          "X-LedgerLens-Intent": "create-external-asset",
          Origin: "https://ledger.example",
        },
      }),
    );
    assert.equal(missingIdempotency.status, 400);
    assert.equal(await responseCode(missingIdempotency), "invalid-idempotency-key");

    const demoCreate = await POST(
      new Request(url, {
        method: "POST",
        headers: {
          ...authenticated,
          "X-LedgerLens-Intent": "create-external-asset",
          Origin: "https://ledger.example",
          "Idempotency-Key": "external-route-0001",
        },
      }),
    );
    assert.equal(demoCreate.status, 409);
    assert.equal(await responseCode(demoCreate), "live-portfolio-required");
    assertPrivateNoStore(demoCreate);

    const demoUpdate = await PUT(
      new Request(url, {
        method: "PUT",
        headers: {
          ...authenticated,
          "X-LedgerLens-Intent": "update-external-asset",
          Origin: "https://ledger.example",
        },
      }),
    );
    assert.equal(demoUpdate.status, 409);
    assert.equal(await responseCode(demoUpdate), "live-portfolio-required");
    assertPrivateNoStore(demoUpdate);
  } finally {
    restoreEnvironment(previous);
  }
});
