/**
 * 中文：验证模型目录失败不会误判线路不可用，并覆盖 Cherry Studio 导入后实际调用的兼容链路。
 * English: Ensure catalog failures do not disable a route and cover the compatibility path used
 * by Cherry Studio after importing a provider.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

test("provider catalog incompatibility keeps Cherry Studio route usable", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cherry-provider-health-"));
  let exposeModels = true;
  const upstream = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      if (exposeModels) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ object: "list", data: [{ id: "gpt-cached" }] }));
      }
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "models endpoint is not exposed" } }));
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      if (req.headers["x-test-redirect"] === "1") {
        res.writeHead(302, { location: "/v1/chat/completions" });
        return res.end();
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    }
    res.writeHead(404);
    return res.end();
  });
  const upstreamPort = await listen(upstream);
  const previousDataDir = process.env.GATEWAY_DATA_DIR;
  const previousEmbedded = process.env.GATEWAY_EMBEDDED;
  process.env.GATEWAY_DATA_DIR = dataDir;
  process.env.GATEWAY_EMBEDDED = "1";
  const gateway = await import(`../gateway/gateway.mjs?provider-health=${Date.now()}`);
  const gatewayPort = await new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
  await gateway.startGateway({ port: gatewayPort });
  const origin = `http://127.0.0.1:${gatewayPort}`;
  const jsonFetch = async (url, options = {}) => {
    const response = await fetch(`${origin}${url}`, options);
    return { response, body: await response.json() };
  };

  try {
    const created = await jsonFetch("/admin/api/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "catalogless", name: "Catalogless route", baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: "sk-test" }),
    });
    assert.equal(created.response.status, 200);

    const seeded = await jsonFetch("/admin/api/providers/catalogless/test", { method: "POST" });
    assert.equal(seeded.response.status, 200);
    assert.deepEqual(seeded.body.models, ["gpt-cached"]);
    exposeModels = false;
    const tested = await jsonFetch("/admin/api/providers/catalogless/test", { method: "POST" });
    assert.equal(tested.response.status, 502);
    assert.equal(tested.body.phase, "model-list");
    assert.equal(tested.body.modelListStatus, "unsupported");
    assert.equal(tested.body.routeEnabled, true);
    assert.equal(tested.body.routeVerified, true, "cached models keep a usable route when catalog discovery is unsupported");

    const providers = await jsonFetch("/admin/api/providers");
    assert.equal(providers.body.providers[0].enabled, true);
    assert.equal(providers.body.providers[0].modelListStatus, "unsupported");
    assert.equal(providers.body.providers[0].routeVerified, true);

    const key = await jsonFetch("/admin/api/client-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: "catalogless", reasoningLevel: "unchanged", nameCustomized: false }),
    });
    assert.equal(key.response.status, 200);
    const chat = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key.body.key}` },
      body: JSON.stringify({ model: "gpt-cached", messages: [{ role: "user", content: "hello" }] }),
    });
    assert.equal(chat.status, 200);
    assert.equal((await chat.json()).choices[0].message.content, "ok");
    await new Promise((resolve) => setImmediate(resolve));
    const status = await jsonFetch("/admin/api/status");
    assert.equal(status.body.lastClientRequestStatus, "ok");

    const redirected = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", authorization: `Bearer ${key.body.key}`, "x-test-redirect": "1" },
      body: JSON.stringify({ model: "gpt-cached", messages: [{ role: "user", content: "redirect" }] }),
    });
    assert.equal(redirected.status, 302);
    await new Promise((resolve) => setImmediate(resolve));
    const redirectedStatus = await jsonFetch("/admin/api/status");
    assert.equal(redirectedStatus.body.lastClientRequestStatus, "error");

    const importedModels = await fetch(`${origin}/v1/models`, { headers: { authorization: `Bearer ${key.body.key}` } });
    assert.equal(importedModels.status, 200);
    assert.deepEqual((await importedModels.json()).data.map((item) => item.id), ["gpt-cached"]);

    const uncached = await jsonFetch("/admin/api/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "uncached", name: "Uncached route", baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: "sk-test" }),
    });
    assert.equal(uncached.response.status, 200);
    const uncachedTest = await jsonFetch("/admin/api/providers/uncached/test", { method: "POST" });
    assert.equal(uncachedTest.response.status, 502);
    assert.equal(uncachedTest.body.routeVerified, false, "an unsupported catalog without cached models is not verified as ready");

    const changed = await jsonFetch("/admin/api/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "catalogless", name: "Changed route", baseUrl: "http://127.0.0.1:1", apiKey: "sk-new" }),
    });
    assert.equal(changed.response.status, 200);
    assert.equal(changed.body.provider.modelCount, 0, "changing upstream identity must clear the old model catalog");
  } finally {
    if (gateway.server.listening) await gateway.stopGateway();
    await close(upstream);
    if (previousDataDir === undefined) delete process.env.GATEWAY_DATA_DIR;
    else process.env.GATEWAY_DATA_DIR = previousDataDir;
    if (previousEmbedded === undefined) delete process.env.GATEWAY_EMBEDDED;
    else process.env.GATEWAY_EMBEDDED = previousEmbedded;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
