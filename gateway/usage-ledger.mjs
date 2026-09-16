/**
 * 中文：SQLite 使用总账。请求明细、永久计数器和待同步队列在同一事务中提交。
 * English: SQLite usage ledger. Request details, lifetime counters, and the outbox commit atomically.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DETAIL_CACHE_MAX_BYTES = 50 * 1024 * 1024;
const DETAIL_CACHE_TARGET_BYTES = 45 * 1024 * 1024;

function detailBytesSql(alias = "") {
  const prefix = alias ? `${alias}.` : "";
  const length = (column) => `COALESCE(LENGTH(CAST(${prefix}${column} AS BLOB)),0)`;
  // 中文：320 字节用于近似覆盖 SQLite 行结构与索引开销；正文和密钥从不进入明细表。
  // English: 320 bytes approximate SQLite row/index overhead; prompts and secrets never enter this table.
  return `(320 + ${[
    "event_id", "dataset_id", "device_id", "occurred_at_utc", "provider_id", "provider_name_snapshot",
    "client_id", "client_name_snapshot", "model", "endpoint", "method", "thinking_level", "error_summary", "created_at_utc",
  ].map(length).join(" + ")})`;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  try { fs.renameSync(temporary, file); }
  catch (error) {
    try { fs.copyFileSync(temporary, file); fs.unlinkSync(temporary); }
    catch { try { fs.unlinkSync(temporary); } catch { /* best effort cleanup */ } throw error; }
  }
}

function boundedInteger(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.round(parsed));
}

function emptyTotals() {
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

function totalsView(value = {}) {
  const totals = { ...emptyTotals(), ...value };
  const input = boundedInteger(totals.inputTokens);
  return { ...totals, cacheHitRate: input ? Math.min(100, (boundedInteger(totals.cacheReadTokens) / input) * 100) : 0 };
}

function rangeDefinition(value) {
  const ranges = {
    "24h": { durationMs: 24 * 60 * 60 * 1000, bucketMs: 60 * 60 * 1000 },
    "7d": { durationMs: 7 * 24 * 60 * 60 * 1000, bucketMs: 6 * 60 * 60 * 1000 },
    "30d": { durationMs: 30 * 24 * 60 * 60 * 1000, bucketMs: 24 * 60 * 60 * 1000 },
    "90d": { durationMs: 90 * 24 * 60 * 60 * 1000, bucketMs: 3 * 24 * 60 * 60 * 1000 },
    "180d": { durationMs: 180 * 24 * 60 * 60 * 1000, bucketMs: 7 * 24 * 60 * 60 * 1000 },
  };
  const key = Object.prototype.hasOwnProperty.call(ranges, value) ? value : "24h";
  return { key, ...ranges[key] };
}

function rowToRecord(row) {
  return {
    id: row.event_id,
    eventId: row.event_id,
    datasetId: row.dataset_id,
    deviceId: row.device_id,
    deviceEpoch: row.device_epoch,
    sequence: row.sequence,
    at: row.occurred_at_utc,
    clientKeyId: row.client_id || "",
    clientKeyName: row.client_name_snapshot || "",
    providerId: row.provider_id,
    providerName: row.provider_name_snapshot || row.provider_id,
    model: row.model,
    endpoint: row.endpoint,
    method: row.method,
    reasoningLevel: row.thinking_level,
    stream: Boolean(row.stream),
    status: row.http_status,
    durationMs: row.latency_ms,
    ttftMs: row.ttft_ms,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    usageAvailable: Boolean(row.usage_available),
    error: row.error_summary || "",
  };
}

export class UsageLedger {
  constructor(dataDir, options = {}) {
    this.dataDir = dataDir;
    this.databaseFile = path.join(dataDir, "usage.db");
    this.deviceFile = path.join(dataDir, "device.json");
    this.legacyUsageFile = path.join(dataDir, "usage.json");
    this.backupDir = path.join(dataDir, "backups");
    this.detailCacheMaxBytes = Math.max(1024, boundedInteger(options.detailCacheMaxBytes || DETAIL_CACHE_MAX_BYTES));
    this.detailCacheTargetBytes = Math.min(this.detailCacheMaxBytes, Math.max(512, boundedInteger(options.detailCacheTargetBytes || DETAIL_CACHE_TARGET_BYTES)));
    fs.mkdirSync(dataDir, { recursive: true });
    this.identity = this.#loadIdentity();
    this.db = new DatabaseSync(this.databaseFile);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.#createSchema();
    this.#migrateLegacyUsage();
    this.prune();
  }

  #loadIdentity() {
    const current = readJson(this.deviceFile, {});
    const identity = {
      schemaVersion: 1,
      datasetId: /^ds_[0-9a-f-]{36}$/i.test(String(current.datasetId || "")) ? current.datasetId : `ds_${crypto.randomUUID()}`,
      deviceId: /^dev_[0-9a-f-]{36}$/i.test(String(current.deviceId || "")) ? current.deviceId : `dev_${crypto.randomUUID()}`,
      deviceEpoch: Math.max(1, boundedInteger(current.deviceEpoch || 1)),
      createdAtUtc: String(current.createdAtUtc || new Date().toISOString()),
      updatedAtUtc: new Date().toISOString(),
    };
    writeJsonAtomic(this.deviceFile, identity);
    return identity;
  }

  #createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage_events (
        event_id TEXT PRIMARY KEY,
        dataset_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        device_epoch INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        occurred_at_utc TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        provider_name_snapshot TEXT,
        client_id TEXT,
        client_name_snapshot TEXT,
        model TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        method TEXT NOT NULL,
        thinking_level TEXT NOT NULL,
        stream INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        latency_ms INTEGER NOT NULL DEFAULT 0,
        ttft_ms INTEGER NOT NULL DEFAULT 0,
        http_status INTEGER NOT NULL DEFAULT 0,
        success INTEGER NOT NULL,
        usage_available INTEGER NOT NULL,
        error_summary TEXT,
        sync_state TEXT NOT NULL DEFAULT 'pending',
        created_at_utc TEXT NOT NULL,
        UNIQUE(dataset_id, device_id, device_epoch, sequence)
      );
      CREATE INDEX IF NOT EXISTS idx_usage_time ON usage_events(occurred_at_utc DESC);
      CREATE INDEX IF NOT EXISTS idx_usage_filter ON usage_events(provider_id, model, http_status, occurred_at_utc DESC);
      CREATE INDEX IF NOT EXISTS idx_usage_sync ON usage_events(sync_state, device_id, device_epoch, sequence);
      CREATE TABLE IF NOT EXISTS usage_counters (
        dataset_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        device_epoch INTEGER NOT NULL,
        last_sequence INTEGER NOT NULL DEFAULT 0,
        requests INTEGER NOT NULL DEFAULT 0,
        errors INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        first_request_at TEXT,
        last_request_at TEXT,
        PRIMARY KEY(dataset_id, device_id, device_epoch)
      );
      CREATE TABLE IF NOT EXISTS outbox (
        outbox_id TEXT PRIMARY KEY,
        dataset_id TEXT NOT NULL,
        object_type TEXT NOT NULL,
        object_id TEXT NOT NULL,
        created_at_utc TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at_utc TEXT,
        state TEXT NOT NULL DEFAULT 'pending',
        last_error_code TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_outbox_state ON outbox(state, created_at_utc);
      CREATE TABLE IF NOT EXISTS tombstones (
        object_type TEXT NOT NULL,
        object_id TEXT NOT NULL,
        deleted_revision TEXT NOT NULL,
        deleted_by_device TEXT NOT NULL,
        deleted_at_generation INTEGER NOT NULL DEFAULT 0,
        deleted_at_utc TEXT NOT NULL,
        PRIMARY KEY(object_type, object_id)
      );
      CREATE TABLE IF NOT EXISTS sync_runs (
        sync_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        state TEXT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 0,
        started_at_utc TEXT NOT NULL,
        finished_at_utc TEXT,
        error_code TEXT,
        summary TEXT
      );
    `);
    this.db.prepare("INSERT OR REPLACE INTO schema_meta(key, value) VALUES('schema_version', '1')").run();
  }

  #migrateLegacyUsage() {
    const migrated = this.db.prepare("SELECT value FROM schema_meta WHERE key='legacy_usage_imported'").get();
    if (migrated) return;
    const legacy = readJson(this.legacyUsageFile, null);
    if (!legacy || typeof legacy !== "object") {
      this.db.prepare("INSERT OR REPLACE INTO schema_meta(key, value) VALUES('legacy_usage_imported', ?)").run(new Date().toISOString());
      return;
    }
    fs.mkdirSync(this.backupDir, { recursive: true });
    const backupName = `usage-legacy-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    fs.copyFileSync(this.legacyUsageFile, path.join(this.backupDir, backupName));
    const lifetime = { ...emptyTotals(), ...(legacy.lifetime || {}) };
    const legacyDevice = "dev_legacy_import";
    const records = Array.isArray(legacy.records) ? legacy.records : [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT OR REPLACE INTO usage_counters(
        dataset_id, device_id, device_epoch, last_sequence, requests, errors,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens,
        first_request_at, last_request_at
      ) VALUES(?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        this.identity.datasetId, legacyDevice, boundedInteger(lifetime.requests), boundedInteger(lifetime.requests), boundedInteger(lifetime.errors),
        boundedInteger(lifetime.inputTokens), boundedInteger(lifetime.outputTokens), boundedInteger(lifetime.cacheReadTokens),
        boundedInteger(lifetime.cacheWriteTokens), boundedInteger(lifetime.totalTokens), String(lifetime.firstRequestAt || ""), String(lifetime.lastRequestAt || ""),
      );
      const insert = this.db.prepare(`INSERT OR IGNORE INTO usage_events(
        event_id, dataset_id, device_id, device_epoch, sequence, occurred_at_utc,
        provider_id, provider_name_snapshot, client_id, client_name_snapshot, model,
        endpoint, method, thinking_level, stream, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, total_tokens, latency_ms, ttft_ms,
        http_status, success, usage_available, error_summary, sync_state, created_at_utc
      ) VALUES(?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'imported', ?)`);
      records.forEach((record, index) => {
        const at = String(record.at || new Date(0).toISOString());
        insert.run(
          String(record.id || `evt_legacy_${index + 1}`), this.identity.datasetId, legacyDevice, index + 1, at,
          String(record.providerId || "legacy"), String(record.providerName || "Legacy"), String(record.clientKeyId || ""),
          String(record.clientKeyName || ""), String(record.model || ""), String(record.endpoint || ""), String(record.method || "POST"),
          String(record.reasoningLevel || "high"), record.stream ? 1 : 0, boundedInteger(record.inputTokens), boundedInteger(record.outputTokens),
          boundedInteger(record.cacheReadTokens), boundedInteger(record.cacheWriteTokens), boundedInteger(record.totalTokens), boundedInteger(record.durationMs),
          boundedInteger(record.ttftMs), boundedInteger(record.status), Number(record.status || 0) < 400 ? 1 : 0,
          boundedInteger(record.totalTokens) > 0 ? 1 : 0, String(record.error || "").slice(0, 300), at,
        );
      });
      this.db.prepare("INSERT OR REPLACE INTO schema_meta(key, value) VALUES('legacy_usage_imported', ?)").run(new Date().toISOString());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  append(record) {
    const now = String(record.at || new Date().toISOString());
    const eventId = String(record.eventId || record.id || `evt_${crypto.randomUUID()}`);
    const identity = this.identity;
    const current = this.db.prepare(`SELECT last_sequence FROM usage_counters
      WHERE dataset_id=? AND device_id=? AND device_epoch=?`).get(identity.datasetId, identity.deviceId, identity.deviceEpoch);
    const sequence = boundedInteger(current?.last_sequence) + 1;
    const status = boundedInteger(record.status);
    const values = {
      input: boundedInteger(record.inputTokens), output: boundedInteger(record.outputTokens),
      cacheRead: boundedInteger(record.cacheReadTokens), cacheWrite: boundedInteger(record.cacheWriteTokens),
      total: boundedInteger(record.totalTokens),
    };
    let inserted = false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare(`INSERT OR IGNORE INTO usage_events(
        event_id, dataset_id, device_id, device_epoch, sequence, occurred_at_utc,
        provider_id, provider_name_snapshot, client_id, client_name_snapshot, model,
        endpoint, method, thinking_level, stream, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, total_tokens, latency_ms, ttft_ms,
        http_status, success, usage_available, error_summary, sync_state, created_at_utc
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`).run(
        eventId, identity.datasetId, identity.deviceId, identity.deviceEpoch, sequence, now,
        String(record.providerId || ""), String(record.providerName || "").slice(0, 200), String(record.clientKeyId || ""),
        String(record.clientKeyName || "").slice(0, 200), String(record.model || "").slice(0, 300), String(record.endpoint || "").slice(0, 200),
        String(record.method || "POST").slice(0, 12), String(record.reasoningLevel || "high").slice(0, 12), record.stream ? 1 : 0,
        values.input, values.output, values.cacheRead, values.cacheWrite, values.total, boundedInteger(record.durationMs), boundedInteger(record.ttftMs),
        status, status >= 200 && status < 400 ? 1 : 0, values.total > 0 ? 1 : 0, String(record.error || "").slice(0, 300), now,
      );
      if (result.changes) {
        inserted = true;
        this.db.prepare(`INSERT INTO usage_counters(
          dataset_id, device_id, device_epoch, last_sequence, requests, errors,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens,
          first_request_at, last_request_at
        ) VALUES(?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(dataset_id, device_id, device_epoch) DO UPDATE SET
          last_sequence=excluded.last_sequence,
          requests=requests+1,
          errors=errors+excluded.errors,
          input_tokens=input_tokens+excluded.input_tokens,
          output_tokens=output_tokens+excluded.output_tokens,
          cache_read_tokens=cache_read_tokens+excluded.cache_read_tokens,
          cache_write_tokens=cache_write_tokens+excluded.cache_write_tokens,
          total_tokens=total_tokens+excluded.total_tokens,
          first_request_at=CASE WHEN first_request_at IS NULL OR first_request_at='' THEN excluded.first_request_at ELSE first_request_at END,
          last_request_at=excluded.last_request_at`).run(
            identity.datasetId, identity.deviceId, identity.deviceEpoch, sequence, status >= 400 ? 1 : 0,
            values.input, values.output, values.cacheRead, values.cacheWrite, values.total, now, now,
          );
        this.db.prepare(`INSERT INTO outbox(outbox_id, dataset_id, object_type, object_id, created_at_utc)
          VALUES(?, ?, 'usage-event', ?, ?)`).run(`out_${crypto.randomUUID()}`, identity.datasetId, eventId, now);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.prune();
    return { eventId, sequence, inserted };
  }

  addTombstone(objectType, objectId, revision = "") {
    const at = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT INTO tombstones(object_type, object_id, deleted_revision, deleted_by_device, deleted_at_utc)
        VALUES(?, ?, ?, ?, ?) ON CONFLICT(object_type, object_id) DO UPDATE SET
        deleted_revision=excluded.deleted_revision, deleted_by_device=excluded.deleted_by_device,
        deleted_at_utc=excluded.deleted_at_utc`).run(String(objectType), String(objectId), String(revision || at), this.identity.deviceId, at);
      this.db.prepare(`INSERT INTO outbox(outbox_id, dataset_id, object_type, object_id, created_at_utc)
        VALUES(?, ?, 'tombstone', ?, ?)`).run(`out_${crypto.randomUUID()}`, this.identity.datasetId, `${objectType}:${objectId}`, at);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  prune() {
    const before = this.detailStorage();
    if (before.bytes <= this.detailCacheMaxBytes) return { ...before, deleted: 0, overLimit: false };

    const candidates = this.db.prepare(`SELECT e.event_id, ${detailBytesSql("e")} AS bytes,
      CASE WHEN EXISTS (
        SELECT 1 FROM outbox pending
        WHERE pending.object_type='usage-event' AND pending.object_id=e.event_id AND pending.state='pending'
      ) THEN 1 ELSE 0 END AS is_pending
      FROM usage_events e
      ORDER BY is_pending ASC, e.occurred_at_utc ASC, e.event_id ASC`).all();
    let remaining = before.bytes;
    let deleted = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const deleteEvent = this.db.prepare("DELETE FROM usage_events WHERE event_id=?");
      const deleteOutbox = this.db.prepare("DELETE FROM outbox WHERE object_type='usage-event' AND object_id=? AND state<>'pending'");
      const prunePendingOutbox = this.db.prepare("UPDATE outbox SET state='pruned', last_error_code='detail_cache_limit' WHERE object_type='usage-event' AND object_id=? AND state='pending'");
      for (const candidate of candidates) {
        if (remaining <= this.detailCacheTargetBytes) break;
        if (candidate.is_pending) prunePendingOutbox.run(candidate.event_id);
        else deleteOutbox.run(candidate.event_id);
        const result = deleteEvent.run(candidate.event_id);
        if (result.changes) {
          remaining = Math.max(0, remaining - boundedInteger(candidate.bytes));
          deleted += 1;
        }
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    const after = this.detailStorage();
    return { ...after, deleted, overLimit: after.bytes > this.detailCacheMaxBytes };
  }

  detailStorage() {
    const value = this.db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(${detailBytesSql()}),0) AS bytes FROM usage_events`).get();
    return {
      count: Number(value.count || 0),
      bytes: Number(value.bytes || 0),
      maxBytes: this.detailCacheMaxBytes,
      targetBytes: this.detailCacheTargetBytes,
    };
  }

  snapshot(url) {
    const range = rangeDefinition(String(url.searchParams.get("range") || "24h"));
    const now = Date.now();
    const startAt = new Date(now - range.durationMs).toISOString();
    const providerId = String(url.searchParams.get("providerId") || "");
    const model = String(url.searchParams.get("model") || "");
    const statusFilter = String(url.searchParams.get("status") || "all");
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") || 100) || 100));
    const conditions = ["occurred_at_utc >= ?"];
    const parameters = [startAt];
    if (providerId) { conditions.push("provider_id = ?"); parameters.push(providerId); }
    if (model) { conditions.push("model = ?"); parameters.push(model); }
    if (statusFilter === "success") conditions.push("http_status < 400");
    if (statusFilter === "error") conditions.push("http_status >= 400");
    const where = conditions.join(" AND ");
    const aggregate = this.db.prepare(`SELECT COUNT(*) requests,
      SUM(CASE WHEN http_status >= 400 THEN 1 ELSE 0 END) errors,
      COALESCE(SUM(input_tokens),0) inputTokens, COALESCE(SUM(output_tokens),0) outputTokens,
      COALESCE(SUM(total_tokens),0) totalTokens, COALESCE(SUM(cache_read_tokens),0) cacheReadTokens,
      COALESCE(SUM(cache_write_tokens),0) cacheWriteTokens, MIN(occurred_at_utc) firstRequestAt,
      MAX(occurred_at_utc) lastRequestAt FROM usage_events WHERE ${where}`).get(...parameters);
    const rows = this.db.prepare(`SELECT * FROM usage_events WHERE ${where} ORDER BY occurred_at_utc DESC LIMIT ?`).all(...parameters, limit);
    const bucketRows = this.db.prepare(`SELECT * FROM usage_events WHERE ${where} ORDER BY occurred_at_utc ASC`).all(...parameters);
    const alignedStart = Math.floor((now - range.durationMs) / range.bucketMs) * range.bucketMs;
    const series = [];
    for (let bucketAt = alignedStart; bucketAt <= now; bucketAt += range.bucketMs) {
      series.push({ at: new Date(bucketAt).toISOString(), requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    }
    for (const row of bucketRows) {
      const index = Math.floor((new Date(row.occurred_at_utc).valueOf() - alignedStart) / range.bucketMs);
      const bucket = series[index];
      if (!bucket) continue;
      bucket.requests += 1;
      bucket.errors += row.http_status >= 400 ? 1 : 0;
      bucket.inputTokens += row.input_tokens;
      bucket.outputTokens += row.output_tokens;
      bucket.totalTokens += row.total_tokens;
      bucket.cacheReadTokens += row.cache_read_tokens;
      bucket.cacheWriteTokens += row.cache_write_tokens;
    }
    const lifetime = this.db.prepare(`SELECT COALESCE(SUM(requests),0) requests, COALESCE(SUM(errors),0) errors,
      COALESCE(SUM(input_tokens),0) inputTokens, COALESCE(SUM(output_tokens),0) outputTokens,
      COALESCE(SUM(total_tokens),0) totalTokens, COALESCE(SUM(cache_read_tokens),0) cacheReadTokens,
      COALESCE(SUM(cache_write_tokens),0) cacheWriteTokens, MIN(NULLIF(first_request_at,'')) firstRequestAt,
      MAX(NULLIF(last_request_at,'')) lastRequestAt FROM usage_counters WHERE dataset_id=?`).get(this.identity.datasetId);
    const providers = this.db.prepare(`SELECT provider_id id, MAX(provider_name_snapshot) name
      FROM usage_events WHERE provider_id<>'' GROUP BY provider_id ORDER BY name`).all();
    const models = this.db.prepare("SELECT DISTINCT model FROM usage_events WHERE model<>'' ORDER BY model").all().map((row) => row.model);
    return {
      storage: "sqlite-wal",
      schemaVersion: 1,
      detailCache: { ...this.detailStorage(), pageLimit: limit },
      lifetime: totalsView(lifetime),
      summary: totalsView(aggregate),
      series,
      records: rows.map(rowToRecord),
      filters: { providers: providers.map((item) => ({ id: item.id, name: item.name || item.id })), models },
      range: range.key,
      updatedAt: new Date().toISOString(),
      identity: { datasetId: this.identity.datasetId, deviceId: this.identity.deviceId, deviceEpoch: this.identity.deviceEpoch },
      pendingCount: Number(this.db.prepare("SELECT COUNT(*) count FROM outbox WHERE state='pending'").get().count || 0),
    };
  }

  pendingUsage(limit = 5000) {
    return this.db.prepare(`SELECT e.* FROM usage_events e
      JOIN outbox o ON o.object_id=e.event_id AND o.object_type='usage-event'
      WHERE o.state='pending' ORDER BY e.device_id, e.device_epoch, e.sequence LIMIT ?`).all(Math.max(1, Math.min(50000, Number(limit) || 5000))).map(rowToRecord);
  }

  counters() {
    return this.db.prepare("SELECT * FROM usage_counters WHERE dataset_id=? ORDER BY device_id, device_epoch").all(this.identity.datasetId);
  }

  tombstones() { return this.db.prepare("SELECT * FROM tombstones ORDER BY deleted_at_utc").all(); }

  mergeRemote({ datasetId, events = [], counters = [], tombstones = [] } = {}) {
    if (String(datasetId || "") !== this.identity.datasetId) throw new Error("sync_dataset_conflict");
    let insertedEvents = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const insertEvent = this.db.prepare(`INSERT OR IGNORE INTO usage_events(
        event_id, dataset_id, device_id, device_epoch, sequence, occurred_at_utc,
        provider_id, provider_name_snapshot, client_id, client_name_snapshot, model,
        endpoint, method, thinking_level, stream, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, total_tokens, latency_ms, ttft_ms,
        http_status, success, usage_available, error_summary, sync_state, created_at_utc
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', ?)`);
      for (const record of events) {
        if (String(record.datasetId || datasetId) !== this.identity.datasetId) throw new Error("sync_dataset_conflict");
        const eventId = String(record.eventId || record.id || "");
        const deviceId = String(record.deviceId || "");
        const deviceEpoch = boundedInteger(record.deviceEpoch);
        const sequence = boundedInteger(record.sequence);
        if (!eventId || !/^dev_[0-9a-z_-]{8,}$/i.test(deviceId) || deviceEpoch < 1 || sequence < 1) throw new Error("sync_invalid_usage_event");
        const at = String(record.at || record.occurredAtUtc || "");
        if (!Number.isFinite(new Date(at).valueOf())) throw new Error("sync_invalid_usage_event");
        const status = boundedInteger(record.status);
        const result = insertEvent.run(
          eventId, this.identity.datasetId, deviceId, deviceEpoch, sequence, at,
          String(record.providerId || "").slice(0, 200), String(record.providerName || "").slice(0, 200), String(record.clientKeyId || "").slice(0, 200),
          String(record.clientKeyName || "").slice(0, 200), String(record.model || "").slice(0, 300), String(record.endpoint || "").slice(0, 200),
          String(record.method || "POST").slice(0, 12), String(record.reasoningLevel || "high").slice(0, 12), record.stream ? 1 : 0,
          boundedInteger(record.inputTokens), boundedInteger(record.outputTokens), boundedInteger(record.cacheReadTokens), boundedInteger(record.cacheWriteTokens),
          boundedInteger(record.totalTokens), boundedInteger(record.durationMs), boundedInteger(record.ttftMs), status,
          status >= 200 && status < 400 ? 1 : 0, record.usageAvailable === false ? 0 : 1, String(record.error || "").slice(0, 300), at,
        );
        insertedEvents += Number(result.changes || 0);
      }

      const mergeCounter = this.db.prepare(`INSERT INTO usage_counters(
        dataset_id, device_id, device_epoch, last_sequence, requests, errors,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens,
        first_request_at, last_request_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(dataset_id, device_id, device_epoch) DO UPDATE SET
        last_sequence=MAX(usage_counters.last_sequence, excluded.last_sequence),
        requests=MAX(usage_counters.requests, excluded.requests),
        errors=MAX(usage_counters.errors, excluded.errors),
        input_tokens=MAX(usage_counters.input_tokens, excluded.input_tokens),
        output_tokens=MAX(usage_counters.output_tokens, excluded.output_tokens),
        cache_read_tokens=MAX(usage_counters.cache_read_tokens, excluded.cache_read_tokens),
        cache_write_tokens=MAX(usage_counters.cache_write_tokens, excluded.cache_write_tokens),
        total_tokens=MAX(usage_counters.total_tokens, excluded.total_tokens),
        first_request_at=CASE
          WHEN usage_counters.first_request_at IS NULL OR usage_counters.first_request_at='' THEN excluded.first_request_at
          WHEN excluded.first_request_at IS NULL OR excluded.first_request_at='' THEN usage_counters.first_request_at
          ELSE MIN(usage_counters.first_request_at, excluded.first_request_at) END,
        last_request_at=MAX(COALESCE(usage_counters.last_request_at,''), COALESCE(excluded.last_request_at,''))`);
      for (const counter of counters) {
        const counterDataset = String(counter.dataset_id || counter.datasetId || datasetId);
        if (counterDataset !== this.identity.datasetId) throw new Error("sync_dataset_conflict");
        const deviceId = String(counter.device_id || counter.deviceId || "");
        const deviceEpoch = boundedInteger(counter.device_epoch ?? counter.deviceEpoch);
        if (!deviceId || deviceEpoch < 1) throw new Error("sync_invalid_counter");
        mergeCounter.run(
          this.identity.datasetId, deviceId, deviceEpoch,
          boundedInteger(counter.last_sequence ?? counter.lastSequence), boundedInteger(counter.requests), boundedInteger(counter.errors),
          boundedInteger(counter.input_tokens ?? counter.inputTokens), boundedInteger(counter.output_tokens ?? counter.outputTokens),
          boundedInteger(counter.cache_read_tokens ?? counter.cacheReadTokens), boundedInteger(counter.cache_write_tokens ?? counter.cacheWriteTokens),
          boundedInteger(counter.total_tokens ?? counter.totalTokens), String(counter.first_request_at ?? counter.firstRequestAt ?? ""),
          String(counter.last_request_at ?? counter.lastRequestAt ?? ""),
        );
      }

      const mergeTombstone = this.db.prepare(`INSERT INTO tombstones(
        object_type, object_id, deleted_revision, deleted_by_device, deleted_at_generation, deleted_at_utc
      ) VALUES(?, ?, ?, ?, ?, ?) ON CONFLICT(object_type, object_id) DO UPDATE SET
        deleted_revision=CASE WHEN excluded.deleted_at_utc >= tombstones.deleted_at_utc THEN excluded.deleted_revision ELSE tombstones.deleted_revision END,
        deleted_by_device=CASE WHEN excluded.deleted_at_utc >= tombstones.deleted_at_utc THEN excluded.deleted_by_device ELSE tombstones.deleted_by_device END,
        deleted_at_generation=MAX(tombstones.deleted_at_generation, excluded.deleted_at_generation),
        deleted_at_utc=MAX(tombstones.deleted_at_utc, excluded.deleted_at_utc)`);
      for (const tombstone of tombstones) {
        const objectType = String(tombstone.object_type || tombstone.objectType || "");
        const objectId = String(tombstone.object_id || tombstone.objectId || "");
        if (!objectType || !objectId) throw new Error("sync_invalid_tombstone");
        mergeTombstone.run(
          objectType, objectId, String(tombstone.deleted_revision || tombstone.deletedRevision || ""),
          String(tombstone.deleted_by_device || tombstone.deletedByDevice || ""),
          boundedInteger(tombstone.deleted_at_generation ?? tombstone.deletedAtGeneration),
          String(tombstone.deleted_at_utc || tombstone.deletedAtUtc || new Date(0).toISOString()),
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.prune();
    return { insertedEvents, counters: counters.length, tombstones: tombstones.length };
  }

  markEventsSynced(eventIds) {
    const ids = [...new Set((eventIds || []).map(String).filter(Boolean))];
    if (!ids.length) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const eventStatement = this.db.prepare("UPDATE usage_events SET sync_state='synced' WHERE event_id=?");
      const outboxStatement = this.db.prepare("UPDATE outbox SET state='synced' WHERE object_type='usage-event' AND object_id=?");
      for (const id of ids) { eventStatement.run(id); outboxStatement.run(id); }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    this.prune();
  }

  recordSyncRun({ syncId, provider = "github", state, generation = 0, startedAtUtc, finishedAtUtc = "", errorCode = "", summary = "" }) {
    this.db.prepare(`INSERT INTO sync_runs(sync_id, provider, state, generation, started_at_utc, finished_at_utc, error_code, summary)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(sync_id) DO UPDATE SET
      state=excluded.state, generation=excluded.generation, finished_at_utc=excluded.finished_at_utc,
      error_code=excluded.error_code, summary=excluded.summary`).run(
        String(syncId), String(provider), String(state), boundedInteger(generation), String(startedAtUtc || new Date().toISOString()),
        String(finishedAtUtc), String(errorCode).slice(0, 120), String(summary).slice(0, 1000),
      );
  }

  status() {
    return {
      ...this.identity,
      storage: "sqlite-wal",
      pendingCount: Number(this.db.prepare("SELECT COUNT(*) count FROM outbox WHERE state='pending'").get().count || 0),
      eventCount: Number(this.db.prepare("SELECT COUNT(*) count FROM usage_events").get().count || 0),
      databaseFile: this.databaseFile,
    };
  }

  canAdoptDataset() {
    const status = this.status();
    const counter = this.db.prepare("SELECT COALESCE(SUM(requests),0) requests FROM usage_counters").get();
    const tombstones = this.db.prepare("SELECT COUNT(*) count FROM tombstones").get();
    return status.eventCount === 0
      && status.pendingCount === 0
      && Number(counter.requests || 0) === 0
      && Number(tombstones.count || 0) === 0;
  }

  adoptDataset(datasetId) {
    const next = String(datasetId || "");
    if (!/^ds_[0-9a-f-]{36}$/i.test(next)) throw new Error("sync_invalid_dataset");
    if (next === this.identity.datasetId) return { ...this.identity };
    if (!this.canAdoptDataset()) throw new Error("sync_dataset_not_pristine");
    this.identity = { ...this.identity, datasetId: next, updatedAtUtc: new Date().toISOString() };
    writeJsonAtomic(this.deviceFile, this.identity);
    return { ...this.identity };
  }

  checkpoint() { try { this.db.exec("PRAGMA wal_checkpoint(FULL)"); } catch { /* best effort */ } }

  close() {
    if (!this.db) return;
    this.checkpoint();
    this.db.close();
    this.db = null;
  }
}

export const usageDetailCacheMaxBytes = DETAIL_CACHE_MAX_BYTES;
export const usageDetailCacheTargetBytes = DETAIL_CACHE_TARGET_BYTES;
