import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the LedgerLens read-only product shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>LedgerLens \| 내 자산 한눈에 보기<\/title>/);
  assert.match(html, /data-design-direction="asset-console"/);
  assert.match(html, /data-theme="light"/);
  assert.match(html, />대시보드<\/button>/);
  assert.match(html, />성과<\/button>/);
  assert.match(html, />자본 계획<\/button>/);
  assert.match(html, /자산 대시보드와 저장 기록을 불러오는 중/);
  assert.match(html, /읽기 전용/i);
  assert.match(html, /role="status"/);
  assert.doesNotMatch(html, /codex-preview|Building your site|react-loading-skeleton/i);
});

test("keeps the redesigned shell responsive, period-consistent, and keyboard-safe", async () => {
  const [page, layout, stylesheet, packageJson, navigation, dashboard, review, csvTransfer, credentials] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../app/components/WorkspaceNav.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/DashboardWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ReviewWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ExternalAssetCsvTransfer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/TossCredentialSettings.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(page, /\/api\/portfolio/);
  assert.match(page, /\/api\/whole-asset-history\?months=24/);
  assert.match(page, /calculateExternalAssetDiagnostics/);
  assert.match(page, /WholeAssetTrendChart/);
  assert.match(page, /ExternalAssetReviewQueue/);
  assert.match(page, /읽기 전용/);
  assert.match(page, /filteredSnapshots\(history\.snapshots, period, portfolio\.asOf\)/);
  assert.match(page, /\{\[\.\.\.storedSnapshots\]\.reverse\(\)\.map/);
  assert.match(page, /name: "Asia\/Seoul"/);
  assert.match(page, /monthKeyInCapitalTimeZone\(entry\.occurredAt\)/);
  assert.match(layout, /LedgerLens/);
  assert.match(layout, /ledgerlens-theme/);
  assert.match(layout, /data-theme="light"/);
  assert.doesNotMatch(page, /_sites-preview|SkeletonPreview/);
  assert.doesNotMatch(stylesheet, /body\s*\{[^}]*min-width:\s*320px/s);
  assert.match(navigation, /href="#workspace-main"/);
  assert.match(navigation, /aria-pressed=\{theme === "dark"\}/);
  assert.match(navigation, /다크 테마로 전환/);
  assert.match(dashboard, /등록 평가액 추이이며 투자 수익률이 아닙니다/);
  assert.match(dashboard, /종목 응답에 섹터 메타데이터가 없어 현재는 국내·미국 시장 기준/);
  assert.match(dashboard, /저장된 스냅샷의 가격 기록이 2개 이상일 때만 표시/);
  assert.match(page, /function viewFromHash\(\): WorkspaceView \| null/);
  assert.match(page, /if \(nextView\) \{[\s\S]*?focusWorkspaceHeading\(\)/);
  assert.match(page, /<h1 tabIndex=\{-1\}>\{title\}<\/h1>/);
  assert.match(review, /role="group" aria-label="분석 기간"/);
  assert.match(review, /aria-label=\{`\$\{review\.action\}:/);
  assert.match(csvTransfer, /inputRef\.current\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(page, /TossCredentialSettings/);
  assert.match(credentials, /내 Toss Open API 연결/);
  assert.match(credentials, /type=\{showSecret \? "text" : "password"\}/);
  assert.match(credentials, /local-encrypted-file/);
  assert.doesNotMatch(credentials, /localStorage|sessionStorage|indexedDB/i);
  assert.doesNotMatch(stylesheet, /\.csv-file-actions\s*\{[^}]*flex-direction:\s*column-reverse/s);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);

  await assert.rejects(
    access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)),
  );
  await assert.rejects(
    access(new URL("../app/_sites-preview/preview.css", import.meta.url)),
  );
});
