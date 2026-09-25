/**
 * 中文：集中生成受限目标客户端的导入深链；调用者不得记录完整链接，链接内含本地客户端 Key。
 * English: Build import deep links only for fixed client targets. Never log the full URL: it contains a local client key.
 */
const CLIENT_IMPORT_TARGETS = new Set(["ccswitch", "cherry-studio"]);

function requiredText(value, code, maxLength = 180) {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, maxLength);
  if (!text) throw new Error(code);
  return text;
}

function localGatewayOrigin(port) {
  const number = Number(port);
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw new Error("invalid_gateway_port");
  return `http://127.0.0.1:${number}`;
}

function buildClientImportDeepLink(target, clientKey, port) {
  if (!CLIENT_IMPORT_TARGETS.has(target)) throw new Error("unsupported_import_target");
  if (!clientKey || typeof clientKey !== "object") throw new Error("client_key_unavailable");

  const id = requiredText(clientKey.id, "client_key_unavailable", 128);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("invalid_client_key_id");
  const name = requiredText(clientKey.name || clientKey.providerName || "Cherry AI Connect", "client_key_unavailable", 100);
  const apiKey = requiredText(clientKey.apiKey, "client_key_secret_unavailable", 512);
  const origin = localGatewayOrigin(port);
  const params = new URLSearchParams();

  if (target === "ccswitch") {
    params.set("resource", "provider");
    params.set("app", "codex");
    params.set("name", `Dingji · ${name}`.slice(0, 120));
    params.set("endpoint", `${origin}/v1`);
    params.set("apiKey", apiKey);
    if (clientKey.model) params.set("model", String(clientKey.model).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 180));
    return `ccswitch://v1/import?${params.toString()}`;
  }

  // Cherry Studio expects the server root here and appends the OpenAI-compatible /v1 paths itself.
  const provider = {
    id: `cherry-ai-connect-${id}`,
    name: `Dingji · ${name}`.slice(0, 120),
    baseUrl: origin,
    apiKey,
    type: "openai",
  };
  params.set("v", "1");
  params.set("data", Buffer.from(JSON.stringify(provider), "utf8").toString("base64"));
  return `cherrystudio://providers/api-keys?${params.toString()}`;
}

module.exports = { buildClientImportDeepLink };
