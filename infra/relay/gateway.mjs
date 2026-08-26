import { createServer } from "node:http";

const DEFAULT_UPSTREAM = "http://127.0.0.1:3000/api/relay/portfolio";
const MAX_UPSTREAM_BYTES = 2 * 1024 * 1024;
const SAFE_RESPONSE_HEADERS = [
  "retry-after",
  "www-authenticate",
  "x-ledgerlens-account-ref",
];

function validateUpstream(rawUrl) {
  const url = new URL(rawUrl);
  const isLoopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname);
  if (
    url.protocol !== "http:" ||
    !isLoopback ||
    url.username ||
    url.password ||
    url.pathname !== "/api/relay/portfolio" ||
    url.search ||
    url.hash
  ) {
    throw new TypeError("Relay gateway upstream must be the loopback relay endpoint.");
  }
  return url;
}

function responseHeaders(contentType = "application/json; charset=utf-8") {
  return {
    "cache-control": "private, no-store, max-age=0",
    "content-type": contentType,
    pragma: "no-cache",
    "x-content-type-options": "nosniff",
  };
}

function writeJson(response, status, body, extraHeaders = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    ...responseHeaders(),
    "content-length": String(payload.byteLength),
    ...extraHeaders,
  });
  response.end(payload);
}

async function readBoundedBody(upstreamResponse) {
  const declaredLength = upstreamResponse.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_UPSTREAM_BYTES) {
    throw new RangeError("Relay upstream response is too large.");
  }
  if (!upstreamResponse.body) return Buffer.alloc(0);

  const reader = upstreamResponse.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_UPSTREAM_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new RangeError("Relay upstream response is too large.");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export async function probeRelayUpstream(
  upstreamUrl = DEFAULT_UPSTREAM,
  fetchImplementation = fetch,
) {
  const url = validateUpstream(upstreamUrl);
  try {
    const response = await fetchImplementation(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(1_500),
    });
    await response.body?.cancel().catch(() => undefined);
    // Authentication is deliberately the first relay check. A 401 therefore
    // proves the private app and exact route are ready without contacting Toss.
    return response.status === 401;
  } catch {
    return false;
  }
}

export function createRelayGateway(options = {}) {
  const upstreamUrl = validateUpstream(options.upstreamUrl ?? DEFAULT_UPSTREAM);
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
    throw new RangeError("Relay gateway timeout must be between 1000 and 60000 milliseconds.");
  }

  const server = createServer(async (request, response) => {
    response.setHeader("connection", "close");
    const requestUrl = new URL(request.url ?? "/", "http://relay.invalid");

    if (request.method === "GET" && requestUrl.pathname === "/healthz" && !requestUrl.search) {
      const ready = await probeRelayUpstream(upstreamUrl.toString(), fetchImplementation);
      writeJson(response, ready ? 200 : 503, { status: ready ? "ok" : "starting" });
      return;
    }

    if (requestUrl.pathname !== "/api/relay/portfolio") {
      writeJson(response, 404, { error: { code: "not-found", message: "Not found." } });
      return;
    }
    if (request.method !== "GET") {
      writeJson(
        response,
        405,
        { error: { code: "method-not-allowed", message: "Only GET is allowed." } },
        { allow: "GET" },
      );
      return;
    }
    if (requestUrl.search) {
      writeJson(response, 400, {
        error: { code: "relay-query-not-allowed", message: "Query parameters are not allowed." },
      });
      return;
    }
    const contentLength = request.headers["content-length"];
    if (request.headers["transfer-encoding"] || (contentLength && contentLength !== "0")) {
      writeJson(response, 400, {
        error: { code: "relay-body-not-allowed", message: "A request body is not allowed." },
      });
      return;
    }

    try {
      const headers = new Headers({ Accept: "application/json" });
      if (typeof request.headers.authorization === "string") {
        headers.set("Authorization", request.headers.authorization);
      }
      const upstreamResponse = await fetchImplementation(upstreamUrl, {
        method: "GET",
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const mediaType = upstreamResponse.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      if (mediaType !== "application/json" || upstreamResponse.status < 200 || upstreamResponse.status > 599) {
        await upstreamResponse.body?.cancel().catch(() => undefined);
        throw new TypeError("Relay upstream returned an invalid response.");
      }

      const payload = await readBoundedBody(upstreamResponse);
      const safeHeaders = responseHeaders("application/json; charset=utf-8");
      for (const name of SAFE_RESPONSE_HEADERS) {
        const value = upstreamResponse.headers.get(name);
        if (value) safeHeaders[name] = value;
      }
      response.writeHead(upstreamResponse.status, {
        ...safeHeaders,
        "content-length": String(payload.byteLength),
      });
      response.end(payload);
    } catch (error) {
      const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
      writeJson(response, timedOut ? 504 : 502, {
        error: {
          code: timedOut ? "relay-gateway-timeout" : "relay-gateway-unavailable",
          message: timedOut
            ? "The private relay timed out."
            : "The private relay is unavailable.",
          retryable: true,
        },
      });
    }
  });

  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  return server;
}
