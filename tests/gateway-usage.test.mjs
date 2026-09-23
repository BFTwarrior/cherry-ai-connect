/**
 * 中文：端到端验证自动命名、非流式/流式 Token 采集和永久累计总账。
 * English: End-to-end coverage for automatic naming, streamed/non-streamed usage capture, and lifetime totals.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { UsageLedger } from "../gateway/usage-ledger.mjs";

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function availablePort() {
  const probe = http.createServer();
  const port = await listen(probe);
  await close(probe);
  return port;
}

test("usage ledger and route-following key names survive the complete flow", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cherry-gateway-test-"));
  const upstream = http.createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ object: "list", data: [{ id: "gpt-test" }] }));
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.equal(body.reasoning_effort, "high");
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30, prompt_tokens_details: { cached_tokens: 5 } } })}\n\n`);
        return res.end("data: [DONE]\n\n");
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 30 } } }));
    });
  });
  const upstreamPort = await listen(upstream);
  const gatewayPort = await availablePort();
  process.env.GATEWAY_DATA_DIR = dataDir;
  process.env.GATEWAY_EMBEDDED = "1";
  fs.writeFileSync(path.join(dataDir, "usage.json"), JSON.stringify({
    version: 1,
    lifetime: {
      requests: 1,
      errors: 0,
      inputTokens: 40,
      outputTokens: 10,
      totalTokens: 50,
      cacheReadTokens: 4,
      cacheWriteTokens: 0,
      firstRequestAt: "2020-01-01T00:00:00.000Z",
      lastRequestAt: "2020-01-01T00:00:00.000Z",
    },
    records: [{
      id: "expired-detail",
      at: "2020-01-01T00:00:00.000Z",
      status: 200,
      inputTokens: 40,
      outputTokens: 10,
      totalTokens: 50,
      cacheReadTokens: 4,
      cacheWriteTokens: 0,
    }],
  }, null, 2), "utf8");
  const gateway = await import(`../gateway/gateway.mjs?test=${Date.now()}`);
  await gateway.startGateway({ port: gatewayPort });
  const origin = `http://127.0.0.1:${gatewayPort}`;
  const syncReasons = [];
  gateway.setSyncChangeHandler((reason) => syncReasons.push(reason));

  const api = async (pathname, options = {}) => {
    const response = await fetch(`${origin}${pathname}`, options);
    const value = await response.json();
    assert.equal(response.ok, true, `${pathname}: ${JSON.stringify(value)}`);
    return value;
  };

  try {
    await api("/admin/api/providers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "route-a", name: "测试线路 A", baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: "sk-test" }) });
    syncReasons.length = 0;
    await api("/admin/api/providers/route-a/test", { method: "POST" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(syncReasons.includes("route-health-change"), "testing a route must schedule cloud sync");
    const created = await api("/admin/api/client-keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ providerId: "route-a", reasoningLevel: "high", nameCustomized: false }) });
    let keys = await api("/admin/api/client-keys");
    assert.equal(keys.keys[0].name, "测试线路 A");
    assert.equal(keys.keys[0].nameCustomized, false);

    await api("/admin/api/providers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "route-a", name: "测试线路 B", baseUrl: `http://127.0.0.1:${upstreamPort}` }) });
    keys = await api("/admin/api/client-keys");
    assert.equal(keys.keys[0].name, "测试线路 B");

    await api(`/admin/api/client-keys/${keys.keys[0].id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ providerId: "route-a", reasoningLevel: "high", name: "Cherry 专用", nameCustomized: true }) });
    await api("/admin/api/providers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "route-a", name: "测试线路 C", baseUrl: `http://127.0.0.1:${upstreamPort}` }) });
    keys = await api("/admin/api/client-keys");
    assert.equal(keys.keys[0].name, "Cherry 专用");
    assert.equal(keys.keys[0].nameCustomized, true);

    for (const stream of [false, true]) {
      const response = await fetch(`${origin}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${created.key}` }, body: JSON.stringify({ model: "gpt-test", stream, messages: [{ role: "user", content: "hello" }] }) });
      assert.equal(response.status, 200);
      await response.text();
    }

    const usage = await api("/admin/api/usage?range=24h&limit=20");
    assert.equal(usage.records.length, 3);
    assert.ok(usage.records.some((record) => record.id === "expired-detail"), "history includes retained records outside the chart's 24-hour range");
    assert.equal(usage.summary.requests, 2);
    assert.equal(usage.summary.totalTokens, 150);
    assert.equal(usage.summary.cacheReadTokens, 35);
    assert.equal(usage.lifetime.totalTokens, 200);
    assert.equal(usage.lifetime.requests, 3);
    assert.equal(usage.lifetime.cacheReadTokens, 39);
    assert.ok(usage.series.some((point) => point.totalTokens === 150));

    // 中文：只有全新设备首次恢复才允许生成本地客户端秘密；普通同步必须保留同一个秘密。
    // English: Only first restore on a pristine device may create a local client secret; normal sync must preserve it.
    const snapshot = gateway.getSyncSnapshot();
    const remoteKeyId = "remote-key-without-secret";
    gateway.replaceConfigFromSync({
      ...snapshot.publicConfig,
      configRevision: { counter: snapshot.publicConfig.configRevision.counter + 1, deviceId: "remote-device" },
      clientKeyMetadata: [{ id: remoteKeyId, name: "恢复的客户端", nameCustomized: true, providerId: "route-a", reasoningLevel: "high", createdAt: "2026-09-17 12:00:00", enabled: true }],
    }, snapshot.secureConfig, { allowGenerateClientSecrets: true });
    const restoredKeys = await api("/admin/api/client-keys");
    assert.equal(restoredKeys.keys[0].id, remoteKeyId);
    assert.equal(restoredKeys.keys[0].hasSecret, true);
    const restoredSecret = await api(`/admin/api/client-keys/${remoteKeyId}/secret`);
    assert.match(restoredSecret.key, /^cg_[A-Za-z0-9_-]{20,}$/);
    assert.equal(JSON.stringify(gateway.getSyncSnapshot().publicConfig).includes(restoredSecret.key), false);
    gateway.replaceConfigFromSync(gateway.getSyncSnapshot().publicConfig, gateway.getSyncSnapshot().secureConfig);
    const sameDeviceSecret = await api(`/admin/api/client-keys/${remoteKeyId}/secret`);
    assert.equal(sameDeviceSecret.key, restoredSecret.key, "same-device sync must never rotate the client key");
    const unknownKeyConfig = {
      ...gateway.getSyncSnapshot().publicConfig,
      clientKeyMetadata: [{ ...gateway.getSyncSnapshot().publicConfig.clientKeyMetadata[0], id: "unknown-key-without-local-secret" }],
    };
    assert.throws(() => gateway.replaceConfigFromSync(unknownKeyConfig, gateway.getSyncSnapshot().secureConfig), /sync_client_key_secret_missing/);

    await gateway.stopGateway();
    const reopenedLedger = new UsageLedger(dataDir);
    const restored = reopenedLedger.snapshot(new URL("http://local/usage?range=24h&limit=20"));
    assert.equal(restored.lifetime.totalTokens, 200);
    assert.equal(restored.lifetime.requests, 3);
    assert.equal(restored.records.length, 3);
    reopenedLedger.close();
    assert.ok(fs.existsSync(path.join(dataDir, "usage.db")));
    assert.ok(fs.readdirSync(path.join(dataDir, "backups")).some((name) => name.startsWith("usage-legacy-")));
  } finally {
    if (gateway.server.listening) await gateway.stopGateway();
    await close(upstream);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
