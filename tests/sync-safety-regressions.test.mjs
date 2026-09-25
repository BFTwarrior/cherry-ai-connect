/**
 * 中文：同步安全回归：vault/config 提交边界与本机 client Key 保留语义。
 * English: Sync-safety regressions for the vault/config commit boundary and local client-key retention.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { LocalVaultStore } from "../sync/local-vault-store.mjs";
import { SyncEngine } from "../sync/sync-engine.mjs";

const datasetId = "ds_81995f2c-7f5a-7b21-a8d2-6dfc50f4a901";
const protect = (value) => Buffer.from(`protected:${value}`, "utf8");
const unprotect = (value) => Buffer.from(value).toString("utf8").replace(/^protected:/, "");

class FakeProvider {
  constructor() { this.assets = new Map(); this.nextId = 1; }
  async ensureReady() { return { owner: "test", repository: "sync-safety", private: true, releaseTag: "cherry-sync" }; }
  async listAssets() {
    return [...this.assets.values()].map((item) => ({ id: item.id, name: item.name, size: item.bytes.length, createdAt: item.createdAt }));
  }
  async downloadAsset(asset) {
    const item = this.assets.get(asset.name);
    if (!item) throw new Error("404 asset");
    return Buffer.from(item.bytes);
  }
  async uploadAsset(name, bytes) {
    if (this.assets.has(name)) throw new Error("422 immutable duplicate");
    this.assets.set(name, { id: this.nextId++, name, bytes: Buffer.from(bytes), createdAt: new Date().toISOString() });
  }
  async deleteAsset(asset) { this.assets.delete(asset.name); }
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

class SyncSource {
  constructor({ revision, deviceId, publicConfig, secureConfig, validate = null, failReplace = false }) {
    this.identity = { datasetId, deviceId, deviceEpoch: 1 };
    this.publicConfig = clone(publicConfig);
    this.secureConfig = clone(secureConfig);
    this.events = [];
    this.validate = validate;
    this.failReplace = failReplace;
    this.validationCalls = 0;
    this.replaceCalls = 0;
    this.publicConfig.configRevision = { counter: revision, deviceId };
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
  mergeRemoteUsage() {}
  markSyncEvents() {}
  recordSyncRun() {}
  validateConfigFromSync(publicConfig, secureConfig, options) {
    this.validationCalls += 1;
    if (this.validate) return this.validate(publicConfig, secureConfig, options);
    return true;
  }
  replaceConfigFromSync(publicConfig, secureConfig) {
    this.replaceCalls += 1;
    if (this.failReplace) throw new Error("config_write_failed");
    this.publicConfig = clone(publicConfig);
    this.secureConfig = clone(secureConfig);
  }
}

function emptyConfig(revision, deviceId) {
  return {
    schemaVersion: 1,
    configRevision: { counter: revision, deviceId },
    forcedLevel: "high",
    defaultProvider: "",
    providers: [],
    clientKeyMetadata: [],
  };
}

test("invalid client-key metadata cannot commit a successfully decrypted remote vault", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cherry-sync-safety-"));
  const provider = new FakeProvider();
  const remoteVault = new LocalVaultStore({ dataDir: path.join(root, "remote"), protect, unprotect });
  const localVault = new LocalVaultStore({ dataDir: path.join(root, "local"), protect, unprotect });
  const remoteSecure = {
    schemaVersion: 1,
    datasetId,
    providers: [{ id: "route-a", baseUrl: "https://remote.example", apiKey: "upstream-secret" }],
  };
  const remotePublic = {
    ...emptyConfig(1, "dev_remote"),
    defaultProvider: "route-a",
    providers: [{ id: "route-a", name: "Remote", enabled: true, models: ["gpt-test"] }],
    // Deliberately invalid: the metadata points at a provider absent from the public config.
    clientKeyMetadata: [{ id: "bad-key", name: "Bad", providerId: "missing-route", enabled: true }],
  };
  const remoteSource = new SyncSource({ revision: 1, deviceId: "dev_remote", publicConfig: remotePublic, secureConfig: remoteSecure });
  const localSource = new SyncSource({
    revision: 0,
    deviceId: "dev_local",
    publicConfig: emptyConfig(0, "dev_local"),
    secureConfig: { schemaVersion: 1, datasetId, providers: [] },
    validate: (publicConfig) => {
      if (publicConfig.clientKeyMetadata[0]?.providerId === "missing-route") throw new Error("sync_invalid_client_metadata");
    },
  });
  try {
    await localVault.initialize({ datasetId, secrets: { schemaVersion: 1, datasetId, providers: [] }, password: "local-password", kdfOptions: { t: 1, m: 1024, p: 1 } });
    const localVaultBefore = fs.readFileSync(path.join(root, "local", "vault.enc"), "utf8");
    await remoteVault.initialize({ datasetId, secrets: remoteSecure, password: "shared-password", kdfOptions: { t: 1, m: 1024, p: 1 } });
    await new SyncEngine({ provider, source: remoteSource, vault: remoteVault }).sync("seed-cloud");
    await assert.rejects(() => new SyncEngine({ provider, source: localSource, vault: localVault }).sync("invalid-key-metadata", {
      configPolicy: "remote",
      password: "shared-password",
    }), /sync_invalid_client_metadata/);
    assert.equal(localSource.validationCalls, 1);
    assert.equal(localSource.replaceCalls, 0, "config replacement must not start after validation fails");
    assert.equal(fs.readFileSync(path.join(root, "local", "vault.enc"), "utf8"), localVaultBefore, "successful decryption must not overwrite the existing local vault");
    assert.equal(localVault.status().vaultRevision, 1);
    assert.equal(localSource.publicConfig.providers.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("vault, protected DEK, and config commit roll back together when config persistence fails", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cherry-sync-rollback-"));
  const localDir = path.join(root, "local");
  const remoteDir = path.join(root, "remote");
  const local = new LocalVaultStore({ dataDir: localDir, protect, unprotect });
  const remote = new LocalVaultStore({ dataDir: remoteDir, protect, unprotect });
  const localSecrets = { schemaVersion: 1, datasetId, providers: [{ id: "route-local", apiKey: "local-secret" }] };
  const remoteSecrets = { schemaVersion: 1, datasetId, providers: [{ id: "route-remote", apiKey: "remote-secret" }] };
  try {
    await local.initialize({ datasetId, secrets: localSecrets, password: "local-password", kdfOptions: { t: 1, m: 1024, p: 1 } });
    await remote.initialize({ datasetId, secrets: remoteSecrets, password: "remote-password", kdfOptions: { t: 1, m: 1024, p: 1 } });
    const vaultPath = path.join(localDir, "vault.enc");
    const dekPath = path.join(localDir, ".vault-local-key");
    const beforeVault = fs.readFileSync(vaultPath);
    const beforeDek = fs.readFileSync(dekPath);
    const remoteEnvelope = fs.readFileSync(path.join(remoteDir, "vault.enc"));

    await assert.rejects(() => local.importEnvelope(remoteEnvelope, {
      password: "remote-password",
      expectedDatasetId: datasetId,
      beforeCommit: () => true,
      commitConfig: () => { throw new Error("config_write_failed"); },
    }), /config_write_failed/);

    assert.deepEqual(fs.readFileSync(vaultPath), beforeVault, "failed config persistence restores the prior envelope");
    assert.deepEqual(fs.readFileSync(dekPath), beforeDek, "failed config persistence restores the prior protected DEK");
    assert.equal(local.status().unlocked, true, "the restored envelope and DEK remain a usable pair");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("sync engine rolls back imported vault when its config commit fails", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cherry-sync-engine-rollback-"));
  const provider = new FakeProvider();
  const remoteSecure = {
    schemaVersion: 1,
    datasetId,
    providers: [{ id: "route-a", baseUrl: "https://remote.example", apiKey: "remote-secret" }],
  };
  const remotePublic = {
    ...emptyConfig(1, "dev_remote"),
    defaultProvider: "route-a",
    providers: [{ id: "route-a", name: "Remote", enabled: true, models: ["gpt-test"] }],
  };
  const remoteSource = new SyncSource({ revision: 1, deviceId: "dev_remote", publicConfig: remotePublic, secureConfig: remoteSecure });
  const localSource = new SyncSource({
    revision: 0,
    deviceId: "dev_local",
    publicConfig: emptyConfig(0, "dev_local"),
    secureConfig: { schemaVersion: 1, datasetId, providers: [] },
    failReplace: true,
  });
  const localVault = new LocalVaultStore({ dataDir: path.join(root, "local"), protect, unprotect });
  const remoteVault = new LocalVaultStore({ dataDir: path.join(root, "remote"), protect, unprotect });
  try {
    await localVault.initialize({ datasetId, secrets: localSource.secureConfig, password: "local-password", kdfOptions: { t: 1, m: 1024, p: 1 } });
    await remoteVault.initialize({ datasetId, secrets: remoteSecure, password: "remote-password", kdfOptions: { t: 1, m: 1024, p: 1 } });
    await new SyncEngine({ provider, source: remoteSource, vault: remoteVault }).sync("seed-cloud");
    const localVaultFile = path.join(root, "local", "vault.enc");
    const localDekFile = path.join(root, "local", ".vault-local-key");
    const beforeVault = fs.readFileSync(localVaultFile);
    const beforeDek = fs.readFileSync(localDekFile);

    await assert.rejects(() => new SyncEngine({ provider, source: localSource, vault: localVault }).sync("config-write-failure", {
      configPolicy: "remote",
      password: "remote-password",
    }), /config_write_failed/);

    assert.deepEqual(fs.readFileSync(localVaultFile), beforeVault);
    assert.deepEqual(fs.readFileSync(localDekFile), beforeDek);
    assert.equal(localSource.publicConfig.providers.length, 0);
    assert.equal(localVault.status().unlocked, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("corrupt gateway config fails closed while a missing first-install config initializes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cherry-gateway-config-safety-"));
  const gatewayUrl = pathToFileURL(path.resolve("gateway/gateway.mjs")).href;
  const runGateway = (dataDir) => spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(gatewayUrl)})`], {
    encoding: "utf8",
    env: { ...process.env, GATEWAY_DATA_DIR: dataDir, GATEWAY_EMBEDDED: "1" },
  });
  try {
    const corruptInputs = [
      Buffer.from("{ damaged config", "utf8"),
      Buffer.from(JSON.stringify({ providers: "not-an-array", clientKeys: [] }), "utf8"),
    ];
    for (const [index, corruptBytes] of corruptInputs.entries()) {
      const corruptDir = path.join(root, `corrupt-${index}`);
      fs.mkdirSync(corruptDir);
      const corruptPath = path.join(corruptDir, "config.json");
      fs.writeFileSync(corruptPath, corruptBytes);
      const corruptRun = runGateway(corruptDir);
      assert.notEqual(corruptRun.status, 0, "startup must fail for an existing unreadable config");
      assert.match(`${corruptRun.stderr}${corruptRun.stdout}`, /gateway_config_file_invalid/);
      assert.deepEqual(fs.readFileSync(corruptPath), corruptBytes, "corrupt config is never replaced with defaults");
    }

    const firstInstallDir = path.join(root, "first-install");
    const firstInstallRun = runGateway(firstInstallDir);
    assert.equal(firstInstallRun.status, 0, firstInstallRun.stderr || firstInstallRun.stdout);
    const initialized = JSON.parse(fs.readFileSync(path.join(firstInstallDir, "config.json"), "utf8"));
    assert.equal(initialized.schemaVersion, 1);
    assert.deepEqual(initialized.providers, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("same-device remote omission preserves local-only client keys, while an explicit tombstone deletes", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cherry-gateway-sync-safety-"));
  const previousDataDir = process.env.GATEWAY_DATA_DIR;
  const previousEmbedded = process.env.GATEWAY_EMBEDDED;
  process.env.GATEWAY_DATA_DIR = dataDir;
  process.env.GATEWAY_EMBEDDED = "1";
  let gateway;
  try {
    gateway = await import(`../gateway/gateway.mjs?syncSafety=${Date.now()}-${Math.random()}`);
    const initial = gateway.getSyncSnapshot();
    const secureConfig = {
      schemaVersion: 1,
      datasetId: initial.identity.datasetId,
      providers: [{ id: "route-a", baseUrl: "https://remote.example", apiKey: "upstream-secret" }],
    };
    const keyId = "local-only-key";
    gateway.replaceConfigFromSync({
      ...initial.publicConfig,
      configRevision: { counter: 1, deviceId: "dev-remote" },
      defaultProvider: "route-a",
      providers: [{ id: "route-a", name: "Remote", enabled: true, models: ["gpt-test"] }],
      clientKeyMetadata: [{ id: keyId, name: "Local key", nameCustomized: true, providerId: "route-a", reasoningLevel: "high", createdAt: "2026-09-25 10:00:00", enabled: true }],
    }, secureConfig, { allowGenerateClientSecrets: true });
    const localSecret = gateway.getClientKeyImportDetails(keyId).apiKey;
    assert.equal(JSON.stringify(gateway.getSyncSnapshot().publicConfig).includes(localSecret), false, "plaintext client Key must remain local");

    const remoteWithoutLocalKey = {
      ...gateway.getSyncSnapshot().publicConfig,
      configRevision: { counter: 2, deviceId: "dev-remote" },
      clientKeyMetadata: [],
    };
    gateway.replaceConfigFromSync(remoteWithoutLocalKey, secureConfig);
    assert.deepEqual(gateway.getSyncSnapshot().publicConfig.clientKeyMetadata.map((item) => item.id), [keyId]);
    assert.equal(gateway.getClientKeyImportDetails(keyId).apiKey, localSecret, "same-device sync must preserve the local secret");

    gateway.replaceConfigFromSync(remoteWithoutLocalKey, secureConfig, {
      tombstones: [{ objectType: "client-key", objectId: keyId }],
    });
    assert.deepEqual(gateway.getSyncSnapshot().publicConfig.clientKeyMetadata, [], "only an explicit client-key tombstone deletes the local-only metadata");
  } finally {
    if (gateway) await gateway.stopGateway();
    if (previousDataDir === undefined) delete process.env.GATEWAY_DATA_DIR;
    else process.env.GATEWAY_DATA_DIR = previousDataDir;
    if (previousEmbedded === undefined) delete process.env.GATEWAY_EMBEDDED;
    else process.env.GATEWAY_EMBEDDED = previousEmbedded;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
