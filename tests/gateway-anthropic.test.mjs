// 中文：只用隔离假数据和本机模拟上游核对 Claude 协议，禁止读取真实线路密钥。
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const listen = (server) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(server.address().port));
});
const close = (server) => new Promise((resolve) => {
  server.closeAllConnections();
  server.close(resolve);
});

test("Claude protocol passes through the real gateway without leaking client secrets", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cherry-anthropic-test-"));
  const captured = [];
  let releaseStream;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
    captured.push({ url: req.url, headers: req.headers, body });
    if (/\/v1\/v1\//.test(req.url)) {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { type: "not_found_error", message: "duplicate version path" } }));
    }
    if (req.url.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "claude-opus-5-5" }] }));
    }
    if (body?.model === "unavailable-model") {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { type: "not_found_error", message: "model unavailable" } }));
    }
    if (body?.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":0}}}\n\n');
      await new Promise((resolve) => { releaseStream = resolve; });
      res.end('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "message", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 3, output_tokens: 2 } }));
  });
  const upstreamPort = await listen(upstream);
  const probe = http.createServer();
  const gatewayPort = await listen(probe);
  await close(probe);
  process.env.GATEWAY_DATA_DIR = dataDir;
  process.env.GATEWAY_EMBEDDED = "1";
  process.env.CODEX_USAGE_ORIGIN = "http://127.0.0.1:1";
  const gateway = await import(process.env.CHERRY_GATEWAY_MODULE || "../gateway/gateway.mjs");
  const origin = `http://127.0.0.1:${gatewayPort}`;
  const api = async (pathname, body) => {
    const response = await fetch(`${origin}${pathname}`, body ? {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    } : {});
    assert.equal(response.status, 200);
    return response.json();
  };
  const providerKey = "fake-upstream-key";
  let localKey;
  const request = (pathname, body = {}, headers = {}) => fetch(`${origin}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${localKey}`, ...headers },
    body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 16, messages: [{ role: "user", content: "hello" }], ...body }),
  });
  try {
    await gateway.startGateway({ port: gatewayPort });
    await api("/admin/api/providers", { id: "claude-test", baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: providerKey });
    localKey = (await api("/admin/api/client-keys", { providerId: "claude-test", reasoningLevel: "unchanged" })).key;

    await t.test("duplicate /v1 is normalized and query/header/body are preserved", async () => {
      const body = { thinking: { type: "adaptive" }, tools: [{ name: "test", input_schema: { type: "object" } }], system: "system" };
      const response = await request("/v1/v1/messages?beta=true", body, { "anthropic-version": "2023-06-01", "anthropic-beta": "fake-beta", "x-gateway-key": localKey });
      assert.equal(response.status, 200);
      await response.text();
      const call = captured.at(-1);
      assert.equal(call.url, "/v1/messages?beta=true");
      assert.equal(call.headers.authorization, `Bearer ${providerKey}`);
      assert.equal(call.headers["x-api-key"], providerKey);
      assert.equal(call.headers["anthropic-beta"], "fake-beta");
      assert.equal(call.headers["x-gateway-key"], undefined);
      assert.equal(JSON.stringify(call).includes(localKey), false);
      assert.deepEqual(call.body.thinking, body.thinking);
      assert.deepEqual(call.body.tools, body.tools);
      assert.equal(call.body.model, "claude-opus-5-5");
      assert.equal(call.body.system, "system");
      assert.equal(call.body.reasoning_effort, undefined);
    });

    await t.test("native x-api-key authentication and default API version work", async () => {
      const response = await request("/v1/messages/count_tokens", {}, { authorization: "", "x-api-key": localKey });
      assert.equal(response.status, 200);
      await response.text();
      assert.equal(captured.at(-1).url, "/v1/messages/count_tokens");
      assert.equal(captured.at(-1).headers["x-api-key"], providerKey);
      assert.equal(captured.at(-1).headers["anthropic-version"], "2023-06-01");
    });

    await t.test("base URLs without /v1 and with a custom prefix compose correctly", async () => {
      for (const prefix of ["", "/relay/v1"]) {
        await api("/admin/api/providers", { id: "claude-test", baseUrl: `http://127.0.0.1:${upstreamPort}${prefix}` });
        const response = await request("/v1/v1/v1/messages");
        assert.equal(response.status, 200);
        await response.text();
        assert.equal(captured.at(-1).url, prefix ? "/relay/v1/messages" : "/v1/messages");
      }
      await api("/admin/api/providers", { id: "claude-test", baseUrl: `http://127.0.0.1:${upstreamPort}/v1` });
    });

    await t.test("OpenAI authentication is unchanged and inbound x-api-key does not leak", async () => {
      const response = await request("/v1/chat/completions", { model: "gpt-test" }, { "x-api-key": localKey });
      assert.equal(response.status, 200);
      await response.text();
      assert.equal(captured.at(-1).headers.authorization, `Bearer ${providerKey}`);
      assert.equal(captured.at(-1).headers["x-api-key"], undefined);
      const count = captured.length;
      const denied = await request("/v1/chat/completions", {}, { authorization: "", "x-api-key": localKey });
      assert.equal(denied.status, 401);
      await denied.text();
      assert.equal(captured.length, count);
    });

    await t.test("unknown local keys never reach upstream", async () => {
      const count = captured.length;
      const response = await request("/v1/messages", {}, { authorization: "", "x-api-key": "invalid-local-key" });
      assert.equal(response.status, 401);
      await response.text();
      assert.equal(captured.length, count);
    });

    await t.test("upstream model errors pass through once without automatic retries", async () => {
      const count = captured.length;
      const response = await request("/v1/messages", { model: "unavailable-model" });
      assert.equal(response.status, 404);
      assert.equal((await response.json()).error.message, "model unavailable");
      assert.equal(captured.length, count + 1);
    });

    await t.test("Claude SSE reaches the client before upstream completes and usage is collected", async () => {
      const response = await request("/v1/v1/messages", { stream: true });
      assert.equal(response.status, 200);
      const reader = response.body.getReader();
      try {
        const first = await reader.read();
        assert.equal(first.done, false);
        assert.match(Buffer.from(first.value).toString(), /event: message_start/);
        releaseStream();
        let remaining = "";
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          remaining += Buffer.from(part.value).toString();
        }
        assert.match(remaining, /event: message_stop/);
      } finally { releaseStream?.(); }
      const usage = await api("/admin/api/usage?range=24h&limit=100");
      const record = usage.records.find((item) => item.stream);
      assert.equal(record.status, 200);
      assert.equal(record.inputTokens, 12);
      assert.equal(record.outputTokens, 7);
      assert.equal(record.totalTokens, 19);
      assert.equal(record.endpoint, "/v1/v1/messages", "retain the original client path for diagnostics");
    });

    await t.test("browser preflight accepts Anthropic request headers", async () => {
      const response = await fetch(`${origin}/v1/messages`, { method: "OPTIONS" });
      assert.equal(response.status, 204);
      for (const name of ["x-api-key", "anthropic-version", "anthropic-beta"]) {
        assert.ok(response.headers.get("access-control-allow-headers").includes(name));
      }
    });
  } finally {
    releaseStream?.();
    await gateway.stopGateway();
    await close(upstream);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
