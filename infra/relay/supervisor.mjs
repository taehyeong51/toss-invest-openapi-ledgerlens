import { spawn } from "node:child_process";
import { createRelayGateway, probeRelayUpstream } from "./gateway.mjs";

function port(name, fallback) {
  const raw = process.env[name] ?? String(fallback);
  if (!/^\d+$/.test(raw)) throw new TypeError(`${name} must be a TCP port.`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new RangeError(`${name} must be a TCP port.`);
  }
  return parsed;
}

const appHost = process.env.RELAY_APP_HOST ?? "127.0.0.1";
if (!["127.0.0.1", "localhost", "::1"].includes(appHost)) {
  throw new TypeError("RELAY_APP_HOST must remain loopback-only.");
}
const appPort = port("RELAY_APP_PORT", 3000);
const gatewayHost = process.env.RELAY_GATEWAY_HOST ?? "0.0.0.0";
const gatewayPort = port("RELAY_GATEWAY_PORT", 8080);
const upstreamUrl = `http://${appHost === "::1" ? "[::1]" : appHost}:${appPort}/api/relay/portfolio`;

const app = spawn(
  process.execPath,
  ["dist/standalone/server.js"],
  {
    env: {
      ...process.env,
      HOST: appHost,
      PORT: String(appPort),
    },
    stdio: "inherit",
  },
);

let gateway;
let stopping = false;

async function waitForApp() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (app.exitCode !== null) throw new Error("Private relay app exited during startup.");
    if (await probeRelayUpstream(upstreamUrl)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Private relay app did not become ready.");
}

async function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  if (gateway) {
    await new Promise((resolve) => gateway.close(resolve));
  }
  if (app.exitCode === null) app.kill(signal);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stop(signal)
      .catch(() => undefined)
      .finally(() => {
        process.exitCode = 0;
      });
  });
}

app.once("exit", (code, signal) => {
  if (!stopping) {
    process.stderr.write(`Private relay app exited (${signal ?? code ?? "unknown"}).\n`);
    gateway?.close();
    process.exitCode = code && code !== 0 ? code : 1;
  }
});

try {
  await waitForApp();
  gateway = createRelayGateway({ upstreamUrl });
  await new Promise((resolve, reject) => {
    gateway.once("error", reject);
    gateway.listen(gatewayPort, gatewayHost, resolve);
  });
  process.stdout.write(`Relay gateway listening on ${gatewayHost}:${gatewayPort}.\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Relay startup failed."}\n`);
  await stop();
  process.exitCode = 1;
}
