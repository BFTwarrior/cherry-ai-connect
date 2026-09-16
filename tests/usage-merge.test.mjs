/** 中文：验证多设备 G-Counter 合并、事件去重和计数器不回退。 English: Multi-device merge tests. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { UsageLedger } from "../gateway/usage-ledger.mjs";

const datasetId = "ds_01995f2c-7f5a-7b21-a8d2-6dfc50f4a901";

function ledgerAt(root, suffix) {
  const directory = path.join(root, suffix);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "device.json"), JSON.stringify({
    datasetId,
    deviceId: `dev_01995f2c-7f5a-7b21-a8d2-6dfc50f4${suffix.padEnd(4, "0").slice(0, 4)}`,
    deviceEpoch: 1,
  }));
  return new UsageLedger(directory);
}

function record(id, totalTokens) {
  return {
    eventId: id,
    at: new Date().toISOString(),
    providerId: "route-a",
    providerName: "Route A",
    clientKeyId: "client-a",
    clientKeyName: "Client A",
    model: "gpt-test",
    endpoint: "/v1/chat/completions",
    method: "POST",
    reasoningLevel: "high",
    status: 200,
    inputTokens: totalTokens,
    outputTokens: 0,
    totalTokens,
  };
}

test("multi-device usage converges without duplicate lifetime totals", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cherry-merge-test-"));
  const a = ledgerAt(root, "aaaa");
  const b = ledgerAt(root, "bbbb");
  const c = ledgerAt(root, "cccc");
  try {
    a.append(record("evt_a_1", 10));
    a.append(record("evt_a_2", 20));
    b.append(record("evt_b_1", 5));
    const exportA = { datasetId, events: a.pendingUsage(), counters: a.counters(), tombstones: a.tombstones() };
    const exportB = { datasetId, events: b.pendingUsage(), counters: b.counters(), tombstones: b.tombstones() };
    c.mergeRemote(exportA);
    c.mergeRemote(exportB);
    c.mergeRemote(exportA);
    let snapshot = c.snapshot(new URL("http://local/usage?range=24h"));
    assert.equal(snapshot.records.length, 3);
    assert.equal(snapshot.lifetime.requests, 3);
    assert.equal(snapshot.lifetime.totalTokens, 35);

    const stale = structuredClone(exportA);
    stale.events = [];
    stale.counters[0].requests = 1;
    stale.counters[0].total_tokens = 1;
    c.mergeRemote(stale);
    snapshot = c.snapshot(new URL("http://local/usage?range=24h"));
    assert.equal(snapshot.lifetime.requests, 3);
    assert.equal(snapshot.lifetime.totalTokens, 35);
  } finally {
    a.close(); b.close(); c.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
