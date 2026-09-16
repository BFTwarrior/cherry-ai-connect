/** 中文：Fake Provider 验证 manifest-last、上传中断恢复和多设备收敛。 English: Sync engine fault tests. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { UsageLedger } from "../gateway/usage-ledger.mjs";
import { SyncEngine, readLatestManifest } from "../sync/sync-engine.mjs";
import { isManifestAssetName, manifestName, syncTimestamp } from "../sync/sync-common.mjs";
import { LocalVaultStore } from "../sync/local-vault-store.mjs";
import { SyncManager } from "../sync/sync-manager.mjs";

const datasetId = "ds_01995f2c-7f5a-7b21-a8d2-6dfc50f4a901";

class FakeProvider {
  constructor() { this.assets = new Map(); this.operations = []; this.failManifestOnce = false; this.nextId = 1; }
  async ensureReady() {
    this.operations.push("ready");
    return { owner: "test-user", repository: "sync-repo", account: { id: "1", login: "test-user", avatarUrl: "" }, private: true, releaseTag: "cherry-sync" };
  }
  async listAssets() { return [...this.assets.values()].map((item) => ({ id: item.id, name: item.name, size: item.bytes.length, createdAt: item.createdAt })); }
  async downloadAsset(asset) {
    const item = this.assets.get(asset.name);
    if (!item) throw new Error("404 asset");
    this.operations.push(`download:${item.name}`);
    return Buffer.from(item.bytes);
  }
  async uploadAsset(name, bytes) {
    this.operations.push(`upload:${name}`);
    if (this.failManifestOnce && name.startsWith("manifest-")) { this.failManifestOnce = false; throw new Error("simulated_manifest_disconnect"); }
    if (this.assets.has(name)) throw new Error("422 immutable duplicate");
    this.assets.set(name, { id: this.nextId++, name, bytes: Buffer.from(bytes), createdAt: new Date().toISOString() });
  }
  async deleteAsset(asset) { this.operations.push(`delete:${asset.name}`); this.assets.delete(asset.name); }
}

function ledgerAt(root, suffix) {
  const directory = path.join(root, suffix);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "device.json"), JSON.stringify({ datasetId, deviceId: `dev_01995f2c-7f5a-7b21-a8d2-6dfc50f4${suffix}`, deviceEpoch: 1 }));
  return new UsageLedger(directory);
}

function append(ledger, id, tokens) {
  ledger.append({ eventId: id, at: new Date().toISOString(), providerId: "route-a", providerName: "Route A", clientKeyId: "client-a", clientKeyName: "Client A", model: "gpt-test", endpoint: "/v1/chat/completions", method: "POST", reasoningLevel: "high", status: 200, inputTokens: tokens, totalTokens: tokens });
}

function sourceFor(ledger) {
  return {
    getSyncSnapshot: () => ({
      identity: { ...ledger.identity },
      publicConfig: { schemaVersion: 1, configRevision: { counter: 1, deviceId: "dev_config" }, forcedLevel: "high", defaultProvider: "route-a", providers: [], clientKeyMetadata: [] },
      secureConfig: { schemaVersion: 1, datasetId, providers: [] },
      events: ledger.pendingUsage(),
      counters: ledger.counters(),
      tombstones: ledger.tombstones(),
      ledger: ledger.status(),
    }),
    mergeRemoteUsage: (payload) => ledger.mergeRemote(payload),
    markSyncEvents: (ids) => ledger.markEventsSynced(ids),
    recordSyncRun: (payload) => ledger.recordSyncRun(payload),
  };
}

const protect = (value) => Buffer.from(`protected:${value}`, "utf8");
const unprotect = (value) => Buffer.from(value).toString("utf8").replace(/^protected:/, "");

function clone(value) { return JSON.parse(JSON.stringify(value)); }

class ConfigSource {
  constructor({ dataset, deviceId, revision = 0, provider = null, pristine = false }) {
    this.identity = { datasetId: dataset, deviceId, deviceEpoch: 1 };
    this.pristine = pristine;
    this.publicConfig = {
      schemaVersion: 1,
      configRevision: { counter: revision, deviceId },
      forcedLevel: "high",
      defaultProvider: provider?.id || "",
      providers: provider ? [{ id: provider.id, name: provider.name, enabled: true, models: ["gpt-test"] }] : [],
      clientKeyMetadata: [],
    };
    this.secureConfig = {
      schemaVersion: 1,
      datasetId: dataset,
      providers: provider ? [{ id: provider.id, baseUrl: provider.baseUrl, apiKey: provider.apiKey }] : [],
    };
    this.events = [];
    this.merged = [];
    this.replacements = 0;
  }

  getSyncSnapshot() {
    return {
      identity: clone(this.identity),
      publicConfig: clone(this.publicConfig),
      secureConfig: clone(this.secureConfig),
      events: clone(this.events),
      counters: [],
      tombstones: [],
      ledger: { pendingCount: this.events.length },
    };
  }

  mergeRemoteUsage(payload) { this.merged.push(clone(payload)); }
  markSyncEvents(ids) { this.events = this.events.filter((item) => !ids.includes(item.eventId)); }
  recordSyncRun() {}
  canAdoptSyncDataset() { return this.pristine; }
  adoptSyncDataset(nextDatasetId) {
    if (!this.pristine) throw new Error("sync_dataset_not_pristine");
    this.identity.datasetId = nextDatasetId;
    this.secureConfig.datasetId = nextDatasetId;
  }
  replaceConfigFromSync(publicConfig, secureConfig) {
    this.publicConfig = clone(publicConfig);
    this.secureConfig = clone(secureConfig);
    this.pristine = false;
    this.replacements += 1;
  }
  bumpConfigRevisionForSync() {
    this.publicConfig.configRevision = {
      counter: Number(this.publicConfig.configRevision.counter || 0) + 1,
      deviceId: this.identity.deviceId,
    };
    return clone(this.publicConfig.configRevision);
  }
}

function vaultAt(root, name) {
  return new LocalVaultStore({ dataDir: path.join(root, name), protect, unprotect });
}

test("manifest is uploaded last and an interrupted candidate never clears the outbox", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cherry-sync-test-"));
  const ledger = ledgerAt(root, "aaaa");
  const provider = new FakeProvider();
  try {
    append(ledger, "evt_a_1", 10);
    provider.failManifestOnce = true;
    const first = new SyncEngine({ provider, source: sourceFor(ledger) });
    await assert.rejects(() => first.sync("fault-test"), /simulated_manifest_disconnect/);
    assert.equal(ledger.pendingUsage().length, 1);
    assert.equal((await readLatestManifest(provider, datasetId)), null);

    const second = new SyncEngine({ provider, source: sourceFor(ledger) });
    await second.sync("retry");
    assert.equal(ledger.pendingUsage().length, 0);
    assert.match(provider.operations.at(-1), /download:manifest-/);
    const latest = await readLatestManifest(provider, datasetId);
    assert.equal(latest.manifest.generation, 1);
    assert.equal(latest.manifest.state, "committed");
    assert.ok([...provider.assets.keys()].some((name) => /^manifest-\d{8}-\d{6}-\d{3}-ssync_[0-9a-f-]{36}\.json$/.test(name)));
  } finally {
    ledger.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sync asset names use UTC+8 timestamps while legacy manifest names stay readable", () => {
  const date = new Date("2026-09-17T06:30:25.123Z");
  const syncId = "sync_00000000-0000-0000-0000-000000000000";
  assert.equal(syncTimestamp(date), "20260917-143025-123");
  assert.equal(manifestName(syncId, date), "manifest-20260917-143025-123-ssync_00000000-0000-0000-0000-000000000000.json");
  assert.equal(isManifestAssetName("manifest-g000042-ssync_00000000-0000-0000-0000-000000000000.json"), true);
  assert.equal(isManifestAssetName(manifestName(syncId, date)), true);
});

test("two devices converge and repeated pulls do not duplicate lifetime totals", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cherry-sync-multi-"));
  const a = ledgerAt(root, "aaaa");
  const b = ledgerAt(root, "bbbb");
  const provider = new FakeProvider();
  try {
    append(a, "evt_a_1", 100);
    await new SyncEngine({ provider, source: sourceFor(a) }).sync("device-a");
    append(b, "evt_b_1", 50);
    await new SyncEngine({ provider, source: sourceFor(b) }).sync("device-b");
    await new SyncEngine({ provider, source: sourceFor(a) }).sync("device-a-pull");
    const snapshotA = a.snapshot(new URL("http://local/usage?range=24h"));
    const snapshotB = b.snapshot(new URL("http://local/usage?range=24h"));
    assert.equal(snapshotA.lifetime.totalTokens, 150);
    assert.equal(snapshotB.lifetime.totalTokens, 150);
    assert.equal(snapshotA.records.length, 2);
    assert.equal(snapshotB.records.length, 2);
  } finally {
    a.close(); b.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a pristine installation adopts and decrypts the remote dataset before replacing configuration", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cherry-sync-restore-"));
  const remoteDataset = "ds_11995f2c-7f5a-7b21-a8d2-6dfc50f4a901";
  const localDataset = "ds_21995f2c-7f5a-7b21-a8d2-6dfc50f4a901";
  const providerConfig = { id: "route-a", name: "Cloud Route", baseUrl: "https://example.com", apiKey: "test-upstream-secret" };
  const provider = new FakeProvider();
  const sourceA = new ConfigSource({ dataset: remoteDataset, deviceId: "dev_remote", revision: 2, provider: providerConfig });
  const sourceB = new ConfigSource({ dataset: localDataset, deviceId: "dev_fresh", revision: 0, pristine: true });
  const vaultA = vaultAt(root, "vault-a");
  const vaultB = vaultAt(root, "vault-b");
  try {
    await vaultA.initialize({ datasetId: remoteDataset, secrets: sourceA.secureConfig, password: "restore-password", kdfOptions: { t: 1, m: 1024, p: 1 } });
    await new SyncEngine({ provider, source: sourceA, vault: vaultA }).sync("seed-cloud");
    await new SyncEngine({ provider, source: sourceB, vault: vaultB }).sync("restore", {
      adoptRemoteIfPristine: true,
      configPolicy: "remote",
      password: "restore-password",
    });
    assert.equal(sourceB.identity.datasetId, remoteDataset);
    assert.equal(sourceB.replacements, 1);
    assert.equal(sourceB.publicConfig.providers[0].name, "Cloud Route");
    assert.equal(sourceB.secureConfig.providers[0].apiKey, "test-upstream-secret");
    assert.equal(vaultB.status().unlocked, true);
    assert.equal((await readLatestManifest(provider, remoteDataset)).manifest.generation, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a wrong restore password never writes the remote vault or replaces local configuration", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cherry-sync-wrong-password-"));
  const remoteDataset = "ds_31995f2c-7f5a-7b21-a8d2-6dfc50f4a901";
  const localDataset = "ds_41995f2c-7f5a-7b21-a8d2-6dfc50f4a901";
  const providerConfig = { id: "route-a", name: "Cloud Route", baseUrl: "https://example.com", apiKey: "test-upstream-secret" };
  const provider = new FakeProvider();
  const sourceA = new ConfigSource({ dataset: remoteDataset, deviceId: "dev_remote", revision: 2, provider: providerConfig });
  const sourceB = new ConfigSource({ dataset: localDataset, deviceId: "dev_fresh", revision: 0, pristine: true });
  const vaultA = vaultAt(root, "vault-a");
  const vaultB = vaultAt(root, "vault-b");
  try {
    await vaultA.initialize({ datasetId: remoteDataset, secrets: sourceA.secureConfig, password: "restore-password", kdfOptions: { t: 1, m: 1024, p: 1 } });
    await new SyncEngine({ provider, source: sourceA, vault: vaultA }).sync("seed-cloud");
    await assert.rejects(() => new SyncEngine({ provider, source: sourceB, vault: vaultB }).sync("restore", {
      adoptRemoteIfPristine: true,
      configPolicy: "remote",
      password: "incorrect-password",
    }), /vault_wrong_credential/);
    assert.equal(sourceB.replacements, 0);
    assert.equal(sourceB.publicConfig.providers.length, 0);
    assert.equal(vaultB.status().initialized, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("equal-counter edits from different devices stop for an explicit conflict choice", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cherry-sync-conflict-"));
  const sharedDataset = "ds_51995f2c-7f5a-7b21-a8d2-6dfc50f4a901";
  const provider = new FakeProvider();
  const remoteConfig = { id: "route-a", name: "Remote Route", baseUrl: "https://remote.example.com", apiKey: "remote-secret" };
  const localConfig = { id: "route-b", name: "Local Route", baseUrl: "https://local.example.com", apiKey: "local-secret" };
  const sourceA = new ConfigSource({ dataset: sharedDataset, deviceId: "dev_remote", revision: 1, provider: remoteConfig });
  const sourceB = new ConfigSource({ dataset: sharedDataset, deviceId: "dev_local", revision: 1, provider: localConfig });
  const vaultA = vaultAt(root, "vault-a");
  const vaultB = vaultAt(root, "vault-b");
  try {
    await vaultA.initialize({ datasetId: sharedDataset, secrets: sourceA.secureConfig, password: "shared-password", kdfOptions: { t: 1, m: 1024, p: 1 } });
    await vaultB.initialize({ datasetId: sharedDataset, secrets: sourceB.secureConfig, password: "local-password", kdfOptions: { t: 1, m: 1024, p: 1 } });
    await new SyncEngine({ provider, source: sourceA, vault: vaultA }).sync("seed-cloud");
    const manifestsBefore = [...provider.assets.keys()].filter((name) => name.startsWith("manifest-")).length;
    await assert.rejects(() => new SyncEngine({ provider, source: sourceB, vault: vaultB }).sync("conflict"), /sync_config_conflict/);
    const manifestsAfter = [...provider.assets.keys()].filter((name) => name.startsWith("manifest-")).length;
    assert.equal(manifestsAfter, manifestsBefore);
    assert.equal(sourceB.publicConfig.providers[0].name, "Local Route");

    await new SyncEngine({ provider, source: sourceB, vault: vaultB }).sync("keep-local", { configPolicy: "local" });
    const latest = await readLatestManifest(provider, sharedDataset);
    assert.equal(latest.manifest.configRevision.counter, 2);
    assert.equal(latest.manifest.configRevision.deviceId, "dev_local");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("sync manager protects a legacy local copy before offering keep-local conflict resolution", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cherry-sync-manager-conflict-"));
  const sharedDataset = "ds_61995f2c-7f5a-7b21-a8d2-6dfc50f4a901";
  const provider = new FakeProvider();
  const remoteConfig = { id: "route-a", name: "Remote Route", baseUrl: "https://remote.example.com", apiKey: "remote-secret" };
  const localConfig = { id: "route-b", name: "Local Route", baseUrl: "https://local.example.com", apiKey: "local-secret" };
  const remoteSource = new ConfigSource({ dataset: sharedDataset, deviceId: "dev_remote", revision: 1, provider: remoteConfig });
  const localSource = new ConfigSource({ dataset: sharedDataset, deviceId: "dev_local", revision: 1, provider: localConfig });
  const remoteVault = vaultAt(root, "remote-vault");
  let manager;
  try {
    await remoteVault.initialize({ datasetId: sharedDataset, secrets: remoteSource.secureConfig, password: "remote-password", kdfOptions: { t: 1, m: 1024, p: 1 } });
    await new SyncEngine({ provider, source: remoteSource, vault: remoteVault }).sync("seed-cloud");
    manager = new SyncManager({
      dataDir: path.join(root, "manager"),
      source: localSource,
      protect,
      unprotect,
      providerFactory: () => provider,
    });
    const connected = await manager.connect({ token: "test-token", repository: "sync-repo", password: "local-password" });
    assert.equal(connected.status.state, "CONFLICT");
    assert.match(connected.recoveryCode, /^CGRC-/);
    assert.equal(connected.status.vault.initialized, true);
    const resolved = await manager.resolveConflict({ choice: "local", password: "local-password" });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.status.state, "IDLE");
    assert.equal((await readLatestManifest(provider, sharedDataset)).manifest.configRevision.deviceId, "dev_local");
  } finally {
    if (manager?.timer) clearTimeout(manager.timer);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
