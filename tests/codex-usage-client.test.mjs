/**
 * 中文：验证正版 Codex 来源的本机 API 适配、不可用状态和来源隔离合并。
 * English: Verify the official Codex loopback adapter, unavailable state, and source-isolated merge.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  CODEX_OFFICIAL_CACHE_MAX_BYTES,
  CODEX_OFFICIAL_CACHE_TARGET_BYTES,
  CODEX_OFFICIAL_MAX_RECORD_FETCH,
  CODEX_OFFICIAL_SOURCE,
  CodexUsageClient,
  combineUsageSnapshots,
} from "../gateway/codex-usage-client.mjs";

function response(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function relaySnapshot() {
  return {
    source: "relay",
    official: { enabled: true, available: true, source: CODEX_OFFICIAL_SOURCE, label: "Codex Official", origin: "http://127.0.0.1:43189", status: "available" },
    detailCache: { count: 1, bytes: 120, maxBytes: 50 * 1024 * 1024, targetBytes: 45 * 1024 * 1024, pageLimit: 200 },
    lifetime: { requests: 1, errors: 0, inputTokens: 10, outputTokens: 2, totalTokens: 12, cacheReadTokens: 4, cacheWriteTokens: 0, firstRequestAt: "2026-09-25T00:00:00.000Z", lastRequestAt: "2026-09-25T00:00:00.000Z" },
    summary: { requests: 1, errors: 0, inputTokens: 10, outputTokens: 2, totalTokens: 12, cacheReadTokens: 4, cacheWriteTokens: 0, firstRequestAt: "2026-09-25T00:00:00.000Z", lastRequestAt: "2026-09-25T00:00:00.000Z" },
    series: [{ at: "2026-09-25T00:00:00.000Z", requests: 1, errors: 0, inputTokens: 10, outputTokens: 2, totalTokens: 12, cacheReadTokens: 4, cacheWriteTokens: 0 }],
    records: [{ id: "relay-1", at: "2026-09-25T00:00:00.000Z", providerId: "route-a", providerName: "Relay A", source: "relay", status: 200, inputTokens: 10, outputTokens: 2, totalTokens: 12, cacheReadTokens: 4, cacheWriteTokens: 0 }],
    recordPagination: { total: 1, offset: 0, limit: 200 },
    filters: { providers: [{ id: "route-a", name: "Relay A" }], models: ["relay-model"] },
    range: "24h",
  };
}

test("official Codex API stays separate and has an independent 50 MB cache budget", async () => {
  const client = new CodexUsageClient({ origin: "http://127.0.0.1:43189", fetchImpl: async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/summary")) return response({ event_count: 2, usage: { input: 100, cached_input: 40, output: 20, total: 120 }, first_event: "2026-09-24T00:00:00Z", last_event: "2026-09-25T00:00:00Z" });
    if (path.endsWith("/timeseries")) return response({ points: [{ time: "2026-09-25T00:00:00Z", event_count: 2, usage: { input: 100, cached_input: 40, output: 20, total: 120 } }] });
    if (path.endsWith("/sessions")) return response({ items: [{ session_id: "session-1", last_usage: "2026-09-25T00:00:00Z", model: "gpt-6-luna", input_tokens: 100, output_tokens: 20, total_tokens: 120, cached_input_tokens: 40 }] });
    throw new Error(`unexpected ${path}`);
  }});
  const value = await client.snapshot(new URL("http://gateway.test/admin/api/usage?range=24h&limit=20"));
  assert.equal(value.official.available, true);
  assert.equal(value.detailCache.maxBytes, CODEX_OFFICIAL_CACHE_MAX_BYTES);
  assert.equal(value.summary.totalTokens, 120);
  assert.equal(value.records[0].providerId, CODEX_OFFICIAL_SOURCE);
  assert.equal(value.records[0].source, CODEX_OFFICIAL_SOURCE);
  assert.equal(value.records[0].status, null);
  assert.equal(value.records[0].durationMs, null);
  assert.equal(value.records[0].ttftMs, null);
});

test("official session records read nested usage fields from the real API shape", async () => {
  const client = new CodexUsageClient({ fetchImpl: async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/summary")) return response({ event_count: 1, usage: { input: 12, output: 3, total: 15 } });
    if (path.endsWith("/timeseries")) return response({ points: [] });
    if (path.endsWith("/sessions")) return response({ items: [{ session_id: "nested-1", last_usage: "2026-09-25T00:00:00Z", usage: { input: 12, output: 3, total: 15, cached_input: 4, cache_write_input: 1 } }] });
    throw new Error(`unexpected ${path}`);
  }});
  const value = await client.snapshot(new URL("http://gateway.test/admin/api/usage?range=24h&limit=20"));
  assert.equal(value.records[0].inputTokens, 12);
  assert.equal(value.records[0].outputTokens, 3);
  assert.equal(value.records[0].totalTokens, 15);
  assert.equal(value.records[0].cacheReadTokens, 4);
  assert.equal(value.records[0].cacheWriteTokens, 1);
});

test("official detail cache enforces one global budget across model buckets", async () => {
  const padding = "x".repeat(16 * 1024 * 1024);
  const models = ["model-a", "model-b", "model-c"];
  const client = new CodexUsageClient({ fetchImpl: async (url) => {
    const target = new URL(url);
    const path = target.pathname;
    if (path.endsWith("/summary")) return response({ event_count: 1, usage: { input: 1, output: 1, total: 2 } });
    if (path.endsWith("/timeseries")) return response({ points: [] });
    if (path.endsWith("/sessions")) {
      const model = target.searchParams.get("model") || "all";
      return response({ items: [{ session_id: `${model}-${padding}`, last_usage: `2026-09-${models.indexOf(model) + 1}T00:00:00Z`, model, input_tokens: 1, output_tokens: 1, total_tokens: 2 }] });
    }
    throw new Error(`unexpected ${path}`);
  }});

  for (const model of models) await client.snapshot(new URL(`http://gateway.test/admin/api/usage?range=24h&limit=1&model=${model}`));
  const value = await client.snapshot(new URL("http://gateway.test/admin/api/usage?range=24h&limit=1&model=model-c"));

  assert.ok(value.detailCache.bytes > 20 * 1024 * 1024, "the response reports the aggregate cache, not only model-c");
  assert.ok(value.detailCache.bytes <= CODEX_OFFICIAL_CACHE_TARGET_BYTES);
  assert.ok(value.detailCache.bytes <= CODEX_OFFICIAL_CACHE_MAX_BYTES);
  assert.equal(value.detailCache.count, 2, "the oldest model bucket is evicted by the shared budget");
});

test("official deep pagination never fabricates records beyond the fetched prefix", async () => {
  const sessionRequests = [];
  const client = new CodexUsageClient({ fetchImpl: async (url) => {
    const target = new URL(url);
    const path = target.pathname;
    if (path.endsWith("/summary")) return response({ event_count: 6001, usage: { input: 1, output: 1, total: 2 } });
    if (path.endsWith("/timeseries")) return response({ points: [] });
    if (path.endsWith("/sessions")) {
      sessionRequests.push({ limit: Number(target.searchParams.get("limit")), offset: Number(target.searchParams.get("offset") || 0) });
      return response({
        total: 6001,
        items: [
          { session_id: "prefix-1", last_usage: "2026-09-25T02:00:00Z", model: "gpt-6-luna", input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          { session_id: "prefix-2", last_usage: "2026-09-25T01:00:00Z", model: "gpt-6-luna", input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        ],
      });
    }
    throw new Error(`unexpected ${path}`);
  }});

  const firstPage = await client.snapshot(new URL("http://gateway.test/admin/api/usage?range=24h&limit=100&recordsOffset=0"));
  assert.equal(firstPage.records.length, 2);
  assert.equal(firstPage.recordPagination.total, 6001);
  assert.equal(firstPage.recordPagination.truncated, true);
  assert.equal(firstPage.recordPagination.available, true);
  assert.equal(firstPage.recordPagination.availableCount, 2);

  const deepPage = await client.snapshot(new URL("http://gateway.test/admin/api/usage?range=24h&limit=100&recordsOffset=5000"));
  assert.equal(sessionRequests.at(-1).limit, CODEX_OFFICIAL_MAX_RECORD_FETCH);
  assert.equal(sessionRequests.at(-1).offset, 0, "the adapter does not claim unsupported deep offsets were fetched");
  assert.deepEqual(deepPage.records, []);
  assert.equal(deepPage.recordPagination.total, 6001);
  assert.equal(deepPage.recordPagination.requestedOffset, 5000);
  assert.equal(deepPage.recordPagination.available, false);
  assert.equal(deepPage.recordPagination.truncated, true);
  assert.equal(deepPage.recordPagination.reason, "official_deep_pagination_unavailable");
});

test("official deep pagination stays unavailable when the service omits a total", async () => {
  const client = new CodexUsageClient({ fetchImpl: async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/summary")) return response({ event_count: 2, usage: { input: 1, output: 1, total: 2 } });
    if (path.endsWith("/timeseries")) return response({ points: [] });
    if (path.endsWith("/sessions")) return response({ items: [{ session_id: "only-prefix", last_usage: "2026-09-25T00:00:00Z", model: "gpt-6-luna", input_tokens: 1, output_tokens: 1, total_tokens: 2 }] });
    throw new Error(`unexpected ${path}`);
  }});

  const value = await client.snapshot(new URL("http://gateway.test/admin/api/usage?range=24h&limit=100&recordsOffset=5000"));
  assert.deepEqual(value.records, [], "without a total, the adapter must not return the first page for a deep-page request");
  assert.equal(value.recordPagination.available, false);
  assert.equal(value.recordPagination.truncated, true);
  assert.equal(value.recordPagination.reason, "official_deep_pagination_unavailable");
});

test("official sessions stay out of success and error filters because HTTP status is unknown", async () => {
  const client = new CodexUsageClient({ fetchImpl: async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/summary")) return response({ event_count: 1, usage: { input: 12, output: 3, total: 15 } });
    if (path.endsWith("/timeseries")) return response({ points: [] });
    if (path.endsWith("/sessions")) return response({ items: [{ session_id: "unknown-status", last_usage: "2026-09-25T00:00:00Z", usage: { input: 12, output: 3, total: 15 } }] });
    throw new Error(`unexpected ${path}`);
  }});
  const value = await client.snapshot(new URL("http://gateway.test/admin/api/usage?range=24h&status=success"));
  assert.equal(value.summary.requests, 0);
  assert.equal(value.records.length, 0);
  assert.equal(value.recordPagination.total, 0);
});

test("an unavailable official service is reported without disabling the source", async () => {
  const client = new CodexUsageClient({ fetchImpl: async () => { throw new Error("connect refused"); } });
  const value = await client.safeSnapshot(new URL("http://gateway.test/admin/api/usage?range=24h"));
  assert.equal(value.official.enabled, true);
  assert.equal(value.official.available, false);
  assert.equal(value.records.length, 0);
});

test("all-source merge sums relay and official totals without putting official records in relay data", () => {
  const relay = relaySnapshot();
  const official = {
    source: CODEX_OFFICIAL_SOURCE,
    official: { enabled: true, available: true, source: CODEX_OFFICIAL_SOURCE, label: "Codex Official", origin: "http://127.0.0.1:43189", status: "available" },
    detailCache: { count: 1, bytes: 80, maxBytes: CODEX_OFFICIAL_CACHE_MAX_BYTES, targetBytes: 45 * 1024 * 1024, pageLimit: 200 },
    lifetime: { requests: 2, errors: 0, inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 40, cacheWriteTokens: 0, firstRequestAt: "2026-09-24T00:00:00.000Z", lastRequestAt: "2026-09-25T00:00:00.000Z" },
    summary: { requests: 2, errors: 0, inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 40, cacheWriteTokens: 0, firstRequestAt: "2026-09-24T00:00:00.000Z", lastRequestAt: "2026-09-25T00:00:00.000Z" },
    series: [{ at: "2026-09-25T00:00:00.000Z", requests: 2, errors: 0, inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 40, cacheWriteTokens: 0 }],
    records: [{ id: "codex-1", at: "2026-09-24T00:00:00.000Z", providerId: CODEX_OFFICIAL_SOURCE, providerName: "Codex Official", source: CODEX_OFFICIAL_SOURCE, status: 200, inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 40, cacheWriteTokens: 0 }],
    recordPagination: { total: 1, offset: 0, limit: 200 },
    filters: { providers: [{ id: CODEX_OFFICIAL_SOURCE, name: "Codex Official" }], models: ["gpt-6-luna"] },
    range: "24h",
  };
  const value = combineUsageSnapshots(relay, official, new URL("http://gateway.test/admin/api/usage?range=24h&source=all&limit=20"));
  assert.equal(value.summary.totalTokens, 132);
  assert.equal(value.lifetime.totalTokens, 132);
  assert.equal(value.detailCache.relayMaxBytes, 50 * 1024 * 1024);
  assert.equal(value.detailCache.codexOfficialMaxBytes, CODEX_OFFICIAL_CACHE_MAX_BYTES);
  assert.deepEqual(new Set(value.records.map((item) => item.source)), new Set(["relay", CODEX_OFFICIAL_SOURCE]));
  assert.equal(value.filters.providers[0].id, CODEX_OFFICIAL_SOURCE, "Codex Official stays first after All routes");
  assert.ok(value.filters.providers.some((item) => item.id === CODEX_OFFICIAL_SOURCE));
});

// 中文：分页必须在两类来源合并后按全局时间顺序计算，不能分别 offset 后再拼接。
// English: Pagination must use one global time order after merging both sources, not two offsets followed by concatenation.
test("all-source pagination is applied after relay and official records are merged", () => {
  const relay = {
    ...relaySnapshot(),
    records: [
      { id: "relay-new", at: "2026-09-25T04:00:00.000Z", source: "relay", providerId: "route-a" },
      { id: "relay-old", at: "2026-09-25T02:00:00.000Z", source: "relay", providerId: "route-a" },
    ],
    recordPagination: { total: 2, offset: 0, limit: 2 },
  };
  const official = {
    ...relaySnapshot(),
    source: CODEX_OFFICIAL_SOURCE,
    records: [
      { id: "codex-new", at: "2026-09-25T03:00:00.000Z", source: CODEX_OFFICIAL_SOURCE, providerId: CODEX_OFFICIAL_SOURCE },
      { id: "codex-old", at: "2026-09-25T01:00:00.000Z", source: CODEX_OFFICIAL_SOURCE, providerId: CODEX_OFFICIAL_SOURCE },
    ],
    recordPagination: { total: 2, offset: 0, limit: 2 },
    filters: { providers: [{ id: CODEX_OFFICIAL_SOURCE, name: "Codex Official" }], models: [] },
  };
  const value = combineUsageSnapshots(relay, official, new URL("http://gateway.test/admin/api/usage?source=all&recordsOffset=1&limit=2"));
  assert.deepEqual(value.records.map((item) => item.id), ["codex-new", "relay-old"]);
  assert.equal(value.recordPagination.offset, 1);
  assert.equal(value.recordPagination.total, 4);
});

test("all-source merge preserves official deep-pagination unavailability metadata", () => {
  const relay = relaySnapshot();
  const official = {
    ...relaySnapshot(),
    source: CODEX_OFFICIAL_SOURCE,
    records: [{ id: "codex-prefix", at: "2026-09-25T03:00:00.000Z", source: CODEX_OFFICIAL_SOURCE, providerId: CODEX_OFFICIAL_SOURCE }],
    recordPagination: {
      total: 6001,
      offset: 0,
      limit: 5000,
      requestedOffset: 0,
      available: true,
      truncated: true,
      availableCount: 1,
      maxAvailableOffset: 0,
      reason: "official_history_prefix_only",
    },
  };
  const value = combineUsageSnapshots(relay, official, new URL("http://gateway.test/admin/api/usage?source=all&recordsOffset=5000&limit=200"));
  assert.deepEqual(value.records, []);
  assert.equal(value.recordPagination.requestedOffset, 5000);
  assert.equal(value.recordPagination.available, false);
  assert.equal(value.recordPagination.truncated, true);
  assert.equal(value.recordPagination.reason, "official_deep_pagination_unavailable");
});
