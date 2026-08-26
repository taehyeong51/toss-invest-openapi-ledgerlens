import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const componentUrl = new URL(
  "../app/components/ExternalAssetCsvTransfer.tsx",
  import.meta.url,
);
const pageUrl = new URL("../app/page.tsx", import.meta.url);

test("CSV UI preserves original UTF-8 bytes and binds preview to one selection", async () => {
  const source = await readFile(componentUrl, "utf8");

  assert.match(source, /await file\.arrayBuffer\(\)/);
  assert.match(source, /new TextDecoder\("utf-8", \{ fatal: true \}\)\.decode\(bytes\)/);
  assert.doesNotMatch(source, /file\.text\(\)/);
  assert.equal((source.match(/body: selected\.file/g) ?? []).length, 2);
  assert.match(source, /selectionGeneration\.current === generation/);
  assert.match(source, /disabled=\{previewing \|\| importing\}/);
});

test("CSV UI blocks empty commits and waits for refreshed whole-asset history", async () => {
  const [component, page] = await Promise.all([
    readFile(componentUrl, "utf8"),
    readFile(pageUrl, "utf8"),
  ]);

  assert.match(component, /preview\.rowCount === 0/);
  assert.match(component, /await onImported\(result\.payload\)/);
  assert.match(page, /wholeAssetHistoryRequest\.current !== requestId/);
  assert.match(page, /WHOLE_ASSET_HISTORY_RELOAD_WARNING/);
});
