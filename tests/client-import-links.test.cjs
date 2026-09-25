const assert = require("node:assert/strict");
const test = require("node:test");
const { buildClientImportDeepLink } = require("../electron/client-import-links.cjs");

const clientKey = {
  id: "local-key_01",
  name: "测试线路 Key",
  providerName: "测试线路",
  apiKey: "cg_secret+with/slash=",
  model: "gpt-5.6-luna",
};

test("CC Switch link imports a Codex provider through the current local gateway", () => {
  const link = buildClientImportDeepLink("ccswitch", clientKey, 32123);
  const parsed = new URL(link);
  assert.equal(parsed.protocol, "ccswitch:");
  assert.equal(parsed.hostname, "v1");
  assert.equal(parsed.pathname, "/import");
  assert.equal(parsed.searchParams.get("resource"), "provider");
  assert.equal(parsed.searchParams.get("app"), "codex");
  assert.equal(parsed.searchParams.get("endpoint"), "http://127.0.0.1:32123/v1");
  assert.equal(parsed.searchParams.get("apiKey"), clientKey.apiKey);
  assert.equal(parsed.searchParams.get("model"), clientKey.model);
  assert.equal(parsed.searchParams.get("name"), "Dingji · 测试线路 Key");
});

test("Cherry Studio link carries a single local OpenAI-compatible provider at the server root", () => {
  const link = buildClientImportDeepLink("cherry-studio", clientKey, 27891);
  const parsed = new URL(link);
  assert.equal(parsed.protocol, "cherrystudio:");
  assert.equal(parsed.hostname, "providers");
  assert.equal(parsed.pathname, "/api-keys");
  assert.equal(parsed.searchParams.get("v"), "1");
  const provider = JSON.parse(Buffer.from(parsed.searchParams.get("data"), "base64").toString("utf8"));
  assert.deepEqual(provider, {
    id: "cherry-ai-connect-local-key_01",
    name: "Dingji · 测试线路 Key",
    baseUrl: "http://127.0.0.1:27891",
    apiKey: clientKey.apiKey,
    type: "openai",
  });
  assert.equal(provider.baseUrl.endsWith("/v1"), false);
});

test("import links reject unsupported targets, incomplete secrets, invalid identifiers, and unsafe ports", () => {
  assert.throws(() => buildClientImportDeepLink("browser", clientKey, 27891), /unsupported_import_target/);
  assert.throws(() => buildClientImportDeepLink("ccswitch", { ...clientKey, apiKey: " " }, 27891), /client_key_secret_unavailable/);
  assert.throws(() => buildClientImportDeepLink("cherry-studio", { ...clientKey, id: "../key" }, 27891), /invalid_client_key_id/);
  assert.throws(() => buildClientImportDeepLink("ccswitch", clientKey, 0), /invalid_gateway_port/);
  assert.throws(() => buildClientImportDeepLink("ccswitch", clientKey, 65536), /invalid_gateway_port/);
});
