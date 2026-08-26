import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { createRelayGateway } from "../infra/relay/gateway.mjs";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not expose a TCP port.");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  server.close();
  await once(server, "close");
}

test("production Worker declares the fixed weekday Cron trigger", async () => {
  const [configuration, deploymentGuide, flyConfig] = await Promise.all([
    readFile("dist/server/wrangler.json", "utf8").then(JSON.parse),
    readFile("docs/RELAY_DEPLOYMENT.md", "utf8"),
    readFile("fly.relay.toml", "utf8"),
  ]);
  assert.deepEqual(configuration.triggers?.crons, ["10 22 * * SUN-THU"]);
  assert.match(deploymentGuide, /fly deploy --ha=false --config fly\.relay\.toml/);
  assert.match(deploymentGuide, /fly scale count 1/);
  assert.match(deploymentGuide, /fly scale show/);
  assert.match(flyConfig, /operator uses `fly deploy --ha=false`/);
});

test("relay runtime ships only the traced Vinext standalone server", async () => {
  const [nextConfig, dockerfile, supervisor, standaloneServer] = await Promise.all([
    readFile("next.config.ts", "utf8"),
    readFile("Dockerfile.relay", "utf8"),
    readFile("infra/relay/supervisor.mjs", "utf8"),
    readFile("dist/standalone/server.js", "utf8"),
  ]);
  const runtimeStage = dockerfile.split("FROM node:22.23.2-bookworm-slim AS runtime")[1];

  assert.ok(runtimeStage, "Dockerfile must pin the expected Relay runtime base image.");
  assert.match(nextConfig, /output:\s*"standalone"/);
  assert.match(
    runtimeStage,
    /COPY --from=build --chown=node:node \/app\/dist\/standalone \.\/dist\/standalone/,
  );
  assert.doesNotMatch(runtimeStage, /\/app\/node_modules/);
  assert.doesNotMatch(runtimeStage, /package-lock\.json|COPY .*package\.json/);
  assert.match(supervisor, /\["dist\/standalone\/server\.js"\]/);
  assert.match(supervisor, /HOST:\s*appHost/);
  assert.match(supervisor, /PORT:\s*String\(appPort\)/);
  assert.match(standaloneServer, /startProdServer/);

  await access("dist/standalone/node_modules/vinext/package.json");
  for (const buildOnlyPackage of [
    "@cloudflare/vite-plugin",
    "drizzle-kit",
    "eslint",
    "typescript",
    "vite",
    "wrangler",
  ]) {
    await assert.rejects(
      access(`dist/standalone/node_modules/${buildOnlyPackage}/package.json`),
      `${buildOnlyPackage} must not be shipped in the Relay runtime.`,
    );
  }
});

test("relay gateway exposes only health and the authenticated relay path", async (context) => {
  let authorization = null;
  const upstream = createServer((request, response) => {
    authorization = request.headers.authorization ?? null;
    if (!authorization) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "relay-authentication-required" } }));
      return;
    }
    response.writeHead(200, {
      "content-type": "application/json",
      "x-ledgerlens-account-ref": "account-ref-1",
      "set-cookie": "must-not-cross=1",
    });
    response.end(JSON.stringify({ mode: "live" }));
  });
  const upstreamOrigin = await listen(upstream);
  const gateway = createRelayGateway({
    upstreamUrl: `${upstreamOrigin}/api/relay/portfolio`,
    timeoutMs: 2_000,
  });
  const gatewayOrigin = await listen(gateway);
  context.after(async () => {
    await close(gateway);
    await close(upstream);
  });

  const health = await fetch(`${gatewayOrigin}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });

  const unknown = await fetch(`${gatewayOrigin}/api/portfolio`);
  assert.equal(unknown.status, 404);

  const query = await fetch(`${gatewayOrigin}/api/relay/portfolio?target=unexpected`);
  assert.equal(query.status, 400);

  const method = await fetch(`${gatewayOrigin}/api/relay/portfolio`, { method: "POST" });
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("allow"), "GET");

  const relayed = await fetch(`${gatewayOrigin}/api/relay/portfolio`, {
    headers: { Authorization: "Bearer a-secure-relay-token-value-12345" },
  });
  assert.equal(relayed.status, 200);
  assert.deepEqual(await relayed.json(), { mode: "live" });
  assert.equal(authorization, "Bearer a-secure-relay-token-value-12345");
  assert.equal(relayed.headers.get("x-ledgerlens-account-ref"), "account-ref-1");
  assert.equal(relayed.headers.get("set-cookie"), null);
  assert.match(relayed.headers.get("cache-control") ?? "", /no-store/);
});
