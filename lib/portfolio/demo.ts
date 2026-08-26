import { assemblePortfolio } from "./service";
import type { PortfolioConnection, PortfolioHolding, PortfolioResponse } from "./types";

const DEMO_HOLDINGS: PortfolioHolding[] = [
  {
    symbol: "005930",
    name: "삼성전자",
    marketCountry: "KR",
    currency: "KRW",
    quantity: "42",
    lastPrice: "93400",
    averagePurchasePrice: "81750",
    marketValueNative: "3922800",
    marketValueKrw: "3922800",
    profitLossNative: "489300",
    profitLossRate: "0.14251",
    dailyProfitLossNative: "75600",
    dailyProfitLossRate: "0.01965",
  },
  {
    symbol: "000660",
    name: "SK하이닉스",
    marketCountry: "KR",
    currency: "KRW",
    quantity: "12",
    lastPrice: "278000",
    averagePurchasePrice: "231500",
    marketValueNative: "3336000",
    marketValueKrw: "3336000",
    profitLossNative: "558000",
    profitLossRate: "0.20086",
    dailyProfitLossNative: "-48000",
    dailyProfitLossRate: "-0.01418",
  },
  {
    symbol: "AAPL",
    name: "Apple",
    marketCountry: "US",
    currency: "USD",
    quantity: "8.5",
    lastPrice: "214.35",
    averagePurchasePrice: "183.20",
    marketValueNative: "1821.975",
    marketValueKrw: "2518698.24",
    profitLossNative: "264.775",
    profitLossRate: "0.17003",
    dailyProfitLossNative: "21.25",
    dailyProfitLossRate: "0.0118",
  },
  {
    symbol: "QQQ",
    name: "Invesco QQQ",
    marketCountry: "US",
    currency: "USD",
    quantity: "3",
    lastPrice: "573.42",
    averagePurchasePrice: "512",
    marketValueNative: "1720.26",
    marketValueKrw: "2378087.424",
    profitLossNative: "184.26",
    profitLossRate: "0.11996",
    dailyProfitLossNative: "-8.55",
    dailyProfitLossRate: "-0.00495",
  },
];

export function createDemoPortfolio(options: {
  connection: PortfolioConnection;
  reason: "not-configured" | "direct-disabled" | null;
  now?: () => Date;
}): PortfolioResponse {
  const setupNotice =
    options.reason === "direct-disabled"
      ? "API 자격 증명은 감지했지만 직접 호출은 안전을 위해 비활성화되어 샘플 데이터를 표시합니다. 고정 IP 서버에서 TOSS_DIRECT_API_ENABLED=true를 설정하거나 릴레이를 연결하세요."
      : "샘플 데이터입니다. 고정 IP 백엔드의 Toss API 자격 증명 또는 안전한 릴레이를 연결하면 실제 포트폴리오로 전환됩니다.";

  return assemblePortfolio({
    mode: "demo",
    asOf: (options.now ?? (() => new Date()))().toISOString(),
    account: { maskedNumber: "•••• 1908", type: "BROKERAGE" },
    holdings: DEMO_HOLDINGS,
    buyingPowerKrw: "2850000",
    buyingPowerUsd: "624.18",
    usdKrwRate: "1382.4",
    notices: [
      setupNotice,
      "주문 가능 금액은 결제 완료 현금 잔고나 입출금 원장과 동일하지 않습니다.",
      "읽기 전용 데모이며 주문 기능은 포함하지 않습니다.",
    ],
    connection: options.connection,
  });
}
