import type { TossClient } from "../toss/client";
import { TossApiError } from "../toss/errors";
import type {
  TossAccount,
  TossBuyingPower,
  TossExchangeRate,
  TossHoldingsOverview,
  TossPrice,
} from "../toss/types";
import {
  decimalAdd,
  decimalDivide,
  decimalIsZero,
  decimalMultiply,
  decimalSubtract,
  decimalSum,
  isDecimalString,
} from "./decimal";
import type {
  PortfolioAllocation,
  PortfolioConnection,
  PortfolioHolding,
  PortfolioResponse,
} from "./types";

const TARGET_WEIGHTS = {
  KR: "0.45",
  US: "0.45",
  CASH: "0.10",
} as const;

export class PortfolioBuildError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 502, options?: ErrorOptions) {
    super(message, options);
    this.name = "PortfolioBuildError";
    this.code = code;
    this.status = status;
  }
}

function requireDecimal(value: unknown, field: string): string {
  if (!isDecimalString(value)) {
    throw new PortfolioBuildError(
      "invalid-upstream-response",
      `Toss returned an invalid decimal for ${field}.`,
    );
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 500) {
    throw new PortfolioBuildError(
      "invalid-upstream-response",
      `Toss returned an invalid string for ${field}.`,
    );
  }
  return value;
}

function optionalUsd(value: unknown, field: string): string {
  return value === null || value === undefined ? "0" : requireDecimal(value, field);
}

function maskAccountNumber(accountNumber: string): string {
  const tail = accountNumber.slice(-4).padStart(4, "•");
  return `•••• ${tail}`;
}

function selectAccount(accounts: TossAccount[], preferredAccountSeq?: number): TossAccount {
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new PortfolioBuildError("account-not-found", "No eligible Toss brokerage account was found.", 404);
  }

  for (const account of accounts) {
    if (
      typeof account?.accountNo !== "string" ||
      !Number.isSafeInteger(account?.accountSeq) ||
      typeof account?.accountType !== "string"
    ) {
      throw new PortfolioBuildError("invalid-upstream-response", "Toss returned an invalid account.");
    }
  }

  if (preferredAccountSeq === undefined) return accounts[0];
  const account = accounts.find((candidate) => candidate.accountSeq === preferredAccountSeq);
  if (!account) {
    throw new PortfolioBuildError(
      "configured-account-not-found",
      "The configured Toss account was not returned by the accounts endpoint.",
      404,
    );
  }
  return account;
}

function validateRate(rate: TossExchangeRate): string {
  if (
    rate?.baseCurrency !== "USD" ||
    rate?.quoteCurrency !== "KRW" ||
    typeof rate.validFrom !== "string" ||
    typeof rate.validUntil !== "string"
  ) {
    throw new PortfolioBuildError("invalid-upstream-response", "Toss returned an invalid USD/KRW rate.");
  }
  return requireDecimal(rate.midRate, "exchangeRate.midRate");
}

function validateBuyingPower(value: TossBuyingPower, currency: "KRW" | "USD"): string {
  if (value?.currency !== currency) {
    throw new PortfolioBuildError(
      "invalid-upstream-response",
      `Toss returned buying power in an unexpected ${currency} currency response.`,
    );
  }
  return requireDecimal(value.cashBuyingPower, `buyingPower.${currency}`);
}

function currentPriceMap(prices: TossPrice[]): Map<string, TossPrice> {
  if (!Array.isArray(prices)) {
    throw new PortfolioBuildError("invalid-upstream-response", "Toss returned an invalid price list.");
  }
  const result = new Map<string, TossPrice>();
  for (const price of prices) {
    const symbol = requireString(price?.symbol, "price.symbol");
    requireDecimal(price?.lastPrice, `price.${symbol}.lastPrice`);
    result.set(symbol, price);
  }
  return result;
}

function buildHoldings(
  overview: TossHoldingsOverview,
  usdKrwRate: string,
  prices: Map<string, TossPrice>,
): PortfolioHolding[] {
  if (!Array.isArray(overview?.items)) {
    throw new PortfolioBuildError("invalid-upstream-response", "Toss returned an invalid holdings list.");
  }
  if (overview.items.length > 2_000) {
    throw new PortfolioBuildError("invalid-upstream-response", "Toss returned too many holdings.");
  }

  return overview.items.map((item) => {
    const symbol = requireString(item?.symbol, "holding.symbol");
    const currency = requireString(item?.currency, `holding.${symbol}.currency`);
    if (currency !== "KRW" && currency !== "USD") {
      throw new PortfolioBuildError(
        "unsupported-currency",
        `Holding ${symbol} uses an unsupported currency.`,
      );
    }

    const marketValueNative = requireDecimal(
      item?.marketValue?.amount,
      `holding.${symbol}.marketValue.amount`,
    );
    const quote = prices.get(symbol);
    const quotedLastPrice = quote
      ? requireDecimal(quote.lastPrice, `price.${symbol}.lastPrice`)
      : requireDecimal(item?.lastPrice, `holding.${symbol}.lastPrice`);

    return {
      symbol,
      name: requireString(item?.name, `holding.${symbol}.name`),
      marketCountry: requireString(item?.marketCountry, `holding.${symbol}.marketCountry`),
      currency,
      quantity: requireDecimal(item?.quantity, `holding.${symbol}.quantity`),
      lastPrice: quotedLastPrice,
      averagePurchasePrice: requireDecimal(
        item?.averagePurchasePrice,
        `holding.${symbol}.averagePurchasePrice`,
      ),
      marketValueNative,
      marketValueKrw:
        currency === "USD" ? decimalMultiply(marketValueNative, usdKrwRate) : marketValueNative,
      profitLossNative: requireDecimal(item?.profitLoss?.amount, `holding.${symbol}.profitLoss.amount`),
      profitLossRate: requireDecimal(item?.profitLoss?.rate, `holding.${symbol}.profitLoss.rate`),
      dailyProfitLossNative: requireDecimal(
        item?.dailyProfitLoss?.amount,
        `holding.${symbol}.dailyProfitLoss.amount`,
      ),
      dailyProfitLossRate: requireDecimal(
        item?.dailyProfitLoss?.rate,
        `holding.${symbol}.dailyProfitLoss.rate`,
      ),
    };
  });
}

function allocationRow(
  key: PortfolioAllocation["key"],
  label: string,
  valueKrw: string,
  totalValueKrw: string,
): PortfolioAllocation {
  return {
    key,
    label,
    valueKrw,
    weight: decimalIsZero(totalValueKrw) ? "0" : decimalDivide(valueKrw, totalValueKrw, 8),
    targetWeight: TARGET_WEIGHTS[key],
  };
}

export interface AssemblePortfolioInput {
  mode: "demo" | "live";
  asOf: string;
  account: { maskedNumber: string; type: string };
  holdings: PortfolioHolding[];
  buyingPowerKrw: string;
  buyingPowerUsd: string;
  usdKrwRate: string;
  profitLossRate?: string;
  dailyProfitLossRate?: string;
  exactTotals?: {
    krEquityValueKrw: string;
    usEquityValueKrw: string;
    purchaseValueKrw: string;
    profitLossKrw: string;
    dailyProfitLossKrw: string;
  };
  notices: string[];
  connection: PortfolioConnection;
}

/** Shared exact-string aggregation used by both live and demo data. */
export function assemblePortfolio(input: AssemblePortfolioInput): PortfolioResponse {
  const krEquity =
    input.exactTotals?.krEquityValueKrw ??
    decimalSum(
      input.holdings
        .filter((holding) => holding.currency === "KRW")
        .map((holding) => holding.marketValueKrw),
    );
  const usEquity =
    input.exactTotals?.usEquityValueKrw ??
    decimalSum(
      input.holdings
        .filter((holding) => holding.currency === "USD")
        .map((holding) => holding.marketValueKrw),
    );
  const equityValueKrw = decimalAdd(krEquity, usEquity);
  const cashValueKrw = decimalAdd(
    input.buyingPowerKrw,
    decimalMultiply(input.buyingPowerUsd, input.usdKrwRate),
  );
  const allocationTotal = decimalAdd(equityValueKrw, cashValueKrw);

  const purchaseValueKrw =
    input.exactTotals?.purchaseValueKrw ??
    decimalSum(
      input.holdings.map((holding) => {
        const purchaseNative = decimalMultiply(holding.quantity, holding.averagePurchasePrice);
        return holding.currency === "USD"
          ? decimalMultiply(purchaseNative, input.usdKrwRate)
          : purchaseNative;
      }),
    );
  const profitLossKrw =
    input.exactTotals?.profitLossKrw ??
    decimalSum(
      input.holdings.map((holding) =>
        holding.currency === "USD"
          ? decimalMultiply(holding.profitLossNative, input.usdKrwRate)
          : holding.profitLossNative,
      ),
    );
  const dailyProfitLossKrw =
    input.exactTotals?.dailyProfitLossKrw ??
    decimalSum(
      input.holdings.map((holding) =>
        holding.currency === "USD"
          ? decimalMultiply(holding.dailyProfitLossNative, input.usdKrwRate)
          : holding.dailyProfitLossNative,
      ),
    );

  return {
    mode: input.mode,
    asOf: input.asOf,
    account: input.account,
    summary: {
      equityValueKrw,
      purchaseValueKrw,
      profitLossKrw,
      profitLossRate:
        input.profitLossRate ??
        (decimalIsZero(purchaseValueKrw) ? "0" : decimalDivide(profitLossKrw, purchaseValueKrw, 8)),
      dailyProfitLossKrw,
      dailyProfitLossRate:
        input.dailyProfitLossRate ??
        (decimalIsZero(decimalSubtract(equityValueKrw, dailyProfitLossKrw))
          ? "0"
          : decimalDivide(
              dailyProfitLossKrw,
              decimalSubtract(equityValueKrw, dailyProfitLossKrw),
              8,
            )),
      buyingPowerKrw: input.buyingPowerKrw,
      buyingPowerUsd: input.buyingPowerUsd,
      usdKrwRate: input.usdKrwRate,
    },
    allocation: [
      allocationRow("KR", "국내 주식", krEquity, allocationTotal),
      allocationRow("US", "미국 주식", usEquity, allocationTotal),
      allocationRow("CASH", "주문 가능 금액", cashValueKrw, allocationTotal),
    ],
    holdings: input.holdings,
    notices: input.notices,
    connection: input.connection,
  };
}

export interface LivePortfolioBuildResult {
  portfolio: PortfolioResponse;
  accountSeq: number;
  accountCount: number;
}

export async function buildLivePortfolioWithAccount(
  client: TossClient,
  options: {
    preferredAccountSeq?: number;
    now?: () => Date;
  } = {},
): Promise<LivePortfolioBuildResult> {
  const accounts = await client.getAccounts();
  const account = selectAccount(accounts, options.preferredAccountSeq);

  const [overview, exchangeRate, buyingPowerKrwResponse, buyingPowerUsdResponse] =
    await Promise.all([
      client.getHoldings(account.accountSeq),
      client.getUsdKrwExchangeRate(),
      client.getBuyingPower(account.accountSeq, "KRW"),
      client.getBuyingPower(account.accountSeq, "USD"),
    ]);

  if (!Array.isArray(overview?.items) || overview.items.length > 2_000) {
    throw new PortfolioBuildError("invalid-upstream-response", "Toss returned an invalid holdings list.");
  }
  const prices = await client.getPrices(overview.items.map((item) => item.symbol));
  const priceMap = currentPriceMap(prices);
  const usdKrwRate = validateRate(exchangeRate);
  const buyingPowerKrw = validateBuyingPower(buyingPowerKrwResponse, "KRW");
  const buyingPowerUsd = validateBuyingPower(buyingPowerUsdResponse, "USD");
  const holdings = buildHoldings(overview, usdKrwRate, priceMap);
  const krEquityValueKrw = requireDecimal(
    overview?.marketValue?.amount?.krw,
    "marketValue.amount.krw",
  );
  const usEquityValueKrw = decimalMultiply(
    optionalUsd(overview?.marketValue?.amount?.usd, "marketValue.amount.usd"),
    usdKrwRate,
  );
  const purchaseValueKrw = decimalAdd(
    requireDecimal(overview?.totalPurchaseAmount?.krw, "totalPurchaseAmount.krw"),
    decimalMultiply(
      optionalUsd(overview?.totalPurchaseAmount?.usd, "totalPurchaseAmount.usd"),
      usdKrwRate,
    ),
  );
  const profitLossKrw = decimalAdd(
    requireDecimal(overview?.profitLoss?.amount?.krw, "profitLoss.amount.krw"),
    decimalMultiply(
      optionalUsd(overview?.profitLoss?.amount?.usd, "profitLoss.amount.usd"),
      usdKrwRate,
    ),
  );
  const dailyProfitLossKrw = decimalAdd(
    requireDecimal(overview?.dailyProfitLoss?.amount?.krw, "dailyProfitLoss.amount.krw"),
    decimalMultiply(
      optionalUsd(overview?.dailyProfitLoss?.amount?.usd, "dailyProfitLoss.amount.usd"),
      usdKrwRate,
    ),
  );
  const notices = [
    "USD 평가는 토스증권의 참고용 매매기준율(midRate)로 원화 환산했습니다.",
    "주문 가능 금액은 결제 완료 현금 잔고나 입출금 원장과 동일하지 않습니다.",
    "현재가는 시세 API, 평가금액과 손익은 보유자산 API 기준이므로 장중 갱신 시점이 약간 다를 수 있습니다.",
    "읽기 전용 연결이며 주문 API는 구현되어 있지 않습니다.",
  ];
  if (accounts.length > 1 && options.preferredAccountSeq === undefined) {
    notices.push("복수 계좌 중 첫 번째 정상 종합매매 계좌를 표시합니다.");
  }
  const missingPriceCount = holdings.filter((holding) => !priceMap.has(holding.symbol)).length;
  if (missingPriceCount > 0) {
    notices.push(`현재가 응답이 없는 ${missingPriceCount}개 종목은 보유자산 API의 현재가를 사용했습니다.`);
  }

  try {
    return {
      portfolio: assemblePortfolio({
        mode: "live",
        asOf: (options.now ?? (() => new Date()))().toISOString(),
        account: {
          maskedNumber: maskAccountNumber(requireString(account.accountNo, "account.accountNo")),
          type: requireString(account.accountType, "account.accountType"),
        },
        holdings,
        buyingPowerKrw,
        buyingPowerUsd,
        usdKrwRate,
        profitLossRate: requireDecimal(overview?.profitLoss?.rate, "profitLoss.rate"),
        dailyProfitLossRate: requireDecimal(overview?.dailyProfitLoss?.rate, "dailyProfitLoss.rate"),
        exactTotals: {
          krEquityValueKrw,
          usEquityValueKrw,
          purchaseValueKrw,
          profitLossKrw,
          dailyProfitLossKrw,
        },
        notices,
        connection: { configured: true, missing: [] },
      }),
      accountSeq: account.accountSeq,
      accountCount: accounts.length,
    };
  } catch (error) {
    if (error instanceof PortfolioBuildError || error instanceof TossApiError) throw error;
    throw new PortfolioBuildError(
      "invalid-upstream-response",
      "Unable to normalize the Toss portfolio response.",
      502,
      { cause: error },
    );
  }
}

export async function buildLivePortfolio(
  client: TossClient,
  options: {
    preferredAccountSeq?: number;
    now?: () => Date;
  } = {},
): Promise<PortfolioResponse> {
  return (await buildLivePortfolioWithAccount(client, options)).portfolio;
}
