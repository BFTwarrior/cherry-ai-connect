/**
 * 中文：本地网关接收客户端请求，校验本地 Key，并把请求转发到绑定的上游线路。
 * English: The local gateway authenticates client keys and forwards requests to their bound upstream route.
 */
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.GATEWAY_DATA_DIR || path.join(root, "data");
const configFile = path.join(dataDir, "config.json");
const secretFile = path.join(dataDir, ".gateway-secret");
const listenHost = process.env.GATEWAY_HOST || "127.0.0.1";
let listenPort = Number(process.env.GATEWAY_PORT || 27891);
const gatewayVersion = "0.4.3";
const supportedReasoningLevels = ["low", "medium", "high", "xhigh", "max"];

fs.mkdirSync(dataDir, { recursive: true });

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function getSecret() {
  if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString("base64url"), "utf8");
  return fs.readFileSync(secretFile, "utf8").trim();
}

const cipherKey = crypto.createHash("sha256").update(getSecret()).digest();

function encrypt(value) {
  if (!value) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", cipherKey, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

function decrypt(value) {
  if (!value) return "";
  try {
    const [iv, tag, data] = value.split(".");
    const decipher = crypto.createDecipheriv("aes-256-gcm", cipherKey, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  } catch { return ""; }
}

let config = readJson(configFile, {
  version: 1,
  forcedLevel: "high",
  defaultProvider: "",
  providers: [],
  clientKeys: [],
  lastClientRequest: { at: "", status: "never", model: "" },
});

function validReasoningLevel(value) {
  return supportedReasoningLevels.includes(String(value));
}

function uniqueModels(value) {
  return Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean).filter((item, index, list) => list.indexOf(item) === index) : [];
}

function saveConfig() { writeJson(configFile, config); }

function migrateConfig() {
  const before = JSON.stringify(config);
  config = config && typeof config === "object" ? config : {};
  config.version = Number(config.version || 1);
  config.forcedLevel = validReasoningLevel(config.forcedLevel) ? config.forcedLevel : "high";
  config.providers = Array.isArray(config.providers) ? config.providers : [];
  config.clientKeys = Array.isArray(config.clientKeys) ? config.clientKeys : [];
  const requestStatus = ["never", "pending", "ok", "error"].includes(config.lastClientRequest?.status)
    ? config.lastClientRequest.status
    : "never";
  config.lastClientRequest = {
    at: String(config.lastClientRequest?.at || ""),
    status: requestStatus,
    model: String(config.lastClientRequest?.model || ""),
  };
  for (const provider of config.providers) {
    provider.id = String(provider.id || "").trim();
    provider.name = String(provider.name || provider.id || "未命名线路");
    provider.baseUrl = String(provider.baseUrl || "").replace(/\/+$/, "");
    provider.models = uniqueModels(provider.models);
    provider.enabled = provider.enabled !== false;
    provider.modelFetchedAt = String(provider.modelFetchedAt || "");
    provider.lastTestStatus = ["ok", "error", "never"].includes(provider.lastTestStatus) ? provider.lastTestStatus : (provider.modelFetchedAt && provider.models.length ? "ok" : "never");
    provider.lastTestAt = String(provider.lastTestAt || "");
    provider.lastError = String(provider.lastError || "");
  }
  const fallbackProvider = String(config.defaultProvider || config.providers.find((item) => item.enabled)?.id || "");
  config.defaultProvider = fallbackProvider;
  for (const item of config.clientKeys) {
    if (!item.id) item.id = crypto.randomUUID();
    item.name = String(item.name || "客户端");
    item.providerId = String(item.providerId || fallbackProvider);
    item.reasoningLevel = validReasoningLevel(item.reasoningLevel) ? item.reasoningLevel : config.forcedLevel;
    item.keyEnc = String(item.keyEnc || "");
    item.createdAt = String(item.createdAt || new Date().toLocaleString("zh-CN"));
    item.enabled = item.enabled !== false;
  }
  if (JSON.stringify(config) !== before) saveConfig();
}

migrateConfig();

let lastClientRequestAt = config.lastClientRequest.at;
let lastClientRequestStatus = config.lastClientRequest.status;
let lastClientRequestModel = config.lastClientRequest.model;

function updateClientRequestStatus(status, model = lastClientRequestModel) {
  lastClientRequestAt = new Date().toISOString();
  lastClientRequestStatus = status;
  lastClientRequestModel = String(model || "");
  config.lastClientRequest = {
    at: lastClientRequestAt,
    status: lastClientRequestStatus,
    model: lastClientRequestModel,
  };
  saveConfig();
}

function hashKey(key) { return crypto.createHash("sha256").update(key).digest("hex"); }
function makeClientKey() { return `cg_${crypto.randomBytes(24).toString("base64url")}`; }

function json(res, status, value) {
  if (status === 204) {
    res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization, x-gateway-key", "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS" });
    return res.end();
  }
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, authorization, x-gateway-key",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  });
  res.end(body);
}

function bodyJson(buffer) {
  try { return JSON.parse(buffer.toString("utf8")); } catch { return null; }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 25 * 1024 * 1024) {
        req.destroy(new Error("request_too_large"));
        reject(new Error("request_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function getClientKey(req) {
  const header = String(req.headers["x-gateway-key"] || "").trim();
  if (header) return header;
  const auth = String(req.headers.authorization || "");
  return /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, "").trim() : "";
}

function getAuthorizedClient(req) {
  const key = getClientKey(req);
  return key ? config.clientKeys.find((item) => item.hash === hashKey(key) && item.enabled !== false) : null;
}

function providerView(provider) {
  const clientKeyCount = config.clientKeys.filter((item) => item.providerId === provider.id).length;
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    models: uniqueModels(provider.models),
    modelCount: uniqueModels(provider.models).length,
    enabled: provider.enabled !== false,
    hasApiKey: Boolean(provider.apiKeyEnc && decrypt(provider.apiKeyEnc)),
    modelFetchedAt: provider.modelFetchedAt || "",
    lastTestAt: provider.lastTestAt || "",
    lastTestStatus: provider.lastTestStatus || "never",
    lastLatencyMs: Number(provider.lastLatencyMs || 0) || undefined,
    lastError: provider.lastError || "",
    clientKeyCount,
  };
}

function findProvider(id) {
  return config.providers.find((item) => item.id === id && item.enabled !== false);
}

function selectProvider(model) {
  const text = String(model || "");
  const slash = text.indexOf("/");
  if (slash > 0) {
    const provider = findProvider(text.slice(0, slash));
    if (provider) return { provider, model: text.slice(slash + 1) };
  }
  const provider = findProvider(config.defaultProvider) || config.providers.find((item) => item.enabled !== false);
  return { provider, model: text };
}

function forceReasoning(payload, pathname, levelOverride = "") {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
  const level = validReasoningLevel(levelOverride) ? levelOverride : (config.forcedLevel || "high");
  if (pathname.includes("/responses")) {
    payload.reasoning = { ...(payload.reasoning && typeof payload.reasoning === "object" ? payload.reasoning : {}), effort: level };
    if (Object.prototype.hasOwnProperty.call(payload, "reasoning_effort")) payload.reasoning_effort = level;
    if (Object.prototype.hasOwnProperty.call(payload, "reasoningEffort")) payload.reasoningEffort = level;
  }
  if (pathname.includes("/chat/completions")) {
    payload.reasoning_effort = level;
    if (Object.prototype.hasOwnProperty.call(payload, "reasoningEffort")) payload.reasoningEffort = level;
  }
}

function targetUrl(baseUrl, incomingPath) {
  const base = new URL(baseUrl);
  const incoming = new URL(incomingPath, "http://gateway.local");
  const basePath = base.pathname.replace(/\/+$/, "");
  let pathPart = incoming.pathname || "/";
  if (basePath.endsWith("/v1") && pathPart.startsWith("/v1")) pathPart = pathPart.slice(3) || "/";
  base.pathname = `${basePath}${pathPart}`.replace(/\/\/+/g, "/");
  base.search = incoming.search;
  return base;
}

function requestUpstream(target, method, headers, callback) {
  const client = target.protocol === "https:" ? https : http;
  const request = client.request({ protocol: target.protocol, hostname: target.hostname, port: target.port || undefined, method, path: `${target.pathname}${target.search}`, headers }, callback);
  request.setTimeout(120000, () => request.destroy(new Error("upstream_timeout")));
  return request;
}

async function proxyRequest(req, res, rawBody) {
  const client = getAuthorizedClient(req);
  if (!client) return json(res, 401, { error: "invalid_gateway_key" });
  const payload = bodyJson(rawBody) || {};
  if (typeof payload !== "object" || Array.isArray(payload)) return json(res, 400, { error: "json_body_required" });
  const boundProvider = client.providerId ? findProvider(client.providerId) : null;
  if (client.providerId && !boundProvider) return json(res, 503, { error: "bound_provider_unavailable", provider: client.providerId });
  const selected = boundProvider ? { provider: boundProvider, model: String(payload.model || "").includes("/") ? String(payload.model).split("/").slice(1).join("/") : payload.model } : selectProvider(payload.model);
  if (!selected.provider) return json(res, 503, { error: "no_provider_configured" });
  if (selected.model && payload.model) payload.model = selected.model;
  const pathname = new URL(req.url || "/", "http://gateway.local").pathname;
  forceReasoning(payload, pathname, client.reasoningLevel);
  const body = Buffer.from(JSON.stringify(payload));
  const target = targetUrl(selected.provider.baseUrl, req.url || "/");
  const headers = { ...req.headers, host: target.host, "content-length": body.length };
  delete headers.authorization;
  delete headers["x-gateway-key"];
  delete headers.connection;
  delete headers["transfer-encoding"];
  const apiKey = decrypt(selected.provider.apiKeyEnc);
  if (!apiKey) return json(res, 503, { error: "provider_key_missing", provider: selected.provider.id });
  updateClientRequestStatus("pending", payload.model);
  headers.authorization = `Bearer ${apiKey}`;
  const upstreamReq = requestUpstream(target, req.method, headers, (upstreamRes) => {
    updateClientRequestStatus(upstreamRes.statusCode && upstreamRes.statusCode >= 200 && upstreamRes.statusCode < 400 ? "ok" : "error", payload.model);
    res.writeHead(upstreamRes.statusCode || 502, {
      ...upstreamRes.headers,
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type, authorization, x-gateway-key",
    });
    upstreamRes.pipe(res);
  });
  upstreamReq.on("error", (error) => {
    updateClientRequestStatus("error", payload.model);
    console.error(`[上游错误] ${selected.provider.id} ${error.message}`);
    if (!res.headersSent) json(res, 502, { error: "upstream_error", provider: selected.provider.id, detail: error.message });
    else res.destroy();
  });
  upstreamReq.end(body);
  console.log(`[转发] ${selected.provider.id} ${req.method} ${req.url} reasoning=${client.reasoningLevel || config.forcedLevel} client=${client.id}`);
}

async function fetchProviderModels(provider) {
  const target = targetUrl(provider.baseUrl, "/v1/models");
  const apiKey = decrypt(provider.apiKeyEnc);
  if (!apiKey) throw new Error("中转站 Key 未填写");
  const headers = { accept: "application/json", authorization: `Bearer ${apiKey}` };
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const request = requestUpstream(target, "GET", headers, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const data = bodyJson(Buffer.concat(chunks));
        if (response.statusCode >= 200 && response.statusCode < 300) {
          const rawModels = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
          const models = uniqueModels(rawModels.map((item) => typeof item === "string" ? item : item?.id || item?.name));
          resolve({ status: response.statusCode, latencyMs: Date.now() - started, models });
        } else {
          reject(new Error(`HTTP ${response.statusCode}${data?.error?.message ? `: ${data.error.message}` : ""}`));
        }
      });
    });
    request.on("error", reject);
    request.end();
  });
}

function providerErrorMessage(error, provider) {
  const code = String(error?.code || "");
  const raw = String(error?.message || error || "未知错误").trim();
  if (code === "ECONNREFUSED") return `无法连接中转站（ECONNREFUSED）：请检查 API URL、端口和网络代理。地址：${provider.baseUrl}`;
  if (code === "ENOTFOUND") return `找不到中转站域名（ENOTFOUND）：请检查 API URL、DNS 和网络代理。地址：${provider.baseUrl}`;
  if (code === "ETIMEDOUT" || raw === "upstream_timeout") return `连接中转站超时：请检查网络代理、线路速度和上游状态。地址：${provider.baseUrl}`;
  if (/^HTTP (401|403)/.test(raw)) return `${raw}：请检查中转站 Key 是否有效，以及线路是否有访问权限。`;
  return raw;
}

async function admin(req, res, url) {
  if (req.method === "GET" && url.pathname === "/admin") {
    const adminFile = path.join(root, "admin.html");
    if (!fs.existsSync(adminFile)) return json(res, 404, { error: "admin_page_not_installed" });
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(fs.readFileSync(adminFile, "utf8"));
  }
  if (url.pathname === "/admin/api/providers" && req.method === "GET") return json(res, 200, { version: gatewayVersion, providers: config.providers.map(providerView) });
  if (url.pathname === "/admin/api/settings" && req.method === "GET") return json(res, 200, { forcedLevel: config.forcedLevel || "high", defaultProvider: config.defaultProvider || "", reasoningLevels: supportedReasoningLevels });
  if (url.pathname === "/admin/api/status" && req.method === "GET") return json(res, 200, { version: gatewayVersion, forcedLevel: config.forcedLevel || "high", lastClientRequestAt, lastClientRequestStatus, lastClientRequestModel });
  if (url.pathname === "/admin/api/providers" && req.method === "POST") {
    const data = bodyJson(await readBody(req)) || {};
    if (!data.id || !data.baseUrl) return json(res, 400, { error: "线路代号和 API URL 必填" });
    let baseUrl;
    try {
      baseUrl = new URL(String(data.baseUrl).trim());
      if (!/^https?:$/.test(baseUrl.protocol)) throw new Error("protocol");
    } catch { return json(res, 400, { error: "API URL 不是有效的 HTTP/HTTPS 地址" }); }
    const id = String(data.id).trim().replace(/[^a-zA-Z0-9_-]/g, "");
    if (!id) return json(res, 400, { error: "线路代号只能使用字母、数字、下划线或短横线" });
    const old = config.providers.find((item) => item.id === id);
    const normalizedUrl = baseUrl.toString().replace(/\/+$/, "");
    const provider = {
      ...(old || {}),
      id,
      name: String(data.name || id).trim(),
      baseUrl: normalizedUrl,
      models: old?.models || [],
      modelFetchedAt: old?.modelFetchedAt || "",
      enabled: true,
      apiKeyEnc: data.apiKey ? encrypt(String(data.apiKey).trim()) : (old?.apiKeyEnc || ""),
      lastTestStatus: old && old.baseUrl === normalizedUrl && !data.apiKey ? (old.lastTestStatus || "never") : "never",
      lastTestAt: old && old.baseUrl === normalizedUrl && !data.apiKey ? (old.lastTestAt || "") : "",
      lastLatencyMs: old && old.baseUrl === normalizedUrl && !data.apiKey ? old.lastLatencyMs : undefined,
      lastError: old && old.baseUrl === normalizedUrl && !data.apiKey ? (old.lastError || "") : "",
    };
    config.providers = old ? config.providers.map((item) => item.id === id ? provider : item) : [...config.providers, provider];
    if (!config.defaultProvider) config.defaultProvider = id;
    saveConfig();
    return json(res, 200, { ok: true, provider: providerView(provider) });
  }
  const providerTest = url.pathname.match(/^\/admin\/api\/providers\/([^/]+)\/test$/);
  if (providerTest && req.method === "POST") {
    const provider = findProvider(decodeURIComponent(providerTest[1]));
    if (!provider) return json(res, 404, { error: "线路不存在" });
    try {
      const result = await fetchProviderModels(provider);
      provider.models = result.models;
      provider.modelFetchedAt = new Date().toISOString();
      provider.lastTestAt = provider.modelFetchedAt;
      provider.lastTestStatus = "ok";
      provider.lastLatencyMs = result.latencyMs;
      provider.lastError = "";
      saveConfig();
      return json(res, 200, { ok: true, status: result.status, latencyMs: result.latencyMs, models: result.models, provider: providerView(provider) });
    } catch (error) {
      provider.lastTestAt = new Date().toISOString();
      provider.lastTestStatus = "error";
      provider.lastError = providerErrorMessage(error, provider);
      saveConfig();
      return json(res, 502, { ok: false, error: provider.lastError });
    }
  }
  if (url.pathname === "/admin/api/settings" && req.method === "POST") {
    const data = bodyJson(await readBody(req)) || {};
    if (Object.prototype.hasOwnProperty.call(data, "defaultProvider")) {
      if (data.defaultProvider && !findProvider(String(data.defaultProvider))) return json(res, 400, { error: "默认线路不存在" });
      config.defaultProvider = String(data.defaultProvider || "");
    }
    if (data.forcedLevel && !validReasoningLevel(data.forcedLevel)) return json(res, 400, { error: "思考强度无效" });
    if (data.forcedLevel) config.forcedLevel = String(data.forcedLevel);
    if (data.applyToExisting && data.forcedLevel) for (const item of config.clientKeys) item.reasoningLevel = config.forcedLevel;
    saveConfig();
    return json(res, 200, { ok: true, forcedLevel: config.forcedLevel, defaultProvider: config.defaultProvider, reasoningLevels: supportedReasoningLevels });
  }
  if (url.pathname === "/admin/api/client-keys" && req.method === "GET") {
    return json(res, 200, { keys: config.clientKeys.map((item) => ({ id: item.id, name: item.name, providerId: item.providerId, providerName: config.providers.find((provider) => provider.id === item.providerId)?.name || "未绑定", reasoningLevel: validReasoningLevel(item.reasoningLevel) ? item.reasoningLevel : config.forcedLevel || "high", createdAt: item.createdAt, enabled: item.enabled !== false, hasSecret: Boolean(item.keyEnc && decrypt(item.keyEnc)) })) });
  }
  if (url.pathname === "/admin/api/client-keys" && req.method === "POST") {
    const data = bodyJson(await readBody(req)) || {};
    const providerId = String(data.providerId || "");
    if (!providerId || !findProvider(providerId)) return json(res, 400, { error: "必须绑定一个有效的中转站线路" });
    const reasoningLevel = validReasoningLevel(data.reasoningLevel) ? String(data.reasoningLevel) : (config.forcedLevel || "high");
    const key = makeClientKey();
    const item = { id: crypto.randomUUID(), name: String(data.name || "客户端").trim(), providerId, reasoningLevel, hash: hashKey(key), keyEnc: encrypt(key), createdAt: new Date().toLocaleString("zh-CN"), enabled: true };
    config.clientKeys.push(item);
    saveConfig();
    return json(res, 200, { ok: true, key, id: item.id });
  }
  const keyTestRoute = url.pathname.match(/^\/admin\/api\/client-keys\/([^/]+)\/test$/);
  if (keyTestRoute && req.method === "POST") {
    const item = config.clientKeys.find((entry) => entry.id === keyTestRoute[1]);
    if (!item) return json(res, 404, { error: "客户端 Key 不存在" });
    if (item.enabled === false) return json(res, 409, { error: "客户端 Key 已停用，请先启用后再测试" });
    const provider = findProvider(item.providerId);
    if (!provider) return json(res, 503, { error: "绑定线路不可用，请先检查线路" });
    updateClientRequestStatus("pending", "client-key-test");
    try {
      const clientSecret = decrypt(item.keyEnc);
      let modelCount = 0;
      if (clientSecret) {
        const response = await fetch(`http://${listenHost}:${listenPort}/v1/models`, {
          headers: { authorization: `Bearer ${clientSecret}` },
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(String(data?.error || `HTTP ${response.status}`));
        modelCount = Array.isArray(data?.data) ? data.data.length : 0;
      } else {
        const result = await fetchProviderModels(provider);
        modelCount = result.models.length;
      }
      updateClientRequestStatus("ok", "client-key-test");
      return json(res, 200, { ok: true, providerId: provider.id, modelCount });
    } catch (error) {
      updateClientRequestStatus("error", "client-key-test");
      return json(res, 502, { ok: false, error: providerErrorMessage(error, provider) });
    }
  }
  const keySecretRoute = url.pathname.match(/^\/admin\/api\/client-keys\/([^/]+)\/secret$/);
  if (keySecretRoute && req.method === "GET") {
    const item = config.clientKeys.find((entry) => entry.id === keySecretRoute[1]);
    if (!item) return json(res, 404, { error: "客户端 Key 不存在" });
    const key = decrypt(item.keyEnc);
    if (!key) return json(res, 409, { error: "这个客户端 Key 来自旧版本，无法恢复；请使用“重新生成 Key”" });
    return json(res, 200, { ok: true, key });
  }
  const keyRotateRoute = url.pathname.match(/^\/admin\/api\/client-keys\/([^/]+)\/rotate$/);
  if (keyRotateRoute && req.method === "POST") {
    const item = config.clientKeys.find((entry) => entry.id === keyRotateRoute[1]);
    if (!item) return json(res, 404, { error: "客户端 Key 不存在" });
    const key = makeClientKey();
    item.hash = hashKey(key);
    item.keyEnc = encrypt(key);
    saveConfig();
    return json(res, 200, { ok: true, key });
  }
  const keyRoute = url.pathname.match(/^\/admin\/api\/client-keys\/([^/]+)$/);
  if (keyRoute && req.method === "PUT") {
    const data = bodyJson(await readBody(req)) || {};
    const item = config.clientKeys.find((entry) => entry.id === keyRoute[1]);
    if (!item) return json(res, 404, { error: "客户端 Key 不存在" });
    const providerId = String(data.providerId || item.providerId || "");
    if (!providerId || !findProvider(providerId)) return json(res, 400, { error: "必须绑定一个有效的中转站线路" });
    item.name = String(data.name || item.name || "客户端").trim();
    item.providerId = providerId;
    if (data.reasoningLevel && validReasoningLevel(data.reasoningLevel)) item.reasoningLevel = String(data.reasoningLevel);
    saveConfig();
    return json(res, 200, { ok: true });
  }
  if (keyRoute && req.method === "PATCH") {
    const data = bodyJson(await readBody(req)) || {};
    const item = config.clientKeys.find((entry) => entry.id === keyRoute[1]);
    if (!item) return json(res, 404, { error: "客户端 Key 不存在" });
    if (typeof data.enabled === "boolean") item.enabled = data.enabled;
    saveConfig();
    return json(res, 200, { ok: true, enabled: item.enabled !== false });
  }
  if (keyRoute && req.method === "DELETE") {
    const before = config.clientKeys.length;
    config.clientKeys = config.clientKeys.filter((item) => item.id !== keyRoute[1]);
    if (config.clientKeys.length === before) return json(res, 404, { error: "客户端 Key 不存在" });
    saveConfig();
    return json(res, 200, { ok: true, deleted: true });
  }
  const providerDelete = url.pathname.match(/^\/admin\/api\/providers\/([^/]+)$/);
  if (providerDelete && req.method === "DELETE") {
    const providerId = decodeURIComponent(providerDelete[1]);
    if (config.clientKeys.some((item) => item.providerId === providerId)) return json(res, 409, { error: "仍有客户端 Key 绑定此线路，请先改绑或删除这些 Key" });
    const before = config.providers.length;
    config.providers = config.providers.filter((item) => item.id !== providerId);
    if (config.providers.length === before) return json(res, 404, { error: "线路不存在" });
    if (config.defaultProvider === providerId) config.defaultProvider = config.providers.find((item) => item.enabled !== false)?.id || "";
    saveConfig();
    return json(res, 200, { ok: true, deleted: true });
  }
  return json(res, 404, { error: "not_found" });
}

async function handleRequest(req, res) {
  const url = new URL(req.url || "/", "http://gateway.local");
  if (req.method === "OPTIONS") return json(res, 204, {});
  if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true, version: gatewayVersion, forcedLevel: config.forcedLevel, defaultProvider: config.defaultProvider, providers: config.providers.filter((item) => item.enabled !== false).length });
  if (url.pathname.startsWith("/admin")) return admin(req, res, url);
  if (req.method === "GET" && url.pathname === "/v1/models") {
    const client = getAuthorizedClient(req);
    if (!client) return json(res, 401, { error: "invalid_gateway_key" });
    const models = [];
    const providers = client.providerId ? config.providers.filter((item) => item.id === client.providerId && item.enabled !== false) : config.providers.filter((item) => item.enabled !== false);
    for (const provider of providers) for (const model of uniqueModels(provider.models)) models.push({ id: client.providerId ? model : `${provider.id}/${model}`, object: "model", owned_by: provider.id });
    return json(res, 200, { object: "list", data: models });
  }
  if (["POST", "PUT", "PATCH"].includes(req.method)) return proxyRequest(req, res, await readBody(req));
  return json(res, 404, { error: "unsupported_route" });
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error(`[网关错误] ${error.message}`);
    if (!res.headersSent) json(res, 500, { error: "gateway_error", detail: error.message });
    else res.destroy();
  });
});

const activeSockets = new Set();
server.on("connection", (socket) => {
  activeSockets.add(socket);
  socket.once("close", () => activeSockets.delete(socket));
});

export function startGateway(options = {}) {
  return new Promise((resolve, reject) => {
    if (server.listening) return resolve(server);
    const requestedPort = Number(options.port);
    if (Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort < 65536) listenPort = requestedPort;
    const onError = (error) => { server.off("listening", onListening); reject(error); };
    const onListening = () => {
      server.off("error", onError);
      console.log(`Cherry 多线路网关已启动：http://${listenHost}:${listenPort}`);
      console.log(`管理页面：http://${listenHost}:${listenPort}/admin`);
      console.log(`默认思考等级：${config.forcedLevel}`);
      resolve(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(listenPort, listenHost);
  });
}

export function stopGateway() {
  return new Promise((resolve, reject) => {
    if (!server.listening) return resolve();
    for (const socket of activeSockets) socket.destroy();
    if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    server.close((error) => {
      if (error && error.code !== "ERR_SERVER_NOT_RUNNING") return reject(error);
      resolve();
    });
  });
}

export function getGatewayPort() { return listenPort; }

export { server };

if (process.env.GATEWAY_EMBEDDED !== "1") {
  startGateway().catch((error) => { console.error("网关启动失败", error); process.exitCode = 1; });
}
