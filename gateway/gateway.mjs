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
import { StringDecoder } from "node:string_decoder";
import { UsageLedger } from "./usage-ledger.mjs";
import { CODEX_OFFICIAL_SOURCE, CodexUsageClient, combineUsageSnapshots, emptySnapshot } from "./codex-usage-client.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.GATEWAY_DATA_DIR || path.join(root, "data");
const configFile = path.join(dataDir, "config.json");
const secretFile = path.join(dataDir, ".gateway-secret");
// 中文：网关同时承载管理 API 和客户端 API，监听地址不得由外部环境注入；固定在本机 IPv4 回环接口。
// English: The gateway serves both management and client APIs, so its bind address must not be
// controlled by the environment; keep it on the local IPv4 loopback interface.
const listenHost = "127.0.0.1";
let listenPort = Number(process.env.GATEWAY_PORT || 27891);
const gatewayVersion = "1.40.4";
// 中文：unchanged 是显式的“不做更改”策略，不是上游 API 的 reasoning 值。 English: pass-through sentinel, never sent upstream.
const supportedReasoningLevels = ["unchanged", "low", "medium", "high", "xhigh", "max"];
let lastPersistedConfig = null;

fs.mkdirSync(dataDir, { recursive: true });

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("shape");
    if (("providers" in value && !Array.isArray(value.providers))
      || ("clientKeys" in value && !Array.isArray(value.clientKeys))
      || ("configRevision" in value && (!value.configRevision || typeof value.configRevision !== "object" || Array.isArray(value.configRevision)))
      || ("lastClientRequest" in value && (!value.lastClientRequest || typeof value.lastClientRequest !== "object" || Array.isArray(value.lastClientRequest)))) {
      throw new Error("shape");
    }
    return value;
  } catch {
    throw new Error("gateway_config_file_invalid");
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  try { fs.renameSync(temporary, file); }
  catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* best effort cleanup */ }
    throw error;
  }
}

function emptyUsageTotals() {
  return {
    requests: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    firstRequestAt: "",
    lastRequestAt: "",
  };
}

function finiteToken(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.round(parsed);
  }
  return 0;
}

function normalizedUsage(value) {
  const usage = value && typeof value === "object" ? value : {};
  const inputDetails = usage.input_tokens_details || usage.prompt_tokens_details || usage.inputTokensDetails || {};
  const inputTokens = finiteToken(usage.input_tokens, usage.prompt_tokens, usage.inputTokens, usage.promptTokens);
  const outputTokens = finiteToken(usage.output_tokens, usage.completion_tokens, usage.outputTokens, usage.completionTokens);
  const cacheReadTokens = finiteToken(
    usage.cache_read_input_tokens,
    usage.cache_read_tokens,
    usage.cached_tokens,
    inputDetails.cached_tokens,
    inputDetails.cache_read_tokens,
  );
  const cacheWriteTokens = finiteToken(
    usage.cache_creation_input_tokens,
    usage.cache_creation_tokens,
    usage.cache_write_tokens,
    inputDetails.cache_creation_tokens,
    inputDetails.cache_write_tokens,
  );
  const totalTokens = finiteToken(usage.total_tokens, usage.totalTokens, inputTokens + outputTokens);
  return { inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheWriteTokens };
}

function mergeUsage(current, next) {
  return {
    inputTokens: Math.max(current.inputTokens, next.inputTokens),
    outputTokens: Math.max(current.outputTokens, next.outputTokens),
    totalTokens: Math.max(current.totalTokens, next.totalTokens),
    cacheReadTokens: Math.max(current.cacheReadTokens, next.cacheReadTokens),
    cacheWriteTokens: Math.max(current.cacheWriteTokens, next.cacheWriteTokens),
  };
}

function usageFromPayload(value) {
  if (!value || typeof value !== "object") return normalizedUsage({});
  const candidates = [value.usage, value.response?.usage, value.data?.usage, value.message?.usage];
  let result = normalizedUsage({});
  for (const candidate of candidates) result = mergeUsage(result, normalizedUsage(candidate));
  return result;
}

function addUsageTotals(totals, record) {
  const at = String(record.at || "");
  totals.requests += 1;
  totals.errors += Number(record.status || 0) >= 400 ? 1 : 0;
  totals.inputTokens += finiteToken(record.inputTokens);
  totals.outputTokens += finiteToken(record.outputTokens);
  totals.totalTokens += finiteToken(record.totalTokens);
  totals.cacheReadTokens += finiteToken(record.cacheReadTokens);
  totals.cacheWriteTokens += finiteToken(record.cacheWriteTokens);
  if (at && !totals.firstRequestAt) totals.firstRequestAt = at;
  if (at) totals.lastRequestAt = at;
  return totals;
}

let usageLedger = new UsageLedger(dataDir);
// 中文：正版 Codex 统计始终开启，但通过独立的本机 loopback 数据源读取；它不写入中转站账本。
// English: Official Codex tracking is always on, but reads a separate loopback source and never
// writes official records into the relay ledger.
const codexUsageClient = new CodexUsageClient();
let syncChangeHandler = null;

function appendUsageRecord(record) { return usageLedger.append(record); }
function notifySyncChange(reason) {
  if (typeof syncChangeHandler !== "function") return;
  setImmediate(() => Promise.resolve(syncChangeHandler(reason)).catch(() => {}));
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
  forcedLevel: "unchanged",
  defaultProvider: "",
  providers: [],
  clientKeys: [],
  lastClientRequest: { at: "", status: "never", model: "" },
});
lastPersistedConfig = JSON.parse(JSON.stringify(config));

function validReasoningLevel(value) {
  return supportedReasoningLevels.includes(String(value));
}

function uniqueModels(value) {
  if (!Array.isArray(value)) return [];
  const names = value.map((item) => {
    if (typeof item === "string") return item;
    if (item && typeof item === "object") return item.id || item.name || "";
    return "";
  }).map((item) => String(item).trim()).filter(Boolean);
  return names.filter((item, index, list) => list.indexOf(item) === index);
}

// 中文：部分中转站能正常聊天，但不提供可用的 /v1/models 目录（例如返回 404 或空数组）。
// Cherry Studio 的“检测并启用”把目录请求当作前置条件；没有目录时返回空 data 会让它把
// 一条可用线路误判为失败。因此只对已经完成上游目录探测、且失败类型明确属于目录兼容性
// 的线路提供一个非认证的兼容占位符。实际聊天请求仍使用客户端提交的真实 model，不会把
// 占位符强行改写到上游。
// English: Some relays can chat normally but expose no usable /v1/models catalog (for example,
// a 404 or an empty array). Cherry Studio treats catalog discovery as a prerequisite, so an empty
// data array falsely marks a usable route as failed. For a route whose catalog probe has completed
// with a known catalog-compatibility failure, expose a non-auth compatibility placeholder. Chat
// requests still use the model supplied by the client; this placeholder is never forced upstream.
const CATALOG_COMPATIBILITY_STATUSES = new Set(["unsupported", "rate_limited", "invalid-response"]);
const CATALOG_COMPATIBILITY_MODEL = "default";

function catalogModels(provider) {
  const models = uniqueModels(provider?.models);
  if (models.length) return models;
  if (provider?.lastTestStatus === "error" && CATALOG_COMPATIBILITY_STATUSES.has(provider.modelListStatus)) {
    return [CATALOG_COMPATIBILITY_MODEL];
  }
  return [];
}

// 中文：模型目录检测失败不等于线路不可用。Cherry Studio 的“检测并启用”会把
// 模型目录和实际聊天请求分开调用，因此必须把目录状态单独保存。
// English: A model-catalog failure does not mean that the route is unavailable. Cherry Studio
// calls catalog discovery and chat separately, so keep catalog health separate from route state.
const modelListStatuses = ["ok", "unsupported", "rate_limited", "auth", "timeout", "network", "invalid-response", "error", "never"];

function providerModelsError(message, modelListStatus = "error", statusCode = 0, code = "") {
  const error = new Error(message);
  error.phase = "model-list";
  error.modelListStatus = modelListStatuses.includes(modelListStatus) ? modelListStatus : "error";
  error.statusCode = Number(statusCode || 0);
  if (code) error.code = String(code);
  return error;
}

function saveConfig({ bumpRevision = true } = {}) {
  const previousPersisted = lastPersistedConfig ? JSON.parse(JSON.stringify(lastPersistedConfig)) : null;
  if (bumpRevision) {
    const previous = config.configRevision && typeof config.configRevision === "object" ? config.configRevision : {};
    config.configRevision = {
      counter: Math.max(0, Number(previous.counter) || 0) + 1,
      deviceId: usageLedger.identity.deviceId,
    };
  }
  try {
    writeJson(configFile, config);
    lastPersistedConfig = JSON.parse(JSON.stringify(config));
  } catch (error) {
    // 中文：调用方通常先改内存再保存；落盘失败时必须恢复上次已确认的磁盘快照，
    // 避免当前进程使用“用户未保存”的 Key、线路或思考强度。
    // English: Callers update memory before saving. Restore the last durable snapshot on a
    // failed write so the running process never uses unsaved keys, routes, or policies.
    if (previousPersisted) config = previousPersisted;
    throw error;
  }
}

function migrateConfig() {
  const before = JSON.stringify(config);
  config = config && typeof config === "object" ? config : {};
  config.schemaVersion = 1;
  config.version = Number(config.version || 1);
  config.configRevision = {
    counter: Math.max(0, Number(config.configRevision?.counter) || 0),
    deviceId: String(config.configRevision?.deviceId || usageLedger.identity.deviceId),
  };
  config.forcedLevel = validReasoningLevel(config.forcedLevel) ? config.forcedLevel : "unchanged";
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
    provider.modelListStatus = modelListStatuses.includes(provider.modelListStatus) ? provider.modelListStatus : (provider.lastTestStatus === "ok" ? "ok" : "never");
    provider.lastTestAt = String(provider.lastTestAt || "");
    provider.lastError = String(provider.lastError || "");
  }
  const fallbackProvider = String(config.defaultProvider || config.providers.find((item) => item.enabled)?.id || "");
  config.defaultProvider = fallbackProvider;
  for (const item of config.clientKeys) {
    if (!item.id) item.id = crypto.randomUUID();
    item.name = String(item.name || "客户端");
    item.providerId = String(item.providerId || fallbackProvider);
    const provider = config.providers.find((entry) => entry.id === item.providerId);
    if (typeof item.nameCustomized !== "boolean") item.nameCustomized = !provider || item.name !== provider.name;
    if (!item.nameCustomized && provider) item.name = provider.name;
    item.reasoningLevel = validReasoningLevel(item.reasoningLevel) ? item.reasoningLevel : config.forcedLevel;
    item.keyEnc = String(item.keyEnc || "");
    item.createdAt = String(item.createdAt || new Date().toLocaleString("zh-CN"));
    item.enabled = item.enabled !== false;
  }
  if (JSON.stringify(config) !== before) saveConfig({ bumpRevision: false });
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
  saveConfig({ bumpRevision: false });
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
  const models = catalogModels(provider);
  const modelListStatus = provider.modelListStatus || "never";
  const routeVerified = provider.lastTestStatus === "ok"
    || (provider.lastTestStatus === "error" && CATALOG_COMPATIBILITY_STATUSES.has(modelListStatus) && models.length > 0);
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    models,
    modelCount: models.length,
    enabled: provider.enabled !== false,
    hasApiKey: Boolean(provider.apiKeyEnc && decrypt(provider.apiKeyEnc)),
    modelFetchedAt: provider.modelFetchedAt || "",
    lastTestAt: provider.lastTestAt || "",
    lastTestStatus: provider.lastTestStatus || "never",
    modelListStatus,
    routeVerified,
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
  const level = validReasoningLevel(levelOverride) ? levelOverride : (config.forcedLevel || "unchanged");
  // 中文：不做更改时保留客户端已有字段；English: preserve the client's original reasoning fields.
  if (level === "unchanged") return;
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
  const startedAt = Date.now();
  let firstByteAt = 0;
  let finalized = false;
  let capturedUsage = normalizedUsage({});
  const responseChunks = [];
  let responseBytes = 0;
  const maxResponseCapture = 16 * 1024 * 1024;
  let sseRemainder = "";
  const decoder = new StringDecoder("utf8");
  const baseRecord = {
    clientKeyId: client.id,
    clientKeyName: client.name,
    providerId: selected.provider.id,
    providerName: selected.provider.name,
    model: String(payload.model || ""),
    endpoint: pathname,
    method: String(req.method || "POST"),
    reasoningLevel: validReasoningLevel(client.reasoningLevel) ? client.reasoningLevel : (config.forcedLevel || "unchanged"),
    stream: Boolean(payload.stream),
  };
  const consumeSseLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const raw = trimmed.slice(5).trim();
    if (!raw || raw === "[DONE]") return;
    try { capturedUsage = mergeUsage(capturedUsage, usageFromPayload(JSON.parse(raw))); } catch { /* ordinary streamed text can be ignored */ }
  };
  const finalizeUsage = (status, error = "") => {
    if (finalized) return;
    finalized = true;
    if (sseRemainder) consumeSseLine(sseRemainder);
    if (responseChunks.length) {
      const responsePayload = bodyJson(Buffer.concat(responseChunks));
      if (responsePayload) capturedUsage = mergeUsage(capturedUsage, usageFromPayload(responsePayload));
    }
    const finishedAt = Date.now();
    appendUsageRecord({
      id: crypto.randomUUID(),
      at: new Date(finishedAt).toISOString(),
      ...baseRecord,
      status: Number(status || 0),
      durationMs: Math.max(0, finishedAt - startedAt),
      ttftMs: firstByteAt ? Math.max(0, firstByteAt - startedAt) : 0,
      ...capturedUsage,
      error: String(error || "").slice(0, 300),
    });
  };
  const upstreamReq = requestUpstream(target, req.method, headers, (upstreamRes) => {
    const statusCode = upstreamRes.statusCode || 502;
    const isSse = String(upstreamRes.headers["content-type"] || "").toLowerCase().includes("text/event-stream");
    // 中文：网关不跟随上游重定向；只有完整收到 2xx 响应才算实际调用成功。
    // English: The gateway does not follow upstream redirects; only a completed 2xx response is
    // a successful model call.
    updateClientRequestStatus(statusCode >= 200 && statusCode < 300 ? "ok" : "error", payload.model);
    res.writeHead(upstreamRes.statusCode || 502, {
      ...upstreamRes.headers,
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type, authorization, x-gateway-key",
    });
    upstreamRes.on("data", (chunk) => {
      if (!firstByteAt) firstByteAt = Date.now();
      if (isSse) {
        sseRemainder += decoder.write(chunk);
        const lines = sseRemainder.split(/\r?\n/);
        sseRemainder = lines.pop() || "";
        for (const line of lines) consumeSseLine(line);
      } else if (responseBytes + chunk.length <= maxResponseCapture) {
        responseChunks.push(chunk);
        responseBytes += chunk.length;
      }
    });
    upstreamRes.once("end", () => {
      if (isSse) sseRemainder += decoder.end();
      updateClientRequestStatus(statusCode >= 200 && statusCode < 300 ? "ok" : "error", payload.model);
      finalizeUsage(statusCode);
    });
    upstreamRes.once("error", (error) => {
      updateClientRequestStatus("error", payload.model);
      finalizeUsage(statusCode, error.message);
    });
    upstreamRes.pipe(res);
  });
  upstreamReq.on("error", (error) => {
    updateClientRequestStatus("error", payload.model);
    console.error(`[上游错误] ${selected.provider.id} ${error.message}`);
    finalizeUsage(502, error.message);
    if (!res.headersSent) json(res, 502, { error: "upstream_error", provider: selected.provider.id, detail: error.message });
    else res.destroy();
  });
  upstreamReq.end(body);
  console.log(`[转发] ${selected.provider.id} ${req.method} ${req.url} reasoning=${client.reasoningLevel || config.forcedLevel} client=${client.id}`);
}

function totalsView(totals) {
  const value = { ...emptyUsageTotals(), ...(totals || {}) };
  const denominator = Math.max(0, finiteToken(value.inputTokens));
  return {
    ...value,
    cacheHitRate: denominator ? Math.min(100, (finiteToken(value.cacheReadTokens) / denominator) * 100) : 0,
  };
}

function usageRangeDefinition(value) {
  const ranges = {
    "24h": { durationMs: 24 * 60 * 60 * 1000, bucketMs: 60 * 60 * 1000 },
    "7d": { durationMs: 7 * 24 * 60 * 60 * 1000, bucketMs: 6 * 60 * 60 * 1000 },
    "30d": { durationMs: 30 * 24 * 60 * 60 * 1000, bucketMs: 24 * 60 * 60 * 1000 },
    "90d": { durationMs: 90 * 24 * 60 * 60 * 1000, bucketMs: 3 * 24 * 60 * 60 * 1000 },
    "180d": { durationMs: 180 * 24 * 60 * 60 * 1000, bucketMs: 7 * 24 * 60 * 60 * 1000 },
  };
  return { key: Object.prototype.hasOwnProperty.call(ranges, value) ? value : "24h", ...(ranges[value] || ranges["24h"]) };
}

async function usageSnapshot(url) {
  // 中文：全部来源必须在两类记录合并后统一分页；先取两条流的前段，避免各自 offset 导致漏项。
  // English: All-source pagination must happen after merging both streams; fetch each prefix first
  // so independent offsets cannot drop interleaved records.
  const sourceUrl = new URL(url);
  if (String(url.searchParams.get("source") || "all") === "all") {
    const offset = Math.max(0, Number(url.searchParams.get("recordsOffset") || 0) || 0);
    const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get("limit") || 100) || 100));
    sourceUrl.searchParams.set("recordsOffset", "0");
    sourceUrl.searchParams.set("limit", String(Math.min(5000, offset + limit)));
  }
  const sourceFilter = String(url.searchParams.get("source") || "all");
  const providerId = String(url.searchParams.get("providerId") || "");
  const wantsOfficial = sourceFilter !== "relay" && (!providerId || providerId === CODEX_OFFICIAL_SOURCE);
  const relaySnapshot = usageLedger.snapshot(sourceUrl);
  // 中文：中转站专用筛选不应等待本机 Codex 服务；官方筛选仍保持显式不可用状态。
  // English: Relay-only queries must not wait for the local Codex service; official queries still
  // expose an explicit unavailable state instead of silently fabricating zero usage.
  const officialSnapshot = wantsOfficial ? await codexUsageClient.safeSnapshot(sourceUrl) : emptySnapshot(sourceUrl, CODEX_OFFICIAL_SOURCE);
  return combineUsageSnapshots(relaySnapshot, officialSnapshot, url);
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
          const rawModels = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : null;
          if (!rawModels) return reject(providerModelsError("上游模型目录响应格式无效", "invalid-response", response.statusCode));
          // 中文：兼容少数上游使用 model/slug 而不是标准 id 的目录项；否则模型明明可用却会被误判为空目录。
          // English: Accept catalog entries that use model/slug instead of standard id; otherwise
          // a usable upstream can be falsely classified as an empty catalog.
          const models = uniqueModels(rawModels.map((item) => typeof item === "string" ? item : item?.id || item?.model || item?.slug || item?.name));
          if (!models.length) return reject(providerModelsError("上游模型目录为空或不含有效模型", "invalid-response", response.statusCode));
          resolve({ status: response.statusCode, latencyMs: Date.now() - started, models });
        } else {
          const statusCode = Number(response.statusCode || 0);
          const modelListStatus = [404, 405, 501].includes(statusCode)
            ? "unsupported"
            : statusCode === 429
              ? "rate_limited"
              : [401, 403].includes(statusCode)
                ? "auth"
                : [408, 504].includes(statusCode)
                  ? "timeout"
                  : "error";
          reject(providerModelsError(`HTTP ${statusCode}${data?.error?.message ? `: ${data.error.message}` : ""}`, modelListStatus, statusCode));
        }
      });
    });
    request.on("error", (error) => reject(providerModelsError(
      error?.message || "无法连接上游模型目录",
      error?.message === "upstream_timeout" ? "timeout" : "network",
      0,
      error?.code || (error?.message === "upstream_timeout" ? "ETIMEDOUT" : ""),
    )));
    request.end();
  });
}

function providerErrorMessage(error, provider) {
  const code = String(error?.code || "");
  const raw = String(error?.message || error || "未知错误").trim();
  if (code === "ECONNREFUSED") return `无法连接中转站（ECONNREFUSED）：请检查 API URL、端口和网络代理。地址：${provider.baseUrl}`;
  if (code === "ENOTFOUND") return `找不到中转站域名（ENOTFOUND）：请检查 API URL、DNS 和网络代理。地址：${provider.baseUrl}`;
  if (code === "ETIMEDOUT" || raw === "upstream_timeout") return `连接中转站超时：请检查网络代理、线路速度和上游状态。地址：${provider.baseUrl}`;
  if (error?.modelListStatus === "unsupported") return `上游不支持模型目录接口，但线路仍保持启用；已有模型仍可尝试调用。地址：${provider.baseUrl}`;
  if (error?.modelListStatus === "rate_limited") return `模型目录接口被上游限流，请稍后刷新；线路仍保持启用。地址：${provider.baseUrl}`;
  if (error?.modelListStatus === "invalid-response") return `上游模型目录响应格式无效；线路仍保持启用。地址：${provider.baseUrl}`;
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
  if (url.pathname === "/admin/api/settings" && req.method === "GET") return json(res, 200, { forcedLevel: config.forcedLevel || "unchanged", defaultProvider: config.defaultProvider || "", reasoningLevels: supportedReasoningLevels });
  if (url.pathname === "/admin/api/status" && req.method === "GET") return json(res, 200, { version: gatewayVersion, forcedLevel: config.forcedLevel || "unchanged", lastClientRequestAt, lastClientRequestStatus, lastClientRequestModel, ledger: usageLedger.status() });
  if (url.pathname === "/admin/api/usage" && req.method === "GET") return json(res, 200, await usageSnapshot(url));
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
    const preservesUpstreamIdentity = Boolean(old && old.baseUrl === normalizedUrl && !data.apiKey);
    const provider = {
      ...(old || {}),
      id,
      name: String(data.name || id).trim(),
      baseUrl: normalizedUrl,
      // 中文：URL 或上游 Key 改变后，旧目录不再可信；避免 Cherry Studio 看到上一条线路的模型。
      // English: A changed URL or upstream key invalidates the old catalog; never expose models
      // from the previous route to Cherry Studio.
      models: preservesUpstreamIdentity ? old.models || [] : [],
      modelFetchedAt: preservesUpstreamIdentity ? old.modelFetchedAt || "" : "",
      enabled: true,
      apiKeyEnc: data.apiKey ? encrypt(String(data.apiKey).trim()) : (old?.apiKeyEnc || ""),
      lastTestStatus: preservesUpstreamIdentity ? (old.lastTestStatus || "never") : "never",
      modelListStatus: preservesUpstreamIdentity ? (old.modelListStatus || "never") : "never",
      lastTestAt: preservesUpstreamIdentity ? (old.lastTestAt || "") : "",
      lastLatencyMs: preservesUpstreamIdentity ? old.lastLatencyMs : undefined,
      lastError: preservesUpstreamIdentity ? (old.lastError || "") : "",
    };
    config.providers = old ? config.providers.map((item) => item.id === id ? provider : item) : [...config.providers, provider];
    if (old && old.name !== provider.name) {
      for (const item of config.clientKeys) if (item.providerId === id && item.nameCustomized !== true) item.name = provider.name;
    }
    if (!config.defaultProvider) config.defaultProvider = id;
    saveConfig();
    notifySyncChange("secure-route-change");
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
      provider.modelListStatus = "ok";
      provider.lastLatencyMs = result.latencyMs;
      provider.lastError = "";
      saveConfig();
      notifySyncChange("route-health-change");
      return json(res, 200, { ok: true, status: result.status, latencyMs: result.latencyMs, models: result.models, provider: providerView(provider) });
    } catch (error) {
      provider.lastTestAt = new Date().toISOString();
      provider.lastTestStatus = "error";
      provider.modelListStatus = error?.modelListStatus || "error";
      provider.lastError = providerErrorMessage(error, provider);
      saveConfig();
      notifySyncChange("route-health-change");
      return json(res, 502, {
        ok: false,
        phase: "model-list",
        routeEnabled: provider.enabled !== false,
        routeVerified: providerView(provider).routeVerified,
        modelListStatus: provider.modelListStatus,
        status: Number(error?.statusCode || 0) || undefined,
        error: provider.lastError,
        provider: providerView(provider),
      });
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
    notifySyncChange("config-change");
    return json(res, 200, { ok: true, forcedLevel: config.forcedLevel, defaultProvider: config.defaultProvider, reasoningLevels: supportedReasoningLevels });
  }
  if (url.pathname === "/admin/api/client-keys" && req.method === "GET") {
    return json(res, 200, { keys: config.clientKeys.map((item) => ({ id: item.id, name: item.name, nameCustomized: item.nameCustomized === true, providerId: item.providerId, providerName: config.providers.find((provider) => provider.id === item.providerId)?.name || "未绑定", reasoningLevel: validReasoningLevel(item.reasoningLevel) ? item.reasoningLevel : config.forcedLevel || "unchanged", createdAt: item.createdAt, enabled: item.enabled !== false, hasSecret: Boolean(item.keyEnc && decrypt(item.keyEnc)) })) });
  }
  if (url.pathname === "/admin/api/client-keys" && req.method === "POST") {
    const data = bodyJson(await readBody(req)) || {};
    const providerId = String(data.providerId || "");
    if (!providerId || !findProvider(providerId)) return json(res, 400, { error: "必须绑定一个有效的中转站线路" });
    const provider = findProvider(providerId);
    const reasoningLevel = validReasoningLevel(data.reasoningLevel) ? String(data.reasoningLevel) : (config.forcedLevel || "unchanged");
    const key = makeClientKey();
    const nameCustomized = data.nameCustomized === true;
    const item = { id: crypto.randomUUID(), name: nameCustomized ? String(data.name || provider.name).trim() : provider.name, nameCustomized, providerId, reasoningLevel, hash: hashKey(key), keyEnc: encrypt(key), createdAt: new Date().toLocaleString("zh-CN"), enabled: true };
    config.clientKeys.push(item);
    saveConfig();
    notifySyncChange("client-metadata-change");
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
    notifySyncChange("client-key-rotate");
    return json(res, 200, { ok: true, key });
  }
  const keyRoute = url.pathname.match(/^\/admin\/api\/client-keys\/([^/]+)$/);
  if (keyRoute && req.method === "PUT") {
    const data = bodyJson(await readBody(req)) || {};
    const item = config.clientKeys.find((entry) => entry.id === keyRoute[1]);
    if (!item) return json(res, 404, { error: "客户端 Key 不存在" });
    const providerId = String(data.providerId || item.providerId || "");
    if (!providerId || !findProvider(providerId)) return json(res, 400, { error: "必须绑定一个有效的中转站线路" });
    const provider = findProvider(providerId);
    const nameCustomized = typeof data.nameCustomized === "boolean" ? data.nameCustomized : String(data.name || "").trim() !== provider.name;
    item.nameCustomized = nameCustomized;
    item.name = nameCustomized ? String(data.name || item.name || provider.name).trim() : provider.name;
    item.providerId = providerId;
    if (data.reasoningLevel && validReasoningLevel(data.reasoningLevel)) item.reasoningLevel = String(data.reasoningLevel);
    saveConfig();
    notifySyncChange("client-metadata-change");
    return json(res, 200, { ok: true });
  }
  if (keyRoute && req.method === "PATCH") {
    const data = bodyJson(await readBody(req)) || {};
    const item = config.clientKeys.find((entry) => entry.id === keyRoute[1]);
    if (!item) return json(res, 404, { error: "客户端 Key 不存在" });
    if (typeof data.enabled === "boolean") item.enabled = data.enabled;
    saveConfig();
    notifySyncChange("client-metadata-change");
    return json(res, 200, { ok: true, enabled: item.enabled !== false });
  }
  if (keyRoute && req.method === "DELETE") {
    const deleted = config.clientKeys.find((item) => item.id === keyRoute[1]);
    const before = config.clientKeys.length;
    config.clientKeys = config.clientKeys.filter((item) => item.id !== keyRoute[1]);
    if (config.clientKeys.length === before) return json(res, 404, { error: "客户端 Key 不存在" });
    usageLedger.addTombstone("client-key", deleted.id, String(Date.now()));
    saveConfig();
    notifySyncChange("client-delete");
    return json(res, 200, { ok: true, deleted: true });
  }
  const providerDelete = url.pathname.match(/^\/admin\/api\/providers\/([^/]+)$/);
  if (providerDelete && req.method === "DELETE") {
    const providerId = decodeURIComponent(providerDelete[1]);
    if (config.clientKeys.some((item) => item.providerId === providerId)) return json(res, 409, { error: "仍有客户端 Key 绑定此线路，请先改绑或删除这些 Key" });
    const before = config.providers.length;
    config.providers = config.providers.filter((item) => item.id !== providerId);
    if (config.providers.length === before) return json(res, 404, { error: "线路不存在" });
    usageLedger.addTombstone("provider", providerId, String(Date.now()));
    if (config.defaultProvider === providerId) config.defaultProvider = config.providers.find((item) => item.enabled !== false)?.id || "";
    saveConfig();
    notifySyncChange("secure-route-delete");
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
    for (const provider of providers) {
      // OpenAI-compatible model objects include a Unix-seconds `created` field.
      // Some clients (including model-catalog importers) reject otherwise valid
      // list entries when this required field is omitted.
      const fetchedAt = Date.parse(provider.modelFetchedAt || "");
      // 中文：Cherry Studio 会把 created=0 当成异常目录元数据；没有探测时间时使用当前时间，不改变模型或路由。
      // English: Cherry Studio treats created=0 as malformed catalog metadata; use the current
      // Unix time when the probe timestamp is absent without changing the model or route.
      const created = Number.isFinite(fetchedAt) && fetchedAt > 0 ? Math.floor(fetchedAt / 1000) : Math.floor(Date.now() / 1000);
      for (const model of catalogModels(provider)) {
        models.push({ id: client.providerId ? model : `${provider.id}/${model}`, object: "model", created, owned_by: provider.id });
      }
    }
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
    if (!usageLedger?.db) usageLedger = new UsageLedger(dataDir);
    const requestedPort = Number(options.port);
    if (Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort < 65536) listenPort = requestedPort;
    const onError = (error) => { server.off("listening", onListening); reject(error); };
    const onListening = () => {
      server.off("error", onError);
      console.log(`Cherry AI 连接中心已启动：http://${listenHost}:${listenPort}`);
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
    if (!server.listening) { usageLedger?.close(); return resolve(); }
    for (const socket of activeSockets) socket.destroy();
    if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    server.close((error) => {
      if (error && error.code !== "ERR_SERVER_NOT_RUNNING") return reject(error);
      usageLedger?.close();
      resolve();
    });
  });
}

export function getGatewayPort() { return listenPort; }

// 中文：仅由 Electron 主进程在用户点击导入时调用；完整 Key 不经管理 HTTP API 外的新接口回传渲染层。
// English: Called only by Electron main after an explicit import click; never expose this secret bundle to the renderer.
export function getClientKeyImportDetails(id) {
  const item = config.clientKeys.find((entry) => entry.id === String(id || ""));
  if (!item) throw new Error("client_key_unavailable");
  if (item.enabled === false) throw new Error("client_key_disabled");
  const provider = findProvider(item.providerId);
  if (!provider || provider.enabled === false) throw new Error("client_key_route_unavailable");
  const apiKey = decrypt(item.keyEnc);
  if (!apiKey) throw new Error("client_key_secret_unavailable");
  return {
    id: item.id,
    name: String(item.name || provider.name || "Cherry AI Connect"),
    providerName: String(provider.name || ""),
    apiKey,
    model: uniqueModels(provider.models)[0] || "",
  };
}

export function getSyncSnapshot() {
  const publicConfig = {
    schemaVersion: 1,
    configRevision: { ...config.configRevision },
    forcedLevel: config.forcedLevel,
    defaultProvider: config.defaultProvider,
    providers: config.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      enabled: provider.enabled !== false,
      models: uniqueModels(provider.models),
      modelFetchedAt: String(provider.modelFetchedAt || ""),
      lastTestStatus: ["ok", "error", "never"].includes(provider.lastTestStatus) ? provider.lastTestStatus : "never",
      modelListStatus: modelListStatuses.includes(provider.modelListStatus) ? provider.modelListStatus : "never",
      lastTestAt: String(provider.lastTestAt || ""),
      lastLatencyMs: Number(provider.lastLatencyMs || 0),
    })),
    // 中文：只同步客户端 Key 的非敏感显示/绑定信息；完整 Key、哈希和本机密文永不上云。
    // English: Only non-secret client metadata syncs. Full keys, hashes, and local ciphertext never do.
    clientKeyMetadata: config.clientKeys.map((item) => ({
      id: item.id,
      name: item.name,
      nameCustomized: item.nameCustomized === true,
      providerId: item.providerId,
      reasoningLevel: validReasoningLevel(item.reasoningLevel) ? item.reasoningLevel : config.forcedLevel,
      createdAt: item.createdAt,
      enabled: item.enabled !== false,
      secretAvailableOnThisDevice: false,
    })),
  };
  const secureConfig = {
    schemaVersion: 1,
    datasetId: usageLedger.identity.datasetId,
    providers: config.providers.map((provider) => ({
      id: provider.id,
      baseUrl: String(provider.baseUrl || ""),
      apiKey: decrypt(provider.apiKeyEnc),
      authType: "bearer",
      headers: {},
      proxy: null,
      tls: { verify: true },
    })),
  };
  return {
    identity: { ...usageLedger.identity },
    publicConfig,
    secureConfig,
    events: usageLedger.pendingUsage(50000),
    counters: usageLedger.counters(),
    tombstones: usageLedger.tombstones(),
    ledger: usageLedger.status(),
  };
}

export function canAdoptSyncDataset() {
  return config.providers.length === 0 && config.clientKeys.length === 0 && usageLedger.canAdoptDataset();
}

export function adoptSyncDataset(datasetId) {
  if (!canAdoptSyncDataset()) throw new Error("sync_dataset_not_pristine");
  return usageLedger.adoptDataset(datasetId);
}

function syncProviderFromRemote(publicProvider, secureProvider) {
  const id = String(publicProvider?.id || "").trim().replace(/[^a-zA-Z0-9_-]/g, "");
  if (!id || id !== String(publicProvider?.id || "")) throw new Error("sync_invalid_provider");
  if (!secureProvider || String(secureProvider.id || "") !== id) throw new Error("sync_remote_vault_incomplete");
  let baseUrl;
  try {
    const parsed = new URL(String(secureProvider.baseUrl || "").trim());
    if (!/^https?:$/.test(parsed.protocol)) throw new Error("protocol");
    baseUrl = parsed.toString().replace(/\/+$/, "");
  } catch { throw new Error("sync_invalid_provider_url"); }
  const previous = config.providers.find((item) => item.id === id);
  return {
    id,
    name: String(publicProvider.name || id).trim().slice(0, 200),
    enabled: publicProvider.enabled !== false,
    models: uniqueModels(publicProvider.models),
    modelFetchedAt: String(publicProvider.modelFetchedAt || ""),
    lastTestStatus: ["ok", "error", "never"].includes(publicProvider.lastTestStatus) ? publicProvider.lastTestStatus : "never",
    modelListStatus: modelListStatuses.includes(publicProvider.modelListStatus) ? publicProvider.modelListStatus : "never",
    lastTestAt: String(publicProvider.lastTestAt || ""),
    lastLatencyMs: finiteToken(publicProvider.lastLatencyMs),
    lastError: "",
    baseUrl,
    apiKeyEnc: secureProvider.apiKey ? encrypt(String(secureProvider.apiKey)) : (previous?.apiKeyEnc || ""),
  };
}

function syncTombstoneIds(tombstones) {
  return new Set((Array.isArray(tombstones) ? tombstones : [])
    .filter((item) => String(item?.object_type || item?.objectType || "") === "client-key")
    .map((item) => String(item?.object_id || item?.objectId || ""))
    .filter(Boolean));
}

function prepareConfigFromSync(publicConfig, secureConfig, options = {}) {
  if (!publicConfig || Number(publicConfig.schemaVersion) !== 1 || !publicConfig.configRevision) throw new Error("sync_invalid_config");
  if (!secureConfig || Number(secureConfig.schemaVersion) !== 1 || secureConfig.datasetId !== usageLedger.identity.datasetId) throw new Error("sync_invalid_secure_config");
  if (!Array.isArray(publicConfig.providers) || !Array.isArray(publicConfig.clientKeyMetadata)) throw new Error("sync_invalid_config");
  if (!Array.isArray(secureConfig.providers)) throw new Error("sync_invalid_secure_config");
  const secureById = new Map();
  for (const item of secureConfig.providers) {
    const id = String(item?.id || "");
    if (!id || secureById.has(id)) throw new Error("sync_invalid_secure_config");
    secureById.set(id, item);
  }
  const providers = publicConfig.providers.map((item) => syncProviderFromRemote(item, secureById.get(String(item?.id || ""))));
  const providerIds = new Set(providers.map((item) => item.id));
  if (providerIds.size !== providers.length) throw new Error("sync_invalid_config");
  const previousKeys = new Map(config.clientKeys.map((item) => [item.id, item]));
  const remoteKeyIds = new Set();
  const clientKeys = (Array.isArray(publicConfig.clientKeyMetadata) ? publicConfig.clientKeyMetadata : []).map((item) => {
    const id = String(item.id || "");
    const providerId = String(item.providerId || "");
    if (!id || !providerIds.has(providerId)) throw new Error("sync_invalid_client_metadata");
    if (remoteKeyIds.has(id)) throw new Error("sync_invalid_client_metadata");
    remoteKeyIds.add(id);
    const previous = previousKeys.get(id);
    // 中文：同一设备绝不因更新或同步刷新客户端 Key。只有同步引擎明确确认是全新设备首次恢复时才允许生成。
    // English: Updates and normal syncs never rotate a same-device client key. Generation is allowed only
    // when the sync engine explicitly identifies a pristine device performing its first restore.
    const previousSecret = decrypt(previous?.keyEnc || "");
    if (!previousSecret && options.allowGenerateClientSecrets !== true) throw new Error("sync_client_key_secret_missing");
    const localSecret = previousSecret || makeClientKey();
    return {
      id,
      name: String(item.name || providers.find((provider) => provider.id === providerId)?.name || "客户端").slice(0, 200),
      nameCustomized: item.nameCustomized === true,
      providerId,
      reasoningLevel: validReasoningLevel(item.reasoningLevel) ? item.reasoningLevel : "unchanged",
      createdAt: String(item.createdAt || new Date().toLocaleString("zh-CN")),
      enabled: item.enabled !== false,
      hash: hashKey(localSecret),
      keyEnc: previousSecret ? String(previous.keyEnc) : encrypt(localSecret),
    };
  });
  const explicitlyDeleted = syncTombstoneIds(options.tombstones);
  // 中文：远端 config 是某次设备的观察结果，不是本机 Key 的全量删除清单。远端缺少
  // 本机独有 Key 时保留原条目；只有明确的 client-key tombstone 才表示云端删除。
  // English: A remote config is one device's observation, not an implicit delete-all list for
  // this device's keys. Preserve local-only keys; only an explicit client-key tombstone deletes.
  for (const localKey of config.clientKeys) {
    if (!remoteKeyIds.has(localKey.id) && !explicitlyDeleted.has(localKey.id)) clientKeys.push(localKey);
  }
  return {
    ...config,
    schemaVersion: 1,
    version: 1,
    configRevision: {
      counter: Math.max(0, finiteToken(publicConfig.configRevision.counter)),
      deviceId: String(publicConfig.configRevision.deviceId || ""),
    },
    forcedLevel: validReasoningLevel(publicConfig.forcedLevel) ? publicConfig.forcedLevel : "unchanged",
    defaultProvider: providerIds.has(String(publicConfig.defaultProvider || "")) ? String(publicConfig.defaultProvider) : (providers.find((item) => item.enabled)?.id || ""),
    providers,
    clientKeys,
  };
}

// 中文：仅验证远端 config/vault 的业务关联，不写入本地配置；由 vault 导入的提交前回调调用。
// English: Validate remote config/vault relationships without writing local config; SyncEngine
// invokes this from the vault import pre-commit callback.
export function validateConfigFromSync(publicConfig, secureConfig, options = {}) {
  prepareConfigFromSync(publicConfig, secureConfig, options);
  return true;
}

// 中文：只有用户明确选择云端版本后才调用；安全 URL 和上游 Key 不会在后台静默替换。
// English: Called only after the user explicitly chooses the cloud copy; secure URLs and upstream keys never change silently.
export function replaceConfigFromSync(publicConfig, secureConfig, options = {}) {
  const nextConfig = prepareConfigFromSync(publicConfig, secureConfig, options);
  writeJson(configFile, nextConfig);
  config = nextConfig;
  return getSyncSnapshot().publicConfig;
}

export function bumpConfigRevisionForSync() {
  saveConfig({ bumpRevision: true });
  return { ...config.configRevision };
}

export function mergeRemoteUsage(payload) { return usageLedger.mergeRemote(payload); }
export function markSyncEvents(eventIds) { return usageLedger.markEventsSynced(eventIds); }
export function recordSyncRun(payload) { return usageLedger.recordSyncRun(payload); }
export function setSyncChangeHandler(handler) { syncChangeHandler = typeof handler === "function" ? handler : null; }

export { server };

if (process.env.GATEWAY_EMBEDDED !== "1") {
  startGateway().catch((error) => { console.error("网关启动失败", error); process.exitCode = 1; });
}
