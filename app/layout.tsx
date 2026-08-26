import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

const title = "LedgerLens | 내 자산 한눈에 보기";
const description =
  "증권 계좌와 수동 등록 자산을 한 화면에서 확인하고 성장 흐름, 자산 배분과 손익 근거를 검토하는 읽기 전용 자산관리 워크스페이스.";

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
    openGraph: {
      type: "website",
      title,
      description,
      images: [{ url: imageUrl, width: 1536, height: 1024, alt: "LedgerLens 자산 검토 워크스페이스" }],
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
