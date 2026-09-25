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
    ledger.markEventsSynced(eventIds);
    ledger.prune();
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

test("pending usage details survive a cache over-limit condition", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cherry-pending-cache-test-"));
  const ledger = new UsageLedger(root, { detailCacheMaxBytes: 1_500, detailCacheTargetBytes: 1_000 });
  try {
    for (let index = 0; index < 8; index += 1) {
      ledger.append({
        eventId: `evt_pending_${index}`, at: new Date(Date.now() + index).toISOString(), providerId: "route-a", providerName: "Route A",
        clientKeyId: "client-a", clientKeyName: "Client A", model: `gpt-pending-${index}`, endpoint: "/v1/chat/completions",
        method: "POST", reasoningLevel: "high", status: 200, inputTokens: 10, outputTokens: 2, totalTokens: 12,
      });
    }
    const result = ledger.prune();
    assert.equal(result.deleted, 0, "pending details must not be discarded to meet the cache target");
    assert.equal(ledger.pendingUsage().length, 8);
    assert.equal(result.overLimit, true, "the caller must see that pending data is above the local target");
  } finally {
    ledger.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("redirect responses are errors in the usage ledger", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cherry-redirect-ledger-test-"));
  const ledger = new UsageLedger(root);
  try {
    const base = {
      at: new Date().toISOString(), providerId: "route-a", providerName: "Route A",
      clientKeyId: "client-a", clientKeyName: "Client A", model: "gpt-test",
      endpoint: "/v1/chat/completions", method: "POST", reasoningLevel: "high",
      inputTokens: 2, outputTokens: 1, totalTokens: 3,
    };
    ledger.append({ ...base, eventId: "evt-redirect", status: 302 });
    ledger.append({ ...base, eventId: "evt-success", status: 200 });
    const snapshot = ledger.snapshot(new URL("http://local/usage?range=24h&limit=20"));
    assert.equal(snapshot.lifetime.requests, 2);
    assert.equal(snapshot.lifetime.errors, 1);
    assert.equal(snapshot.summary.errors, 1);
  } finally {
    ledger.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
