import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const mockedWorkersModule = "\0ledgerlens-test-cloudflare-workers-capital-plan";
let vite;

before(async () => {
  vite = await createServer({
    root,
    configFile: false,
    appType: "custom",
    logLevel: "silent",
    resolve: { alias: [{ find: "@", replacement: root }] },
    plugins: [{
      name: "ledgerlens-test-cloudflare-workers-capital-plan",
      resolveId(source) {
        return source === "cloudflare:workers" ? mockedWorkersModule : null;
      },
      load(id) {
        if (id === mockedWorkersModule) {
          return "export const env = globalThis.__ledgerlensCapitalPlanWorkersEnv ?? {};";
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

test("capital plans preserve exact money and require weights to total 100%", async () => {
  const { CapitalPlanValidationError, parseCapitalPlan } = await vite.ssrLoadModule(
    "/lib/planning/validation.ts",
  );
  const valid = {
    startAssetKrw: "125000000.125",
    targetAssetKrw: "500000000.25",
    startDate: "2026-08-19",
    targetDate: "2036-08-19",
    monthlyContributionKrw: "2500000",
    targetKrWeight: "0.45",
    targetUsWeight: "0.45",
    targetCashWeight: "0.1",
    expectedRevision: 0,
  };
  assert.deepEqual(parseCapitalPlan({ ...valid, targetCashWeight: "0.10" }), valid);

  for (const input of [
    { ...valid, targetAssetKrw: 500000000 },
    { ...valid, targetAssetKrw: "0" },
    { ...valid, targetAssetKrw: "0.00" },
    { ...valid, startAssetKrw: "0" },
    { ...valid, startAssetKrw: "500000000.25" },
    { ...valid, targetDate: "2026-02-30" },
    { ...valid, startDate: "2037-01-01" },
    { ...valid, targetKrWeight: "0.5" },
    { ...valid, targetCashWeight: "1.1", targetKrWeight: "0", targetUsWeight: "0" },
    { ...valid, unexpected: true },
  ]) {
    assert.throws(
      () => parseCapitalPlan(input),
      (error) => error instanceof CapitalPlanValidationError && error.code === "invalid-capital-plan",
    );
  }
});

test("capital-plan money inputs expose a browser-valid decimal pattern", async () => {
  const { DECIMAL_INPUT_PATTERN } = await vite.ssrLoadModule("/app/lib/format.ts");
  const pattern = new RegExp(`^(?:${DECIMAL_INPUT_PATTERN})$`, "v");
  for (const value of ["10", "200000000", "2000000", "10.25"]) {
    assert.equal(pattern.test(value), true, value);
  }
  for (const value of ["", "01", "1e3", "-10", "10."]) {
    assert.equal(pattern.test(value), false, value);
  }
});

test("capital-plan route is no-store and demo-safe", async () => {
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
    const route = await vite.ssrLoadModule("/app/api/capital-plan/route.ts");
    const response = await route.GET(new Request("https://ledgerlens.test/api/capital-plan"));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
    assert.deepEqual(await response.json(), { status: "demo", plan: null });

    const missingIntent = await route.PUT(new Request("https://ledgerlens.test/api/capital-plan", {
      method: "PUT",
      headers: { Origin: "https://ledgerlens.test", "Content-Type": "application/json" },
      body: "{}",
    }));
    assert.equal(missingIntent.status, 428);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
