import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

function json(value, status = 200, headers) {
  return Response.json(value, { status, headers });
}

test("single-flights OAuth and caches the token without putting credentials in URLs", async () => {
  const { TossClient } = await vite.ssrLoadModule("/lib/toss/client.ts");
  let tokenRequests = 0;
  const accountAuthorizations = [];

  const fetchImplementation = async (input, init = {}) => {
    const url = new URL(input);
    if (url.pathname === "/oauth2/token") {
      tokenRequests += 1;
      assert.equal(url.search, "");
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "manual");
      assert.match(String(init.body), /grant_type=client_credentials/);
      await new Promise((resolve) => setTimeout(resolve, 10));
      return json({ access_token: "test-token", token_type: "Bearer", expires_in: 3600 });
    }
    accountAuthorizations.push(new Headers(init.headers).get("authorization"));
    return json({ result: [] });
  };

  const client = new TossClient({
    clientId: `single-flight-${Date.now()}`,
    clientSecret: "test-secret",
    fetchImplementation,
  });
  await Promise.all([client.getAccounts(), client.getAccounts()]);

  assert.equal(tokenRequests, 1);
  assert.deepEqual(accountAuthorizations, ["Bearer test-token", "Bearer test-token"]);
});

test("does not reuse a cached token when the secret changes for the same client ID", async () => {
  const { TossClient } = await vite.ssrLoadModule("/lib/toss/client.ts");
  const clientId = `secret-rotation-${Date.now()}`;
  const tokenSecrets = [];
  const fetchImplementation = async (input, init = {}) => {
    const url = new URL(input);
    if (url.pathname === "/oauth2/token") {
      const form = new URLSearchParams(String(init.body));
      tokenSecrets.push(form.get("client_secret"));
      return json({
        access_token: `token-${tokenSecrets.length}`,
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    return json({ result: [] });
  };

  await new TossClient({
    clientId,
    clientSecret: "first-test-secret",
    fetchImplementation,
  }).getAccounts();
  await new TossClient({
    clientId,
    clientSecret: "second-test-secret",
    fetchImplementation,
  }).getAccounts();

  assert.deepEqual(tokenSecrets, ["first-test-secret", "second-test-secret"]);
});

test("uses Worker-compatible manual redirect handling and never follows token redirects", async () => {
  const { TossClient } = await vite.ssrLoadModule("/lib/toss/client.ts");
  let requests = 0;
  const fetchImplementation = async (_input, init = {}) => {
    requests += 1;
    assert.equal(init.redirect, "manual");
    return json({ error: "redirect-refused" }, 302, {
      Location: "https://example.invalid/credential-collector",
    });
  };
  const client = new TossClient({
    clientId: `redirect-${Date.now()}`,
    clientSecret: "test-secret",
    fetchImplementation,
  });

  await assert.rejects(client.getAccounts(), /status 302/);
  assert.equal(requests, 1);
});

test("refreshes once after an upstream 401 and replays only the safe GET", async () => {
  const { TossClient } = await vite.ssrLoadModule("/lib/toss/client.ts");
  let tokenRequests = 0;
  let accountRequests = 0;
  const fetchImplementation = async (input, init = {}) => {
    const url = new URL(input);
    if (url.pathname === "/oauth2/token") {
      tokenRequests += 1;
      return json({
        access_token: `test-token-${tokenRequests}`,
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    accountRequests += 1;
    const authorization = new Headers(init.headers).get("authorization");
    if (authorization === "Bearer test-token-1") {
      return json(
        { error: { requestId: "request-401", code: "invalid-token", message: "expired" } },
        401,
      );
    }
    return json({ result: [] });
  };

  const client = new TossClient({
    clientId: `refresh-${Date.now()}`,
    clientSecret: "test-secret",
    fetchImplementation,
  });
  await client.getAccounts();

  assert.equal(tokenRequests, 2);
  assert.equal(accountRequests, 2);
});

test("chunks prices at 200 symbols and bounds the total fan-out", async () => {
  const { TossClient } = await vite.ssrLoadModule("/lib/toss/client.ts");
  const chunkSizes = [];
  const fetchImplementation = async (input) => {
    const url = new URL(input);
    if (url.pathname === "/oauth2/token") {
      return json({ access_token: "price-token", token_type: "Bearer", expires_in: 3600 });
    }
    const symbols = url.searchParams.get("symbols").split(",");
    chunkSizes.push(symbols.length);
    return json({
      result: symbols.map((symbol) => ({
        symbol,
        timestamp: null,
        lastPrice: "1",
        currency: "KRW",
      })),
    });
  };
  const client = new TossClient({
    clientId: `prices-${Date.now()}`,
    clientSecret: "test-secret",
    fetchImplementation,
  });
  const symbols = Array.from({ length: 201 }, (_, index) => String(index).padStart(6, "0"));

  const prices = await client.getPrices(symbols);
  assert.equal(prices.length, 201);
  assert.deepEqual(chunkSizes, [200, 1]);
  await assert.rejects(
    client.getPrices(Array.from({ length: 2001 }, (_, index) => String(index).padStart(6, "0"))),
    /limited to 2000/,
  );
});

test("keeps demo mode as the safe default even when credentials are present", async () => {
  const { getPortfolioEnvironment } = await vite.ssrLoadModule(
    "/lib/portfolio/environment.ts",
  );
  const { createDemoPortfolio } = await vite.ssrLoadModule("/lib/portfolio/demo.ts");

  const environment = getPortfolioEnvironment({
    TOSS_CLIENT_ID: "configured-id",
    TOSS_CLIENT_SECRET: "configured-secret",
  });
  assert.equal(environment.source, "demo");
  assert.deepEqual(environment.connection.missing, ["TOSS_DIRECT_API_ENABLED"]);

  const portfolio = createDemoPortfolio({
    connection: environment.connection,
    reason: environment.demoReason,
    now: () => new Date("2026-08-07T00:00:00.000Z"),
  });
  assert.equal(portfolio.mode, "demo");
  assert.equal(portfolio.asOf, "2026-08-07T00:00:00.000Z");
  assert.equal(portfolio.summary.usdKrwRate, "1382.4");
  assert.match(portfolio.summary.equityValueKrw, /^\d+(?:\.\d+)?$/);
  assert.equal(portfolio.connection.configured, false);
});

test("uses exact decimal-string arithmetic for normalized values", async () => {
  const decimal = await vite.ssrLoadModule("/lib/portfolio/decimal.ts");
  assert.equal(decimal.decimalAdd("9007199254740993.10", "0.20"), "9007199254740993.3");
  assert.equal(decimal.decimalMultiply("1821.975", "1382.4"), "2518698.24");
  assert.equal(decimal.decimalDivide("1", "3", 8), "0.33333333");
  assert.equal(decimal.decimalDivide("2", "3", 8), "0.66666667");
});

test("non-loopback live portfolio fails closed without trusted platform authentication", async () => {
  const keys = [
    "TOSS_RELAY_URL",
    "TOSS_RELAY_TOKEN",
    "TOSS_RELAY_ACCOUNT_KEY",
    "TOSS_DIRECT_API_ENABLED",
    "TOSS_CLIENT_ID",
    "TOSS_CLIENT_SECRET",
    "LEDGERLENS_TRUST_PLATFORM_AUTH",
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

  try {
    delete process.env.TOSS_RELAY_URL;
    delete process.env.TOSS_RELAY_TOKEN;
    delete process.env.TOSS_RELAY_ACCOUNT_KEY;
    delete process.env.LEDGERLENS_TRUST_PLATFORM_AUTH;
    process.env.TOSS_DIRECT_API_ENABLED = "true";
    process.env.TOSS_CLIENT_ID = "must-not-reach-upstream";
    process.env.TOSS_CLIENT_SECRET = "must-not-reach-upstream";

    const { GET } = await vite.ssrLoadModule("/app/api/portfolio/route.ts");
    const response = await GET(new Request("https://public.example/api/portfolio", {
      headers: { "oai-authenticated-user-id": "forged-owner" },
    }));
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error?.code, "portfolio-owner-required");
    assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test("the portfolio route is private, no-store, and the Toss adapter contains no order endpoint", async () => {
  const [route, loader, client] = await Promise.all([
    readFile(new URL("../app/api/portfolio/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/portfolio/loader.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/toss/client.ts", import.meta.url), "utf8"),
  ]);

  assert.match(route, /Cache-Control["']?:\s*["']private, no-store, max-age=0["']/);
  assert.match(route, /Cloudflare-CDN-Cache-Control["']?:\s*["']no-store["']/);
  assert.match(route, /configuration\.source !== "demo"/);
  assert.match(route, /resolveHistoryOwner\(request\)/);
  assert.match(route, /portfolio-owner-required/);
  assert.match(loader, /PORTFOLIO_DEDUPE_MS\s*=\s*2_000/);
  assert.doesNotMatch(client, /\/api\/v1\/(?:conditional-)?orders?\b/);
  assert.doesNotMatch(client, /console\.(?:log|info|debug|warn|error)/);
  assert.doesNotMatch(client, /redirect:\s*["']error["']/);
});
