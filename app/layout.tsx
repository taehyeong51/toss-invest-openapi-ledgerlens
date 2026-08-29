import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

const title = "LedgerLens | 토스증권 Open API 자산관리 대시보드";
const description =
  "토스증권 Open API로 국내·미국 주식, ETF, 매수 가능 금액과 환율을 동기화하고 수동 등록 자산까지 함께 관리하는 읽기 전용 오픈소스 자산관리 대시보드.";

const themeBootScript = `(() => {
  try {
    const saved = window.localStorage.getItem("ledgerlens-theme");
    const theme = saved === "dark" ? "dark" : "light";
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  } catch {}
})();`;

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const forwardedHost = requestHeaders.get("x-forwarded-host")?.split(",")[0];
  const requestedHost = forwardedHost ?? requestHeaders.get("host") ?? "localhost:3000";
  const host = /^[a-z0-9.-]+(?::\d+)?$/i.test(requestedHost)
    ? requestedHost
    : "localhost:3000";
  const forwardedProtocol = requestHeaders
    .get("x-forwarded-proto")
    ?.split(",")[0];
  const protocol = forwardedProtocol === "http" || forwardedProtocol === "https"
    ? forwardedProtocol
    : host.startsWith("localhost")
      ? "http"
      : "https";
  const origin = `${protocol}://${host}`;
  const imageUrl = new URL("/og-v2.png", origin).toString();

  return {
    metadataBase: new URL(origin),
    title,
    description,
    applicationName: "LedgerLens",
    category: "finance",
    creator: "LedgerLens contributors",
    publisher: "LedgerLens contributors",
    robots: {
      index: true,
      follow: true,
    },
    openGraph: {
      type: "website",
      locale: "ko_KR",
      siteName: "LedgerLens",
      title,
      description,
      images: [{ url: imageUrl, width: 1536, height: 1024, alt: "토스증권 Open API 기반 LedgerLens 자산관리 대시보드" }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [imageUrl],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko" data-theme="light" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body data-design-direction="asset-console" data-design-finish="spreadsheet-clarity">
        <template
          dangerouslySetInnerHTML={{
            __html: "<!-- THESIS: An Excel-familiar personal asset console that becomes useful through trustworthy automation. OWN-WORLD: Korean financial clarity, compact analytical grids, restrained category color, exact numerals, and no trading theatrics. STORY: see the whole balance, compare asset classes, inspect observable change, then open the evidence. FIRST VIEWPORT: total assets, four category summaries, allocation, and monthly growth with real-data states. FORM: approved LedgerLens asset-console composition, ledger-console-approved-20260826. FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance. -->",
          }}
        />
        {children}
      </body>
    </html>
  );
}
