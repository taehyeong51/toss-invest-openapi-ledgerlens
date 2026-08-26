import { TossClient } from "../toss/client";
import { getUnlockedTossCredentials } from "../credentials/vault";

export interface PortfolioEnvironment {
  source: "demo" | "direct" | "relay";
  connection: {
    configured: boolean;
    missing: string[];
  };
  demoReason: "not-configured" | "direct-disabled" | null;
  preferredAccountSeq?: number;
  directCredentialSource?: "environment" | "vault";
  directCredentials?: {
    clientId: string;
    clientSecret: string;
  };
  relay?: {
    url: string;
    token: string;
    accountKey: string;
  };
}

type EnvironmentSource = Readonly<Record<string, string | undefined>>;

let environmentClient: TossClient | undefined;
let environmentClientCredentials:
  | { clientId: string; clientSecret: string }
  | undefined;

function configuredValue(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}

function parseAccountSeq(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  if (!/^\d+$/.test(value)) {
    throw new TypeError("TOSS_ACCOUNT_SEQ must be a non-negative integer.");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError("TOSS_ACCOUNT_SEQ is outside JavaScript's safe integer range.");
  }
  return parsed;
}

function validateRelayUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw new TypeError("TOSS_RELAY_URL must use HTTPS (except localhost development).");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError("TOSS_RELAY_URL must not contain credentials, a query, or a URL fragment.");
  }
  return url.toString();
}

const RELAY_ACCOUNT_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const MIN_RELAY_TOKEN_LENGTH = 32;
const MAX_RELAY_TOKEN_LENGTH = 512;

function validateRelayAccountKey(value: string): string {
  if (!RELAY_ACCOUNT_KEY_PATTERN.test(value)) {
    throw new TypeError(
      "TOSS_RELAY_ACCOUNT_KEY must be an 8 to 128 character opaque identifier using only letters, numbers, dot, underscore, colon, or hyphen.",
    );
  }
  return value;
}

function validateRelayToken(value: string): string {
  if (
    value.length < MIN_RELAY_TOKEN_LENGTH ||
    value.length > MAX_RELAY_TOKEN_LENGTH ||
    /\s/u.test(value)
  ) {
    throw new TypeError(
      "TOSS_RELAY_TOKEN must be a 32 to 512 character bearer credential without whitespace.",
    );
  }
  return value;
}

export function getPortfolioEnvironment(
  environment: EnvironmentSource = process.env,
): PortfolioEnvironment {
  const relayUrl = configuredValue(environment.TOSS_RELAY_URL);
  const relayToken = configuredValue(environment.TOSS_RELAY_TOKEN);
  const relayAccountKey = configuredValue(environment.TOSS_RELAY_ACCOUNT_KEY);
  const validatedRelayToken = relayToken ? validateRelayToken(relayToken) : undefined;
  const validatedRelayAccountKey = relayAccountKey
    ? validateRelayAccountKey(relayAccountKey)
    : undefined;
  const clientId = configuredValue(environment.TOSS_CLIENT_ID);
  const clientSecret = configuredValue(environment.TOSS_CLIENT_SECRET);
  const directEnabled = environment.TOSS_DIRECT_API_ENABLED?.trim().toLowerCase() === "true";
  const preferredAccountSeq = parseAccountSeq(environment.TOSS_ACCOUNT_SEQ);
  const vaultCredentials = environment === process.env ? getUnlockedTossCredentials() : null;

  // A fixed-egress relay is preferred for Cloudflare/Sites deployments because
  // Toss requires an IP allowlist and permits only one token per client.
  if (relayUrl && validatedRelayToken && validatedRelayAccountKey) {
    return {
      source: "relay",
      connection: { configured: true, missing: [] },
      demoReason: null,
      preferredAccountSeq,
      relay: {
        url: validateRelayUrl(relayUrl),
        token: validatedRelayToken,
        accountKey: validatedRelayAccountKey,
      },
    };
  }

  if (directEnabled && clientId && clientSecret) {
    return {
      source: "direct",
      connection: { configured: true, missing: [] },
      demoReason: null,
      preferredAccountSeq,
      directCredentialSource: "environment",
      directCredentials: { clientId, clientSecret },
    };
  }

  if (vaultCredentials) {
    return {
      source: "direct",
      connection: { configured: true, missing: [] },
      demoReason: null,
      preferredAccountSeq: vaultCredentials.preferredAccountSeq,
      directCredentialSource: "vault",
      directCredentials: {
        clientId: vaultCredentials.clientId,
        clientSecret: vaultCredentials.clientSecret,
      },
    };
  }

  const missing: string[] = [];
  if (!clientId) missing.push("TOSS_CLIENT_ID");
  if (!clientSecret) missing.push("TOSS_CLIENT_SECRET");
  if (clientId && clientSecret && !directEnabled) missing.push("TOSS_DIRECT_API_ENABLED");
  if ((relayUrl || relayAccountKey) && !relayToken) missing.push("TOSS_RELAY_TOKEN");
  if ((relayToken || relayAccountKey) && !relayUrl) missing.push("TOSS_RELAY_URL");
  if ((relayUrl || relayToken) && !relayAccountKey) missing.push("TOSS_RELAY_ACCOUNT_KEY");

  return {
    source: "demo",
    connection: { configured: false, missing },
    demoReason: clientId && clientSecret && !directEnabled ? "direct-disabled" : "not-configured",
    preferredAccountSeq,
  };
}

export function getEnvironmentTossClient(configuration: PortfolioEnvironment): TossClient {
  if (configuration.source !== "direct" || !configuration.directCredentials) {
    throw new TypeError("Direct Toss credentials are not configured.");
  }

  if (
    !environmentClient ||
    environmentClientCredentials?.clientId !== configuration.directCredentials.clientId ||
    environmentClientCredentials.clientSecret !== configuration.directCredentials.clientSecret
  ) {
    environmentClient = new TossClient(configuration.directCredentials);
    environmentClientCredentials = { ...configuration.directCredentials };
  }
  return environmentClient;
}
