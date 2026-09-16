/** 中文：详细记录按空间清理，但永久计数器永不回退。 English: Detail cache pruning never rolls back lifetime counters. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { UsageLedger } from "../gateway/usage-ledger.mjs";

test("detail records prune only after the byte budget while lifetime totals remain", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cherry-cache-test-"));
  const ledger = new UsageLedger(root, { detailCacheMaxBytes: 6_000, detailCacheTargetBytes: 4_500 });
  try {
    const eventIds = [];
    for (let index = 0; index < 20; index += 1) {
      const result = ledger.append({
        eventId: `evt_cache_${String(index).padStart(3, "0")}`,
        at: new Date(Date.now() + index).toISOString(), providerId: "route-a", providerName: "Route A",
        clientKeyId: "client-a", clientKeyName: "Client A", model: `gpt-preview-${"x".repeat(80)}`,
        endpoint: "/v1/chat/completions", method: "POST", reasoningLevel: "high", status: 200,
        inputTokens: 10, outputTokens: 5, totalTokens: 15,
      });
      eventIds.push(result.eventId);
      if (index === 3) assert.equal(ledger.snapshot(new URL("http://local/usage?range=24h&limit=200")).records.length, 4, "details below the budget must remain");
    }
    const snapshot = ledger.snapshot(new URL("http://local/usage?range=24h&limit=200"));
    assert.ok(snapshot.records.length < 20, "old details should be pruned after the budget");
    assert.ok(snapshot.detailCache.bytes <= snapshot.detailCache.maxBytes);
    assert.equal(snapshot.lifetime.requests, 20);
    assert.equal(snapshot.lifetime.totalTokens, 300);
    ledger.markEventsSynced(eventIds);
  } finally {
    ledger.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
