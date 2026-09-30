/**
 * 中文：用真实 Gateway 自动合并 API 与内存 Provider 覆盖公开客户端 metadata、顺序、
 * 本机 secret 保留和加密中转站配置的多设备同步。
 * English: Exercise real Gateway automatic-merge APIs with an in-memory provider, covering
 * public client metadata, ordering, local secret retention, and encrypted multi-device routes.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { UsageLedger } from "../gateway/usage-ledger.mjs";
import { fileURLToPath } from "node:url";
import { LocalVaultStore } from "../sync/local-vault-store.mjs";
import { SyncManager } from "../sync/sync-manager.mjs";
import { SyncEngine, readLatestManifest } from "../sync/sync-engine.mjs";
import { parseCompressedJson } from "../sync/sync-common.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = path.join(projectRoot, ".test-runtime");
const datasetId = "ds_71995f2c-7f5a-7b21-a8d2-6dfc50f4a901";
const protect = (value) => Buffer.from(`test-protected:${value}`, "utf8");
const unprotect = (value) => Buffer.from(value).toString("utf8").replace(/^test-protected:/, "");

class FakeProvider {
  constructor() { this.assets = new Map(); this.nextId = 1; this.operations = []; }
  async ensureReady() { return { owner: "test", repository: "automatic-sync", private: true, account: { id: "test", login: "test" }, releaseTag: "cherry-sync" }; }
  async listAssets() {
    return [...this.assets.values()].map((item) => ({ id: item.id, name: item.name, size: item.bytes.length, createdAt: item.createdAt }));
  }
  async downloadAsset(asset) {
    const item = this.assets.get(asset.name);
    if (!item) throw new Error("404 asset");
    this.operations.push(`download:${item.name}`);
    return Buffer.from(item.bytes);
  }
  async uploadAsset(name, bytes, type = "") {
    if (this.onUpload) await this.onUpload(type);
    if (type === "manifest" && this.manifestGate) await this.manifestGate();
    if (this.assets.has(name)) throw new Error("422 immutable duplicate");
    const item = { id: this.nextId++, name, type, bytes: Buffer.from(bytes), createdAt: new Date().toISOString() };
    this.assets.set(name, item);
    this.operations.push(`upload:${type}:${name}`);
    return { id: item.id, name, size: item.bytes.length, createdAt: item.createdAt };
  }
  async deleteAsset(asset) { this.assets.delete(asset.name); }
}

async function makeGateway(label) {
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(runtimeRoot, `${label}-`));
  const deviceId = `dev_${label.replace(/[^a-z0-9]/gi, "").toLowerCase().padEnd(8, "0").slice(0, 8)}-${Math.random().toString(16).slice(2, 10)}`;
  fs.writeFileSync(path.join(dataDir, "device.json"), JSON.stringify({ datasetId, deviceId, deviceEpoch: 1 }), "utf8");
  const previous = {
    dataDir: process.env.GATEWAY_DATA_DIR,
    embedded: process.env.GATEWAY_EMBEDDED,
    port: process.env.GATEWAY_PORT,
  };
  process.env.GATEWAY_DATA_DIR = dataDir;
  process.env.GATEWAY_EMBEDDED = "1";
  process.env.GATEWAY_PORT = "0";
  let gateway;
  try {
    gateway = await import(`../gateway/gateway.mjs?automaticSync=${Date.now()}-${Math.random()}`);
  } finally {
    restoreEnv("GATEWAY_DATA_DIR", previous.dataDir);
    restoreEnv("GATEWAY_EMBEDDED", previous.embedded);
    restoreEnv("GATEWAY_PORT", previous.port);
  }
  await gateway.startGateway({ port: 0 });
  const port = gateway.server.address().port;
  const api = async (pathname, options = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, options);
    const value = await response.json().catch(() => ({}));
    return { response, value };
  };
  return { gateway, dataDir, api, vault: new LocalVaultStore({ dataDir: path.join(dataDir, "vault-store"), protect, unprotect }) };
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function dispose(...fixtures) {
  for (const fixture of fixtures.reverse()) {
    if (!fixture) continue;
    try { await fixture.gateway.stopGateway(); } finally { fs.rmSync(fixture.dataDir, { recursive: true, force: true }); }
  }
}

async function postJson(fixture, pathname, value) {
  const result = await fixture.api(pathname, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
  assert.equal(result.response.ok, true, `${pathname}: ${JSON.stringify(result.value)}`);
  return result.value;
}

async function createRouteAndKey(fixture, routeId, { name = routeId, apiKey = `synthetic-upstream-${routeId}` } = {}) {
  const route = await postJson(fixture, "/admin/api/providers", {
    id: routeId, name, baseUrl: `https://${routeId}.example.invalid/v1`, apiKey,
  });
  assert.ok(route.id || route.provider?.id || fixture.gateway.getSyncSnapshot().secureConfig.providers.some((item) => item.id === routeId));
  const created = await postJson(fixture, "/admin/api/client-keys", { providerId: routeId, reasoningLevel: "high", nameCustomized: false });
  return { id: created.id, secret: fixture.gateway.getClientKeyImportDetails(created.id).apiKey, apiKey };
}

async function initializeVault(fixture, password) {
  await fixture.vault.initialize({
    datasetId,
    secrets: fixture.gateway.getSyncSnapshot().secureConfig,
    password,
    kdfOptions: { t: 1, m: 1024, p: 1 },
  });
}

function engine(fixture, provider, vault = null) {
  return new SyncEngine({ provider, source: fixture.gateway, vault });
}

test("GitHub-only sync merges client metadata and order while retaining per-device secrets", async () => {
  const a = await makeGateway("metadata-a");
  const b = await makeGateway("metadata-b");
  const provider = new FakeProvider();
  try {
    const keyA = await createRouteAndKey(a, "route-meta");
    const second = await postJson(a, "/admin/api/client-keys", { providerId: "route-meta", reasoningLevel: "medium", name: "Second key", nameCustomized: true });
    const keyA2 = { id: second.id, secret: a.gateway.getClientKeyImportDetails(second.id).apiKey };
    await postJson(a, "/admin/api/client-keys/order", { ids: [keyA2.id, keyA.id] });
    const originalASecrets = new Map([[keyA.id, keyA.secret], [keyA2.id, keyA2.secret]]);

    await engine(a, provider).sync("metadata-seed", { syncUpstream: false });
    await engine(b, provider).sync("metadata-pull", { syncUpstream: false });
    const bSnapshot = b.gateway.getClientMetadataSnapshot();
    assert.deepEqual(bSnapshot.clientKeyOrder.ids, [keyA2.id, keyA.id]);
    for (const id of [keyA.id, keyA2.id]) {
      const localSecret = b.gateway.getClientKeyImportDetails(id).apiKey;
      assert.match(localSecret, /^cg_[A-Za-z0-9_-]{20,}$/);
      assert.notEqual(localSecret, originalASecrets.get(id), "a new key ID gets a device-local secret");
    }

    const keyB = { id: (await postJson(b, "/admin/api/client-keys", { providerId: "route-meta", reasoningLevel: "low", name: "B local", nameCustomized: true })).id };
    keyB.secret = b.gateway.getClientKeyImportDetails(keyB.id).apiKey;
    await postJson(b, "/admin/api/client-keys/order", { ids: [keyB.id, keyA2.id, keyA.id] });
    await engine(b, provider).sync("metadata-order-push", { syncUpstream: false });
    await engine(a, provider).sync("metadata-order-pull", { syncUpstream: false });

    assert.deepEqual(a.gateway.getClientMetadataSnapshot().clientKeyOrder.ids, [keyB.id, keyA2.id, keyA.id]);
    assert.equal(a.gateway.getClientKeyImportDetails(keyA.id).apiKey, originalASecrets.get(keyA.id), "an existing ID must never rotate its local secret");
    assert.equal(a.gateway.getClientKeyImportDetails(keyA2.id).apiKey, originalASecrets.get(keyA2.id));
    assert.notEqual(a.gateway.getClientKeyImportDetails(keyB.id).apiKey, keyB.secret, "the other device creates its own secret for a newly received ID");

    const publicAssets = [...provider.assets.values()].filter((item) => item.type === "client-metadata");
    assert.ok(publicAssets.length >= 2, "metadata must have an asset independent from the vault");
    for (const item of publicAssets) {
      const decoded = parseCompressedJson(item.bytes);
      const serialized = JSON.stringify(decoded);
      for (const secret of [...originalASecrets.values(), keyB.secret, a.gateway.getClientKeyImportDetails(keyB.id).apiKey]) assert.equal(serialized.includes(secret), false);
      assert.equal(/"(?:hash|keyEnc|apiKey|baseUrl)"\s*:/.test(serialized), false, "public metadata must exclude hashes, local ciphertext, upstream keys, and URLs");
    }
    assert.equal([...provider.assets.values()].some((item) => item.name.includes("vault-")), false, "GitHub-only metadata sync must not upload a vault");
  } finally { await dispose(a, b); }
});

test("automatic upstream sync unions two devices and propagates the latest edit without configPolicy", async () => {
  const a = await makeGateway("vault-a");
  const b = await makeGateway("vault-b");
  const provider = new FakeProvider();
  try {
    const keyA = await createRouteAndKey(a, "route-a");
    await initializeVault(a, "shared-test-vault-password");
    await engine(a, provider, a.vault).sync("vault-seed");

    const keyB = await createRouteAndKey(b, "route-b");
    await initializeVault(b, "local-test-vault-password");
    const pulled = await engine(b, provider, b.vault).sync("auto-merge-first-device", { password: "shared-test-vault-password" });
    assert.equal(pulled.state, "IDLE", JSON.stringify(pulled));
    assert.deepEqual(new Set(b.gateway.getSyncSnapshot().publicConfig.providers.map((item) => item.id)), new Set(["route-a", "route-b"]));
    assert.equal(b.gateway.getClientKeyImportDetails(keyA.id).apiKey === keyA.secret, false, "newly received metadata must create a local key secret");

    await engine(b, provider, b.vault).sync("upload-union", { password: "shared-test-vault-password" });
    const mergedOnA = await engine(a, provider, a.vault).sync("pull-union");
    assert.equal(mergedOnA.state, "IDLE", JSON.stringify(mergedOnA));
    assert.deepEqual(new Set(a.gateway.getSyncSnapshot().publicConfig.providers.map((item) => item.id)), new Set(["route-a", "route-b"]));
    assert.ok(a.gateway.getClientKeyImportDetails(keyB.id).apiKey);

    const edited = await a.api(`/admin/api/client-keys/${keyA.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ providerId: "route-a", name: "Latest cloud metadata", nameCustomized: true, reasoningLevel: "xhigh" }) });
    assert.equal(edited.response.ok, true);
    await postJson(a, "/admin/api/providers", { id: "route-a", name: "Updated route", baseUrl: "https://updated.example.invalid/v1", apiKey: "new-synthetic-upstream-secret" });
    await engine(a, provider, a.vault).sync("latest-edit-push");
    await engine(b, provider, b.vault).sync("latest-edit-pull", { password: "shared-test-vault-password" });
    const bKey = (await b.api("/admin/api/client-keys")).value.keys.find((item) => item.id === keyA.id);
    assert.equal(bKey.name, "Latest cloud metadata");
    assert.equal(bKey.reasoningLevel, "xhigh");
    assert.equal(b.gateway.getSyncSnapshot().secureConfig.providers.find((item) => item.id === "route-a").apiKey, "new-synthetic-upstream-secret");
    assert.equal(b.gateway.getSyncSnapshot().secureConfig.providers.find((item) => item.id === "route-a").baseUrl, "https://updated.example.invalid/v1");
    const currentGeneration = (await readLatestManifest(provider, datasetId)).manifest.generation;
    const uploadCount = provider.operations.filter((item) => item.startsWith("upload:")).length;
    const noOp = await engine(b, provider, b.vault).sync("already-current");
    assert.equal(noOp.generation, currentGeneration, "unchanged sync must not create another generation");
    assert.equal(provider.operations.filter((item) => item.startsWith("upload:")).length, uploadCount);
  } finally { await dispose(a, b); }
});

test("metadata-only pending routes do not block authenticated upstream sync", async () => {
  const a = await makeGateway("pending-a");
  const b = await makeGateway("pending-b");
  const provider = new FakeProvider();
  try {
    await createRouteAndKey(a, "route-unlocked");
    await initializeVault(a, "shared-test-vault-password");
    await engine(a, provider, a.vault).sync("seed-unlocked-route");
    const pending = await createRouteAndKey(b, "route-pending");
    await engine(b, provider).sync("publish-public-reference", { syncUpstream: false });
    const result = await engine(a, provider, a.vault).sync("pull-pending-reference");
    assert.equal(result.state, "IDLE", JSON.stringify(result));
    const snapshot = a.gateway.getSyncSnapshot();
    assert.ok(snapshot.publicConfig.clientKeyMetadata.some((key) => key.id === pending.id));
    assert.ok(a.gateway.getClientKeyImportDetails(pending.id).apiKey);
    assert.deepEqual(snapshot.secureConfig.providers.map((route) => route.id), ["route-unlocked"]);
    const latest = await readLatestManifest(provider, datasetId);
    const configAsset = latest.manifest.files.find((file) => file.type === "config");
    const publishedConfig = parseCompressedJson(provider.assets.get(configAsset.assetName).bytes);
    assert.deepEqual(publishedConfig.providers.map((route) => route.id), ["route-unlocked"]);
    await engine(b, provider, b.vault).sync("unlock-pending-route", { password: "shared-test-vault-password" });
    await engine(a, provider, a.vault).sync("receive-now-unlocked-route");
    assert.equal(a.gateway.getSyncSnapshot().secureConfig.providers.find((route) => route.id === "route-pending").apiKey, pending.apiKey);
  } finally { await dispose(a, b); }
});

test("explicit tombstones beat stale metadata, omissions preserve keys, and tombstone-only sync commits", async () => {
  const a = await makeGateway("tombstone-a");
  const b = await makeGateway("tombstone-b");
  const provider = new FakeProvider();
  try {
    const deleted = await createRouteAndKey(a, "route-delete");
    const retained = await postJson(a, "/admin/api/client-keys", { providerId: "route-delete", reasoningLevel: "medium", name: "Retained key", nameCustomized: true });
    await engine(a, provider).sync("tombstone-seed", { syncUpstream: false });
    await engine(b, provider).sync("tombstone-pull", { syncUpstream: false });
    const before = b.gateway.getClientMetadataSnapshot();

    b.gateway.mergeClientMetadataFromSync({ ...before, clientKeyMetadata: [] }, { tombstones: [] });
    assert.deepEqual(
      new Set(b.gateway.getClientMetadataSnapshot().clientKeyMetadata.map((item) => item.id)),
      new Set([deleted.id, retained.id]),
      "metadata omission alone preserves local keys",
    );

    b.gateway.mergeClientMetadataFromSync({
      ...before,
      clientKeyMetadata: before.clientKeyMetadata,
    }, { tombstones: [{ object_type: "client-key", object_id: deleted.id }] });
    assert.deepEqual(b.gateway.getClientMetadataSnapshot().clientKeyMetadata.map((item) => item.id), [retained.id], "a stale copy cannot resurrect an explicitly deleted key");
    assert.ok(b.gateway.getClientKeyImportDetails(retained.id).apiKey, "other keys remain intact");

    // Seed a tombstone without changing usage, config revision, or vault revision. It must still
    // advance the manifest so another device observes the deletion marker.
    const generationBefore = (await readLatestManifest(provider, datasetId)).manifest.generation;
    b.gateway.mergeRemoteUsage({ datasetId, events: [], counters: [], tombstones: [{ object_type: "client-key", object_id: deleted.id, deleted_revision: "test-only" }] });
    await engine(b, provider).sync("tombstone-only", { syncUpstream: false });
    const latest = await readLatestManifest(provider, datasetId);
    assert.ok(latest.manifest.generation > generationBefore, "a tombstone-only change must produce a manifest generation");
    assert.ok(latest.manifest.tombstones.some((item) => item.object_id === deleted.id));
    await engine(a, provider).sync("tombstone-observed", { syncUpstream: false });
    assert.equal(a.gateway.getSyncSnapshot().publicConfig.clientKeyMetadata.some((item) => item.id === deleted.id), false);
    assert.equal(a.gateway.getSyncSnapshot().publicConfig.clientKeyMetadata.some((item) => item.id === retained.id), true, "omission alone does not delete unrelated metadata");
  } finally { await dispose(a, b); }
});

test("config persistence failure during deletion does not publish a tombstone", async () => {
  const fixture = await makeGateway("delete-write-failure");
  try {
    const key = await createRouteAndKey(fixture, "route-write-failure");
    const before = fixture.gateway.getSyncSnapshot();
    const writeFileSync = fs.writeFileSync;
    let injected = false;
    fs.writeFileSync = function (file, ...args) {
      const resolved = path.resolve(String(file));
      if (!injected && resolved.startsWith(path.resolve(fixture.dataDir)) && path.basename(resolved).startsWith("config.json.")) {
        injected = true;
        throw new Error("simulated_config_persistence_failure");
      }
      return writeFileSync.call(this, file, ...args);
    };
    let result;
    try { result = await fixture.api(`/admin/api/client-keys/${key.id}`, { method: "DELETE" }); }
    finally { fs.writeFileSync = writeFileSync; }

    assert.equal(injected, true, "the targeted config write must fail");
    assert.equal(result.response.ok, false);
    const after = fixture.gateway.getSyncSnapshot();
    assert.equal(after.tombstones.some((item) => (item.object_id || item.objectId) === key.id), false, "failed config persistence must not commit a SQLite or public tombstone");
    assert.equal(after.publicConfig.clientKeyMetadata.some((item) => item.id === key.id), true, "the last durable metadata remains active");
    assert.deepEqual(after.publicConfig.clientKeyOrder.ids, before.publicConfig.clientKeyOrder.ids);
  } finally { await dispose(fixture); }
});


test("durable deletion intent survives the config-to-ledger gap and replays after restart", async () => {
  const fixture = await makeGateway("delete-ledger-gap");
  try {
    const key = await createRouteAndKey(fixture, "route-ledger-gap");
    const original = UsageLedger.prototype.addTombstone;
    let result;
    try {
      UsageLedger.prototype.addTombstone = function () { throw new Error("simulated_ledger_commit_failure"); };
      result = await fixture.api(`/admin/api/client-keys/${key.id}`, { method: "DELETE" });
    } finally { UsageLedger.prototype.addTombstone = original; }
    assert.equal(result.response.ok, false);
    const after = fixture.gateway.getSyncSnapshot();
    assert.equal(after.publicConfig.clientKeyMetadata.some((item) => item.id === key.id), false);
    assert.ok(after.tombstones.some((item) => item.object_id === key.id), "durable config intent remains publishable even without the ledger write");
    await reopen(fixture);
    const db = new DatabaseSync(path.join(fixture.dataDir, "usage.db"), { readOnly: true });
    try { assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tombstones WHERE object_type = ? AND object_id = ?").get("client-key", key.id).count, 1); }
    finally { db.close(); }
    assert.equal(fixture.gateway.getSyncSnapshot().publicConfig.clientKeyMetadata.some((item) => item.id === key.id), false);
  } finally { await dispose(fixture); }
});

test("wrong vault credentials preserve cloud secrets while client metadata can still sync", async () => {
  const a = await makeGateway("password-a"), b = await makeGateway("password-b");
  const provider = new FakeProvider();
  try {
    const keyA = await createRouteAndKey(a, "protected-route");
    await initializeVault(a, "remote-vault-password");
    await engine(a, provider, a.vault).sync("seed-protected");
    const old = await readLatestManifest(provider, datasetId);
    const oldVault = old.manifest.files.find((item) => item.type === "vault");
    const local = await createRouteAndKey(b, "independent-route");
    await initializeVault(b, "independent-password");
    const result = await engine(b, provider, b.vault).sync("wrong-password", { password: "wrong-password" });
    assert.equal(result.state, "ERROR_RECOVERABLE");
    assert.equal(result.warning, "sync_vault_unavailable_usage_only");
    assert.ok(result.errorCode.startsWith("vault_"));
    assert.equal(b.gateway.getClientKeyImportDetails(local.id).apiKey, local.secret);
    assert.equal(b.gateway.getSyncSnapshot().secureConfig.providers.find((item) => item.id === "independent-route").apiKey, local.apiKey);
    assert.equal(b.gateway.getSyncSnapshot().secureConfig.providers.some((item) => item.id === "protected-route"), false);
    const latest = await readLatestManifest(provider, datasetId);
    assert.deepEqual(latest.manifest.files.find((item) => item.type === "vault"), oldVault, "password failure must retain the last valid cloud vault");
    assert.ok(b.gateway.getClientKeyImportDetails(keyA.id).apiKey);
    const unlocked = await engine(b, provider, b.vault).sync("correct-password", { password: "remote-vault-password" });
    assert.equal(unlocked.state, "IDLE");
    assert.equal(b.gateway.getSyncSnapshot().secureConfig.providers.find((item) => item.id === "protected-route").apiKey, keyA.apiKey);
  } finally { await dispose(a, b); }
});

test("concurrent committed branches converge without losing either device's newly created keys", async () => {
  const a = await makeGateway("race-a"), b = await makeGateway("race-b");
  const provider = new FakeProvider();
  try {
    await createRouteAndKey(a, "shared-route");
    await engine(a, provider).sync("seed", { syncUpstream: false });
    await engine(b, provider).sync("join", { syncUpstream: false });
    const keyA = await postJson(a, "/admin/api/client-keys", { providerId: "shared-route", name: "Offline A", nameCustomized: true });
    const keyB = await postJson(b, "/admin/api/client-keys", { providerId: "shared-route", name: "Offline B", nameCustomized: true });
    let arrivals = 0, release;
    const barrier = new Promise((resolve) => { release = resolve; });
    provider.manifestGate = async () => { if (++arrivals === 2) release(); await barrier; };
    await Promise.all([engine(a, provider).sync("race-a", { syncUpstream: false }), engine(b, provider).sync("race-b", { syncUpstream: false })]);
    provider.manifestGate = null;
    assert.equal((await readLatestManifest(provider, datasetId)).siblings.length, 1, "fixture must create two competing committed generations");
    await engine(a, provider).sync("merge-race", { syncUpstream: false });
    await engine(b, provider).sync("receive-union", { syncUpstream: false });
    for (const fixture of [a, b]) {
      const ids = fixture.gateway.getClientMetadataSnapshot().clientKeyMetadata.map((item) => item.id);
      assert.ok(ids.includes(keyA.id)); assert.ok(ids.includes(keyB.id));
    }
    assert.deepEqual(a.gateway.getClientMetadataSnapshot(), b.gateway.getClientMetadataSnapshot());
  } finally { await dispose(a, b); }
});

test("stale reorder requests are rejected without changing secrets or cloud order", async () => {
  const fixture = await makeGateway("order-stale");
  try {
    const key = await createRouteAndKey(fixture, "order-route");
    const before = fixture.gateway.getClientMetadataSnapshot();
    for (const ids of [[], [key.id, key.id], ["unknown-id"]]) {
      const response = await fixture.api("/admin/api/client-keys/order", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }) });
      assert.equal(response.response.status, 400);
    }
    assert.deepEqual(fixture.gateway.getClientMetadataSnapshot(), before);
    assert.equal(fixture.gateway.getClientKeyImportDetails(key.id).apiKey, key.secret);
  } finally { await dispose(fixture); }
});


async function reopen(fixture) {
  await fixture.gateway.stopGateway();
  const saved = { data: process.env.GATEWAY_DATA_DIR, embedded: process.env.GATEWAY_EMBEDDED, port: process.env.GATEWAY_PORT };
  process.env.GATEWAY_DATA_DIR = fixture.dataDir; process.env.GATEWAY_EMBEDDED = "1"; process.env.GATEWAY_PORT = "0";
  try { fixture.gateway = await import(`../gateway/gateway.mjs?reload=${Date.now()}-${Math.random()}`); }
  finally { restoreEnv("GATEWAY_DATA_DIR", saved.data); restoreEnv("GATEWAY_EMBEDDED", saved.embedded); restoreEnv("GATEWAY_PORT", saved.port); }
  await fixture.gateway.startGateway();
  const port = fixture.gateway.server.address().port;
  fixture.api = async (pathname, options = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, options);
    return { response, value: await response.json() };
  };
}

test("migration preserves legacy key order and observes settings revisions before another local edit", async () => {
  const fixture = await makeGateway("legacy-order");
  try {
    const first = await createRouteAndKey(fixture, "legacy-route");
    const second = await postJson(fixture, "/admin/api/client-keys", { providerId: "legacy-route" });
    await fixture.gateway.stopGateway();
    const configPath = path.join(fixture.dataDir, "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.clientKeys = [config.clientKeys.find((item) => item.id === second.id), config.clientKeys.find((item) => item.id === first.id)];
    delete config.clientKeyOrder; delete config.syncClock;
    const futureRevision = Date.now() + 600000;
    config.settingsRevision = { counter: futureRevision, deviceId: "dev_future" };
    fs.writeFileSync(configPath, JSON.stringify(config));
    await reopen(fixture);
    assert.deepEqual(fixture.gateway.getClientMetadataSnapshot().clientKeyOrder.ids, [second.id, first.id]);
    assert.equal(fixture.gateway.getClientKeyImportDetails(first.id).apiKey, first.secret);
    await postJson(fixture, "/admin/api/settings", { forcedLevel: "high" });
    assert.ok(fixture.gateway.getSyncSnapshot().publicConfig.settingsRevision.counter > futureRevision, "later local settings must win even with a previously observed advanced clock");
  } finally { await dispose(fixture); }
});

test("an existing ID with an unreadable local secret fails protectively instead of rotating", async () => {
  const fixture = await makeGateway("damaged-secret");
  try {
    const key = await createRouteAndKey(fixture, "damaged-route");
    const remote = fixture.gateway.getClientMetadataSnapshot();
    await fixture.gateway.stopGateway();
    const configPath = path.join(fixture.dataDir, "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.clientKeys.find((item) => item.id === key.id).keyEnc = "invalid-ciphertext";
    fs.writeFileSync(configPath, JSON.stringify(config));
    await reopen(fixture);
    assert.throws(() => fixture.gateway.mergeClientMetadataFromSync(remote), /sync_client_key_secret_missing/);
    const persisted = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(persisted.clientKeys.find((item) => item.id === key.id).keyEnc, "invalid-ciphertext");
  } finally { await dispose(fixture); }
});

test("a late lower-priority sibling arriving during upload forces re-merge before the next generation", async () => {
  const a = await makeGateway("late-a"), b = await makeGateway("late-b");
  const provider = new FakeProvider(), fork = new FakeProvider();
  try {
    await createRouteAndKey(a, "late-route");
    await engine(a, provider).sync("seed", { syncUpstream: false });
    await engine(b, provider).sync("join", { syncUpstream: false });
    fork.assets = new Map(provider.assets); fork.nextId = provider.nextId;
    const bKey = await postJson(b, "/admin/api/client-keys", { providerId: "late-route", name: "Late branch key", nameCustomized: true });
    await engine(b, fork).sync("early-fork", { syncUpstream: false });
    await postJson(a, "/admin/api/client-keys", { providerId: "late-route", name: "Winner key", nameCustomized: true });
    await engine(a, provider).sync("later-winner", { syncUpstream: false });
    const winnerHash = (await readLatestManifest(provider, datasetId)).asset.name;
    await postJson(a, "/admin/api/client-keys", { providerId: "late-route", name: "Next key", nameCustomized: true });
    let injected = false;
    provider.onUpload = async (type) => {
      if (injected || type !== "client-metadata") return;
      injected = true;
      for (const [name, item] of fork.assets) if (!provider.assets.has(name)) provider.assets.set(name, { ...item, id: provider.nextId++ });
      assert.equal((await readLatestManifest(provider, datasetId)).asset.name, winnerHash, "late fork must not change the selected winner");
    };
    await engine(a, provider).sync("late-fork-during-upload", { syncUpstream: false });
    assert.equal(injected, true);
    assert.ok(a.gateway.getClientMetadataSnapshot().clientKeyMetadata.some((item) => item.id === bKey.id));
    const latest = await readLatestManifest(provider, datasetId);
    const descriptor = latest.manifest.files.find((item) => item.type === "client-metadata");
    const metadata = parseCompressedJson(provider.assets.get(descriptor.assetName).bytes);
    assert.ok(metadata.clientKeyMetadata.some((item) => item.id === bKey.id));
  } finally { await dispose(a, b); }
});

test("GitHub-only connection can enable encrypted sync later, and an existing second device joins automatically", async () => {
  const a = await makeGateway("manager-a"), b = await makeGateway("manager-b");
  const provider = new FakeProvider();
  const manager = (fixture) => new SyncManager({ dataDir: path.join(fixture.dataDir, "manager"), source: fixture.gateway, protect, unprotect, providerFactory: () => provider });
  const ma = manager(a), mb = manager(b);
  try {
    await createRouteAndKey(a, "manager-route-a");
    const connected = await ma.connect({ token: "synthetic-token", syncUpstream: false });
    assert.equal(connected.status.state, "IDLE");
    assert.equal(connected.status.syncUpstream, false);
    assert.equal(connected.status.vault.initialized, false);
    assert.equal(connected.status.intervalMinutes, 1);
    const encrypted = await ma.unlockVault({ password: "manager-vault-password" });
    assert.equal(encrypted.status.syncUpstream, true);
    assert.equal(encrypted.status.state, "IDLE");
    assert.ok(encrypted.recoveryCode.startsWith("CGRC-"));
    await createRouteAndKey(b, "manager-route-b");
    const joined = await mb.connect({ token: "synthetic-token", password: "manager-vault-password", syncUpstream: true });
    assert.equal(joined.status.state, "IDLE", JSON.stringify(joined.status));
    assert.deepEqual(new Set(b.gateway.getSyncSnapshot().secureConfig.providers.map((item) => item.id)), new Set(["manager-route-a", "manager-route-b"]));
  } finally { clearTimeout(ma.timer); clearTimeout(mb.timer); await dispose(a, b); }
});
