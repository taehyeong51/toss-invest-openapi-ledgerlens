import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const reviewWorkspaceUrl = new URL(
  "../app/components/ReviewWorkspace.tsx",
  import.meta.url,
);

test("Review keeps whole-asset checks before plan pace and outside performance math", async () => {
  const source = await readFile(reviewWorkspaceUrl, "utf8");
  const reliabilityIndex = source.indexOf('className="whole-asset-reliability"');
  const planPaceIndex = source.indexOf('className="plan-pace-section"');

  assert.ok(reliabilityIndex >= 0, "whole-asset reliability subsection is rendered");
  assert.ok(
    reliabilityIndex < planPaceIndex,
    "whole-asset reliability is reviewed before plan pace",
  );
  assert.match(
    source,
    /calculateExternalAssetDiagnostics\(data\.externalAssets\.assets, portfolio\.asOf\)/,
  );
  assert.match(
    source,
    /exactSum\(current, data\.externalAssets\.totalValueKrw\)/,
  );
  assert.match(source, /currentAssetKrw: current/);
  assert.match(
    source,
    /수동 자산은 Modified Dietz 수익률, 계획 페이스, 손익 또는 변화 원인 계산에 포함하지 않습니다/,
  );
});

test("Review discloses source, freshness, maturity, history, and truncation states", async () => {
  const source = await readFile(reviewWorkspaceUrl, "utf8");

  assert.match(source, /증권 성과 분석 신뢰도/);
  assert.doesNotMatch(source, />데이터 신뢰도 게이트</);
  assert.match(source, /수동 자산 원천/);
  assert.match(source, /평가 갱신/);
  assert.match(source, /만기 점검/);
  assert.match(source, /월별 등록 기록/);
  assert.match(source, /데모에서는 개인 자산 원장을 저장하지 않습니다/);
  assert.match(source, /수동 자산 원장을 불러오지 못했습니다/);
  assert.match(source, /수동 등록 자산이 없습니다/);
  assert.match(source, /목록 페이지네이션 후 확인해야 합니다/);
  assert.match(source, /wholeAssetHistoryWarnings\.map/);
});
