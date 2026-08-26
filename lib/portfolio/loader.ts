import { createDemoPortfolio } from "./demo";
import {
  getEnvironmentTossClient,
  getPortfolioEnvironment,
  type PortfolioEnvironment,
} from "./environment";
import { fetchPortfolioFromRelay } from "./relay";
import { buildLivePortfolioWithAccount } from "./service";
import type { PortfolioResponse } from "./types";

// React development remounts, a manual snapshot, and a rapid refresh can all
// request the same portfolio at nearly the same time. Share that upstream read
// and briefly reuse the result so both API routes stay below Toss rate limits.
const PORTFOLIO_DEDUPE_MS = 2_000;
let connectedPortfolioRequest: Promise<PortfolioResponse> | null = null;
let recentConnectedPortfolio: { value: PortfolioResponse; expiresAt: number } | null = null;
let portfolioCacheGeneration = 0;
const directAccountSelections = new Map<
  string,
  { accountSeq: number; accountCount: number }
>();

async function loadConnectedPortfolio(
  configuration: PortfolioEnvironment,
): Promise<PortfolioResponse> {
  if (recentConnectedPortfolio && Date.now() < recentConnectedPortfolio.expiresAt) {
    return recentConnectedPortfolio.value;
  }

  if (!connectedPortfolioRequest) {
    const requestGeneration = portfolioCacheGeneration;
    const request = (async () => {
      let portfolio: PortfolioResponse;
      if (configuration.source === "relay" && configuration.relay) {
        portfolio = await fetchPortfolioFromRelay(configuration.relay);
      } else {
        const result = await buildLivePortfolioWithAccount(
          getEnvironmentTossClient(configuration),
          { preferredAccountSeq: configuration.preferredAccountSeq },
        );
        portfolio = result.portfolio;
        if (configuration.directCredentials) {
          directAccountSelections.set(configuration.directCredentials.clientId, {
            accountSeq: result.accountSeq,
            accountCount: result.accountCount,
          });
        }
      }

      if (requestGeneration === portfolioCacheGeneration) {
        recentConnectedPortfolio = {
          value: portfolio,
          expiresAt: Date.now() + PORTFOLIO_DEDUPE_MS,
        };
      }
      return portfolio;
    })();
    connectedPortfolioRequest = request;
    request.then(
      () => {
        if (connectedPortfolioRequest === request) connectedPortfolioRequest = null;
      },
      () => {
        if (connectedPortfolioRequest === request) connectedPortfolioRequest = null;
      },
    );
  }

  return connectedPortfolioRequest;
}

/** Returns only server-memory account selection metadata; it is never serialized. */
export function getRememberedDirectAccountSelection(
  clientId: string,
): { accountSeq: number; accountCount: number } | undefined {
  return directAccountSelections.get(clientId);
}

/** Invalidates all server-memory portfolio/account state after a credential change. */
export function resetPortfolioConnectionCache(): void {
  portfolioCacheGeneration += 1;
  connectedPortfolioRequest = null;
  recentConnectedPortfolio = null;
  directAccountSelections.clear();
}

/** Loads the same normalized portfolio used by both the dashboard and capture API. */
export async function loadCurrentPortfolio(): Promise<PortfolioResponse> {
  const configuration = getPortfolioEnvironment();
  if (configuration.source === "demo") {
    return createDemoPortfolio({
      connection: configuration.connection,
      reason: configuration.demoReason,
    });
  }
  return loadConnectedPortfolio(configuration);
}
