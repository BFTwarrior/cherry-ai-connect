/**
 * 中文：读取本机 codex-usage 的 loopback API，把正版 Codex 的本机会话统计保留为独立来源。
 * English: Read the local codex-usage loopback API while keeping official Codex usage as a
 * separate source from Cherry relay traffic.
 *
 * The client deliberately consumes only the documented localhost API. It never reads
 * auth.json, session JSONL, prompts, replies, or tool output itself. When the optional
 * service is unavailable, the main usage endpoint remains healthy and reports an explicit
 * unavailable state instead of fabricating zeroes as if the source were disabled.
 */

export const CODEX_OFFICIAL_SOURCE = "codex-official";
export const CODEX_OFFICIAL_LABEL_ZH = "Codex 官方";
export const CODEX_OFFICIAL_LABEL_EN = "Codex Official";
export const CODEX_OFFICIAL_CACHE_MAX_BYTES = 50 * 1024 * 1024;
export const CODEX_OFFICIAL_CACHE_TARGET_BYTES = 45 * 1024 * 1024;
export const CODEX_OFFICIAL_MAX_RECORD_FETCH = 5000;
const DEFAULT_CODEX_USAGE_ORIGIN = "http://127.0.0.1:43189";

const RANGE_KEYS = new Set(["24h", "7d", "30d", "90d", "180d"]);

function boundedNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.round(parsed)) : 0;
}

function text(value) { return String(value ?? ""); }

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function rangeKey(value) { return RANGE_KEYS.has(String(value)) ? String(value) : "24h"; }

function localOrigin(value) {
  try {
    const parsed = new URL(String(value || DEFAULT_CODEX_USAGE_ORIGIN));
    const localHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
    if (parsed.protocol !== "http:" || !localHosts.has(parsed.hostname)) return DEFAULT_CODEX_USAGE_ORIGIN;
    return parsed.origin;
  } catch {
    return DEFAULT_CODEX_USAGE_ORIGIN;
  }
}

function emptyTotals() {
  return {
    requests: 0,
    errors: 0,
    unknownRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    firstRequestAt: "",
    lastRequestAt: "",
    cacheHitRate: 0,
  };
}

function totalsFromSummary(value) {
  const summary = value && typeof value === "object" ? value : {};
  const usage = summary.usage && typeof summary.usage === "object" ? summary.usage : {};
  const inputTokens = boundedNumber(firstValue(usage.input, usage.input_tokens, summary.input_tokens, summary.inputTokens));
  const outputTokens = boundedNumber(firstValue(usage.output, usage.output_tokens, summary.output_tokens, summary.outputTokens));
  const totalTokens = boundedNumber(firstValue(usage.total, usage.total_tokens, summary.total_tokens, summary.totalTokens, inputTokens + outputTokens));
  const cacheReadTokens = boundedNumber(firstValue(usage.cached_input, usage.cachedInput, usage.cached_input_tokens, summary.cached_input_tokens, summary.cacheReadTokens));
  const cacheWriteTokens = boundedNumber(firstValue(usage.cache_write_input, usage.cacheWriteInput, usage.cache_write_input_tokens, summary.cache_write_tokens, summary.cacheWriteTokens));
  const input = inputTokens || 0;
  return {
    requests: boundedNumber(firstValue(summary.event_count, summary.eventCount, summary.requests)),
    errors: 0,
    unknownRequests: boundedNumber(firstValue(summary.event_count, summary.eventCount, summary.requests)),
    inputTokens,
    outputTokens,
    totalTokens,
    cacheReadTokens,
    cacheWriteTokens,
    firstRequestAt: text(firstValue(summary.first_event, summary.firstEvent, summary.first_request_at, summary.firstRequestAt)),
    lastRequestAt: text(firstValue(summary.last_event, summary.lastEvent, summary.last_request_at, summary.lastRequestAt)),
    cacheHitRate: input ? Math.min(100, (cacheReadTokens / input) * 100) : 0,
  };
}

function pointFromTimeseries(value) {
  const point = value && typeof value === "object" ? value : {};
  const totals = totalsFromSummary({ usage: point.usage, event_count: point.event_count });
  return {
    at: text(firstValue(point.time, point.at, point.timestamp)),
    requests: totals.requests,
    errors: 0,
    unknownRequests: totals.unknownRequests,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    totalTokens: totals.totalTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
  };
}

// 中文：把本机 session 汇总转成统一历史记录；接口没有提供的请求级指标必须保持未知。
// English: Normalize a local session aggregate into the shared history shape; request-level
// metrics absent from the API must remain unknown instead of being fabricated.
function sessionRecord(value) {
  const row = value && typeof value === "object" ? value : {};
  const usage = row.usage && typeof row.usage === "object" ? row.usage : {};
  const sessionId = text(firstValue(row.session_id, row.sessionId, row.id));
  const at = text(firstValue(row.last_usage, row.lastUsage, row.updated_at, row.updatedAt, row.created_at, row.createdAt));
  // 中文：真实 codex-usage sessions 把 Token 放在 usage 对象；同时兼容旧版扁平字段。
  // English: Real codex-usage sessions nest token fields under usage; keep flat-field fallback
  // for older service builds and test fixtures.
  const inputTokens = boundedNumber(firstValue(usage.input, usage.input_tokens, row.input_tokens, row.inputTokens));
  const outputTokens = boundedNumber(firstValue(usage.output, usage.output_tokens, row.output_tokens, row.outputTokens));
  const totalTokens = boundedNumber(firstValue(usage.total, usage.total_tokens, row.total_tokens, row.totalTokens, inputTokens + outputTokens));
  return {
    id: `codex-session:${sessionId || cryptoRandomFallback(row)}`,
    at,
    clientKeyName: CODEX_OFFICIAL_LABEL_EN,
    providerId: CODEX_OFFICIAL_SOURCE,
    providerName: CODEX_OFFICIAL_LABEL_EN,
    model: text(firstValue(row.model, "—")),
    endpoint: "/local/codex/session",
    reasoningLevel: text(firstValue(row.service_mode, row.serviceMode, row.mode, "—")),
    // 中文：本机 Codex sessions API 不提供 HTTP 状态或请求延迟，不能伪造成功和 0ms。
    // English: The local Codex sessions API exposes no HTTP status or latency; never fabricate
    // success or zero-millisecond timings for display.
    status: null,
    durationMs: null,
    ttftMs: null,
    stream: null,
    inputTokens,
    outputTokens,
    totalTokens,
    cacheReadTokens: boundedNumber(firstValue(usage.cached_input, usage.cached_input_tokens, row.cached_input_tokens, row.cachedInputTokens, row.cached_input)),
    cacheWriteTokens: boundedNumber(firstValue(usage.cache_write_input, usage.cache_write_input_tokens, row.cache_write_input_tokens, row.cacheWriteInputTokens, row.cache_write_input)),
    // 中文：sessions 接口返回的是整个会话的累计输入，不是单次请求输入；保留口径标记供界面明确展示。
    // English: The sessions API reports cumulative input for the whole session, not one request;
    // keep an explicit semantic marker so the UI cannot present it as a single prompt.
    usageKind: "session-cumulative",
    usageAvailable: true,
    source: CODEX_OFFICIAL_SOURCE,
    sourceLabel: CODEX_OFFICIAL_LABEL_EN,
  };
}

function cryptoRandomFallback(row) {
  // This is only a defensive UI key fallback. Stable session IDs are supplied by the API.
  const raw = JSON.stringify(row || {});
  let hash = 2166136261;
  for (let index = 0; index < raw.length; index += 1) hash = Math.imul(hash ^ raw.charCodeAt(index), 16777619);
  return `row-${(hash >>> 0).toString(16)}`;
}

function queryValue(url, key, fallback = "") { return text(url.searchParams.get(key) || fallback); }

export class CodexUsageClient {
  constructor({ origin = process.env.CODEX_USAGE_ORIGIN || DEFAULT_CODEX_USAGE_ORIGIN, fetchImpl = globalThis.fetch, timeoutMs = 1200 } = {}) {
    // 中文：官方统计只允许本机 loopback；环境变量不能把会话数据转发到远程地址。
    // English: Official usage stays loopback-only; an environment variable cannot redirect
    // session data to a remote host.
    this.origin = localOrigin(origin).replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
    this.timeoutMs = Math.max(200, Number(timeoutMs) || 1200);
    // 中文：官方明细按查询模型分桶但共享一个全局内存预算；达到 45 MB 目标值后从全局最旧会话开始裁剪，绝不占用 relay ledger 配额。
    // English: Official detail records keep model-scoped buckets but share one global memory
    // budget; once the 45 MB target is exceeded, the oldest session across all buckets is
    // trimmed without consuming the relay ledger budget.
    this.recordCaches = new Map();
  }

  #cacheEntries() {
    const entries = [];
    for (const [model, cache] of this.recordCaches) {
      for (const [id, record] of cache) entries.push({ model, id, record });
    }
    return entries;
  }

  #cacheBytes() {
    let bytes = 0;
    for (const cache of this.recordCaches.values()) bytes += Buffer.byteLength(JSON.stringify([...cache.values()]), "utf8");
    return bytes;
  }

  #cacheStorage() {
    return { count: this.#cacheEntries().length, bytes: this.#cacheBytes() };
  }

  #pruneRecords() {
    let entries = this.#cacheEntries().sort((left, right) => String(right.record.at).localeCompare(String(left.record.at)) || String(right.id).localeCompare(String(left.id)));
    let bytes = this.#cacheBytes();
    while (entries.length && bytes > CODEX_OFFICIAL_CACHE_TARGET_BYTES) {
      const oldest = entries.pop();
      const cache = this.recordCaches.get(oldest.model);
      if (cache) {
        cache.delete(oldest.id);
        if (!cache.size) this.recordCaches.delete(oldest.model);
      }
      bytes = this.#cacheBytes();
      entries = this.#cacheEntries().sort((left, right) => String(right.record.at).localeCompare(String(left.record.at)) || String(right.id).localeCompare(String(left.id)));
    }
  }

  #rememberRecords(model, records) {
    const key = String(model || "*");
    const cache = this.recordCaches.get(key) || new Map();
    for (const record of records) cache.set(record.id, record);
    if (cache.size) this.recordCaches.set(key, cache);
    this.#pruneRecords();
    return [...(this.recordCaches.get(key)?.values() || [])].sort((left, right) => String(right.at).localeCompare(String(left.at)) || String(right.id).localeCompare(String(left.id)));
  }

  async #get(path, params = {}) {
    if (typeof this.fetchImpl !== "function") throw new Error("codex_usage_fetch_unavailable");
    const target = new URL(path, `${this.origin}/`);
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "") target.searchParams.set(key, String(value));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(target, { method: "GET", headers: { accept: "application/json" }, cache: "no-store", signal: controller.signal });
      const value = await response.json().catch(() => null);
      if (!response.ok) throw new Error(`codex_usage_http_${response.status}`);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("codex_usage_invalid_payload");
      return value;
    } finally { clearTimeout(timer); }
  }

  async snapshot(url) {
    // 中文：摘要、趋势和 session 明细都只读 loopback API；不会读取认证文件、聊天正文或写入中转账本。
    // English: Read summaries, trends, and session details only from the loopback API; never read
    // auth files or chat content, and never write into the relay ledger.
    const range = rangeKey(queryValue(url, "range", "24h"));
    const model = queryValue(url, "model");
    const statusFilter = queryValue(url, "status", "all");
    const requestedOffset = Math.max(0, Math.min(1_000_000, Number(queryValue(url, "recordsOffset", "0")) || 0));
    const requestedLimit = Math.min(CODEX_OFFICIAL_MAX_RECORD_FETCH, Math.max(1, Number(queryValue(url, "limit", "100")) || 100));
    // 中文：官方接口的深分页能力不能假定；只读取从 0 开始且不超过 5000 条的可证明前缀。
    // English: Do not assume deep-page support from the official API; read only a provable
    // prefix starting at zero, capped at 5000 records.
    const sessionLimit = Math.min(CODEX_OFFICIAL_MAX_RECORD_FETCH, requestedOffset + requestedLimit);
    const since = range;
    const bucket = range === "24h" ? "hour" : "day";
    const baseParams = model ? { since: "all", model } : { since: "all" };
    const currentParams = model ? { since, model } : { since };
    const [currentSummary, lifetimeSummary, timeseries, sessions] = await Promise.all([
      this.#get("/api/v1/summary", currentParams),
      this.#get("/api/v1/summary", baseParams),
      this.#get("/api/v1/timeseries", { ...currentParams, bucket }),
      this.#get("/api/v1/sessions", { ...baseParams, model: model || undefined, limit: sessionLimit, offset: 0 }),
    ]);
    if (!Array.isArray(timeseries?.points) || (!Array.isArray(sessions?.items) && !Array.isArray(sessions))) throw new Error("codex_usage_invalid_payload");
    const incomingRecords = (Array.isArray(sessions?.items) ? sessions.items : Array.isArray(sessions) ? sessions : []).map(sessionRecord).filter((item) => item.at);
    const records = this.#rememberRecords(model, incomingRecords);
    const reportedTotal = firstValue(sessions?.total, sessions?.total_count, sessions?.totalCount, sessions?.data?.total);
    const total = reportedTotal === undefined ? records.length : boundedNumber(reportedTotal);
    const availableRecords = reportedTotal === undefined ? records : records.slice(0, total);
    const unknownDeepPage = reportedTotal === undefined && requestedOffset > 0 && requestedOffset >= availableRecords.length;
    const truncated = total > availableRecords.length || unknownDeepPage;
    const lastKnownPageOffset = availableRecords.length > 0 ? Math.floor((availableRecords.length - 1) / requestedLimit) * requestedLimit : 0;
    const requestedPageOffset = total > 0 ? Math.min(requestedOffset, Math.floor((total - 1) / requestedLimit) * requestedLimit) : 0;
    const pageAvailable = !unknownDeepPage && (!truncated || requestedPageOffset < availableRecords.length);
    const effectiveOffset = unknownDeepPage ? requestedOffset : requestedPageOffset;
    const sliced = pageAvailable ? availableRecords.slice(effectiveOffset, effectiveOffset + requestedLimit) : [];
    const pagination = {
      total,
      offset: effectiveOffset,
      limit: requestedLimit,
      requestedOffset,
      available: pageAvailable,
      truncated,
      availableCount: availableRecords.length,
      maxAvailableOffset: lastKnownPageOffset,
      ...(truncated ? { reason: pageAvailable ? "official_history_prefix_only" : "official_deep_pagination_unavailable" } : {}),
    };
    // 中文：官方会话没有 HTTP 状态；选择“仅成功/仅失败”时不能把未知状态冒充任一结果。
    // English: Official sessions have no HTTP status; success/error filters must not classify
    // unknown status as either outcome.
    const statusFiltered = statusFilter === "all" ? {
      lifetime: totalsFromSummary(lifetimeSummary),
      summary: totalsFromSummary(currentSummary),
      series: timeseries.points.map(pointFromTimeseries).filter((item) => item.at),
      records: sliced,
      total,
    } : { lifetime: emptyTotals(), summary: emptyTotals(), series: [], records: [], total: 0 };
    const response = {
      source: CODEX_OFFICIAL_SOURCE,
      official: { enabled: true, available: true, source: CODEX_OFFICIAL_SOURCE, label: CODEX_OFFICIAL_LABEL_EN, origin: this.origin, checkedAt: new Date().toISOString(), status: "available" },
      detailCache: { ...this.#cacheStorage(), maxBytes: CODEX_OFFICIAL_CACHE_MAX_BYTES, targetBytes: CODEX_OFFICIAL_CACHE_TARGET_BYTES, pageLimit: requestedLimit, storage: "codex-usage-memory-cache" },
      lifetime: statusFiltered.lifetime,
      summary: statusFiltered.summary,
      series: statusFiltered.series,
      records: statusFiltered.records,
      recordPagination: statusFilter === "all" ? pagination : { total: statusFiltered.total, offset: 0, limit: requestedLimit, requestedOffset, available: true, truncated: false, availableCount: 0, maxAvailableOffset: 0 },
      filters: { providers: [{ id: CODEX_OFFICIAL_SOURCE, name: CODEX_OFFICIAL_LABEL_EN }], models: [] },
      range,
      updatedAt: new Date().toISOString(),
    };
    response.detailCache.bytes = Math.min(CODEX_OFFICIAL_CACHE_MAX_BYTES, this.#cacheStorage().bytes);
    return response;
  }

  async safeSnapshot(url) {
    // 中文：官方服务不可用时保留“已开启但不可用”的来源状态，避免把故障伪装成零用量。
    // English: Preserve an enabled-but-unavailable source when the official service fails instead
    // of disguising an outage as zero usage.
    try { return await this.snapshot(url); }
    catch (error) {
      return {
        source: CODEX_OFFICIAL_SOURCE,
        official: { enabled: true, available: false, source: CODEX_OFFICIAL_SOURCE, label: CODEX_OFFICIAL_LABEL_EN, origin: this.origin, checkedAt: new Date().toISOString(), status: "unavailable", errorCode: String(error?.message || "codex_usage_unavailable") },
        detailCache: { count: 0, bytes: 0, maxBytes: CODEX_OFFICIAL_CACHE_MAX_BYTES, targetBytes: CODEX_OFFICIAL_CACHE_TARGET_BYTES, pageLimit: 0, storage: "codex-usage-memory-cache" },
        lifetime: emptyTotals(), summary: emptyTotals(), series: [], records: [], recordPagination: { total: 0, offset: 0, limit: 0 },
        filters: { providers: [{ id: CODEX_OFFICIAL_SOURCE, name: CODEX_OFFICIAL_LABEL_EN }], models: [] },
        range: rangeKey(queryValue(url, "range", "24h")), updatedAt: new Date().toISOString(),
      };
    }
  }
}

function emptySnapshot(url, source = "relay") {
  const range = rangeKey(queryValue(url, "range", "24h"));
  return { source, official: null, detailCache: { count: 0, bytes: 0, maxBytes: 50 * 1024 * 1024, targetBytes: 45 * 1024 * 1024, pageLimit: 0 }, lifetime: emptyTotals(), summary: emptyTotals(), series: [], records: [], recordPagination: { total: 0, offset: 0, limit: 0 }, filters: { providers: [], models: [] }, range, updatedAt: new Date().toISOString() };
}

function addTotals(left, right) {
  const result = { ...emptyTotals() };
  for (const key of ["requests", "errors", "unknownRequests", "inputTokens", "outputTokens", "totalTokens", "cacheReadTokens", "cacheWriteTokens"]) result[key] = boundedNumber(left?.[key]) + boundedNumber(right?.[key]);
  result.firstRequestAt = [left?.firstRequestAt, right?.firstRequestAt].filter(Boolean).sort()[0] || "";
  result.lastRequestAt = [left?.lastRequestAt, right?.lastRequestAt].filter(Boolean).sort().at(-1) || "";
  result.cacheHitRate = result.inputTokens ? Math.min(100, (result.cacheReadTokens / result.inputTokens) * 100) : 0;
  return result;
}

function mergeSeries(left = [], right = []) {
  const values = new Map();
  for (const point of [...left, ...right]) {
    const current = values.get(point.at) || { at: point.at, ...emptyTotals() };
    values.set(point.at, addTotals(current, point));
    values.get(point.at).at = point.at;
  }
  return [...values.values()].sort((a, b) => String(a.at).localeCompare(String(b.at))).map((point) => ({ ...point, cacheHitRate: undefined }));
}

function uniqueOptions(items) {
  const map = new Map();
  for (const item of items || []) if (item?.id) map.set(String(item.id), { id: String(item.id), name: text(item.name || item.id) });
  const official = map.get(CODEX_OFFICIAL_SOURCE);
  const relay = [...map.values()]
    .filter((item) => item.id !== CODEX_OFFICIAL_SOURCE)
    .sort((left, right) => left.name.localeCompare(right.name));
  // 中文：官方 Codex 必须固定在“全部线路”后的第一个选项，不能随中转站名称排序漂移。
  // English: Keep Codex Official immediately after “All routes”; relay names must never move it.
  return official ? [official, ...relay] : relay;
}

export function combineUsageSnapshots(relay, official, url) {
  // 中文：只在读取层组合两类来源；永久累计、明细缓存和来源标记不会互相写入。
  // English: Combine sources only at the read layer; lifetime totals, detail retention, and source
  // markers never write across the relay/official boundary.
  const sourceFilter = queryValue(url, "source", "all");
  const providerId = queryValue(url, "providerId");
  const wantsOfficial = sourceFilter !== "relay" && (!providerId || providerId === CODEX_OFFICIAL_SOURCE);
  const wantsRelay = sourceFilter !== "official" && providerId !== CODEX_OFFICIAL_SOURCE;
  const relayValue = wantsRelay ? relay : emptySnapshot(url, "relay");
  const officialValue = wantsOfficial ? official : emptySnapshot(url, CODEX_OFFICIAL_SOURCE);
  const requestedOffset = Math.max(0, Math.min(1_000_000, Number(queryValue(url, "recordsOffset", "0")) || 0));
  const requestedLimit = Math.min(CODEX_OFFICIAL_MAX_RECORD_FETCH, Math.max(1, Number(queryValue(url, "limit", "100")) || 100));
  const records = [...(relayValue.records || []), ...(officialValue.records || [])].sort((left, right) => String(right.at).localeCompare(String(left.at)) || String(right.id).localeCompare(String(left.id)));
  const total = boundedNumber(relayValue.recordPagination?.total) + boundedNumber(officialValue.recordPagination?.total);
  const effectiveOffset = Math.min(requestedOffset, total ? Math.floor((total - 1) / requestedLimit) * requestedLimit : 0);
  const officialPagination = officialValue.recordPagination || {};
  const relayPagination = relayValue.recordPagination || {};
  const sourcePagination = providerId === CODEX_OFFICIAL_SOURCE || sourceFilter === "official" ? officialPagination : relayPagination;
  const truncatedSources = [relayPagination, officialPagination].filter((item) => item.truncated);
  const guaranteedPrefix = truncatedSources.length ? Math.min(...truncatedSources.map((item) => boundedNumber(item.availableCount))) : total;
  const combinedPageAvailable = truncatedSources.length ? effectiveOffset < guaranteedPrefix : sourcePagination.available !== false;
  const combinedPagination = {
    total,
    offset: effectiveOffset,
    limit: requestedLimit,
    requestedOffset: sourceFilter === "all" ? requestedOffset : (sourcePagination.requestedOffset ?? requestedOffset),
    available: combinedPageAvailable,
    truncated: truncatedSources.length > 0,
    availableCount: truncatedSources.length ? guaranteedPrefix : total,
    maxAvailableOffset: truncatedSources.length ? (guaranteedPrefix > 0 ? Math.floor((guaranteedPrefix - 1) / requestedLimit) * requestedLimit : 0) : (total > 0 ? Math.floor((total - 1) / requestedLimit) * requestedLimit : 0),
    ...((truncatedSources.length || sourcePagination.available === false) ? { reason: combinedPageAvailable ? "official_history_prefix_only" : "official_deep_pagination_unavailable" } : {}),
  };
  const models = [...new Set([...(relayValue.filters?.models || []), ...(officialValue.filters?.models || [])].filter(Boolean))].sort();
  const detailCache = {
    count: boundedNumber(relayValue.detailCache?.count) + boundedNumber(officialValue.detailCache?.count),
    bytes: boundedNumber(relayValue.detailCache?.bytes) + boundedNumber(officialValue.detailCache?.bytes),
    maxBytes: boundedNumber(relayValue.detailCache?.maxBytes || 50 * 1024 * 1024) + boundedNumber(officialValue.detailCache?.maxBytes || CODEX_OFFICIAL_CACHE_MAX_BYTES),
    targetBytes: boundedNumber(relayValue.detailCache?.targetBytes || 45 * 1024 * 1024) + boundedNumber(officialValue.detailCache?.targetBytes || CODEX_OFFICIAL_CACHE_TARGET_BYTES),
    pageLimit: requestedLimit,
    relayMaxBytes: boundedNumber(relayValue.detailCache?.maxBytes || 50 * 1024 * 1024),
    codexOfficialMaxBytes: CODEX_OFFICIAL_CACHE_MAX_BYTES,
  };
  return {
    source: sourceFilter,
    // Keep source health in the response when that source was requested; relay-only queries do
    // not contact the optional official service just to render a global status badge.
    official: official?.official || officialValue.official || null,
    detailCache,
    lifetime: addTotals(relayValue.lifetime, officialValue.lifetime),
    summary: addTotals(relayValue.summary, officialValue.summary),
    series: mergeSeries(relayValue.series, officialValue.series),
    // For the combined view both sources are fetched from offset zero, then one global
    // time-ordered page is selected. This prevents an offset from being applied twice
    // independently and losing records when relay and official streams are interleaved.
    records: sourceFilter === "all" ? records.slice(effectiveOffset, effectiveOffset + requestedLimit) : records.slice(0, requestedLimit),
    recordPagination: sourceFilter === "all" || providerId === CODEX_OFFICIAL_SOURCE ? combinedPagination : { ...combinedPagination, ...sourcePagination },
    // 中文：筛选目录必须来自未裁剪的原始快照。当前 providerId 只裁剪统计数据，不能把其他线路从下拉框删除。
    // English: Build the selector catalog from the unfiltered source snapshots. providerId filters
    // result data only; it must never remove the other routes from the dropdown.
    filters: { providers: uniqueOptions([
      ...(relay.filters?.providers || []),
      ...(official.filters?.providers || []),
      { id: CODEX_OFFICIAL_SOURCE, name: CODEX_OFFICIAL_LABEL_EN },
    ]), models },
    range: relayValue.range || officialValue.range || "24h",
    updatedAt: new Date().toISOString(),
  };
}

export { emptySnapshot };
