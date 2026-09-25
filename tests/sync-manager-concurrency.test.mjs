/** 中文：SyncManager 管理器级同步并发回归。 English: SyncManager concurrency regression tests. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { UsageLedger } from "../gateway/usage-ledger.mjs";
import { SyncManager } from "../sync/sync-manager.mjs";

const datasetId = "ds_11995f2c-7f5a-7b21-a8d2-6dfc50f4a901";
const protect = (value) => Buffer.from(`protected:${value}`, "utf8");
const unprotect = (value) => Buffer.from(value).toString("utf8").replace(/^protected:/, "");

class BlockingProvider {
  constructor() {
    this.assets = new Map();
    this.nextId = 1;
    this.active = 0;
    this.maxActive = 0;
    this.blockNext = false;
    this.blocked = false;
    this.release = null;
    this.blockedPromise = Promise.resolve();
    this.blockNextEnsure = false;
    this.ensureBlockedPromise = Promise.resolve();
    this.ensureRelease = null;
    this.failManifestOnce = false;
  }

  resetRoundTracking() {
    this.active = 0;
    this.maxActive = 0;
    this.blocked = false;
    this.release = null;
  }

  blockNextUpload() {
    this.blockNext = true;
    this.blockedPromise = new Promise((resolve) => { this.markBlocked = resolve; });
  }

  waitUntilBlocked() { return this.blockedPromise; }

  releaseUpload() {
    this.release?.();
    this.release = null;
  }

  blockNextEnsureReady() {
    this.blockNextEnsure = true;
    this.ensureBlockedPromise = new Promise((resolve) => { this.markEnsureBlocked = resolve; });
  }

  waitUntilEnsureReady() { return this.ensureBlockedPromise; }

  releaseEnsureReady() {
    this.ensureRelease?.();
    this.ensureRelease = null;
  }

  async #operation(action) {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try { return await action(); }
    finally { this.active -= 1; }
  }

  async ensureReady() {
    if (this.blockNextEnsure) {
      this.blockNextEnsure = false;
      this.markEnsureBlocked?.();
      await new Promise((resolve) => { this.ensureRelease = resolve; });
    }
    return { owner: "test-user", repository: "sync-repo", account: { id: "1", login: "test-user", avatarUrl: "" }, private: true, releaseTag: "cherry-sync" };
  }

  async listAssets() {
    return this.#operation(async () => [...this.assets.values()].map((item) => ({
      id: item.id,
      name: item.name,
      size: item.bytes.length,
      createdAt: item.createdAt,
    })));
  }

  async downloadAsset(asset) {
    return this.#operation(async () => {
      const item = this.assets.get(asset.name);
      if (!item) throw new Error("404 asset");
      return Buffer.from(item.bytes);
    });
  }

  async uploadAsset(name, bytes) {
    return this.#operation(async () => {
      if (this.blockNext) {
        this.blockNext = false;
        this.blocked = true;
        this.markBlocked?.();
        await new Promise((resolve) => { this.release = resolve; });
      }
      if (this.failManifestOnce && name.startsWith("manifest-")) {
        this.failManifestOnce = false;
        throw new Error("simulated_manifest_failure");
      }
      if (this.assets.has(name)) throw new Error("422 immutable duplicate");
      this.assets.set(name, { id: this.nextId++, name, bytes: Buffer.from(bytes), createdAt: new Date().toISOString() });
    });
  }

  async deleteAsset(asset) {
    return this.#operation(async () => { this.assets.delete(asset.name); });
  }
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cherry-sync-manager-concurrency-"));
  const ledgerDir = path.join(root, "ledger");
  fs.mkdirSync(ledgerDir, { recursive: true });
  fs.writeFileSync(path.join(ledgerDir, "device.json"), JSON.stringify({
    datasetId,
    deviceId: "dev_11995f2c-7f5a-7b21-a8d2-6dfc50f4a901",
    deviceEpoch: 1,
  }));
  const ledger = new UsageLedger(ledgerDir);
  const syncRuns = [];
  const source = {
    getSyncSnapshot: () => ({
      identity: { ...ledger.identity },
      publicConfig: { schemaVersion: 1, configRevision: { counter: 1, deviceId: "dev_config" }, forcedLevel: "high", defaultProvider: "", providers: [], clientKeyMetadata: [] },
      secureConfig: { schemaVersion: 1, datasetId, providers: [] },
      events: ledger.pendingUsage(),
      counters: ledger.counters(),
      tombstones: ledger.tombstones(),
      ledger: ledger.status(),
    }),
    mergeRemoteUsage: (payload) => ledger.mergeRemote(payload),
    markSyncEvents: (ids) => ledger.markEventsSynced(ids),
    recordSyncRun: (payload) => { syncRuns.push({ ...payload }); ledger.recordSyncRun(payload); },
  };
  const provider = new BlockingProvider();
  const manager = new SyncManager({
    dataDir: path.join(root, "manager"),
    source,
    protect,
    unprotect,
    providerFactory: () => provider,
  });
  return { root, ledger, manager, provider, syncRuns };
}

function append(ledger, eventId, totalTokens = 10) {
  ledger.append({
    eventId,
    at: new Date().toISOString(),
    providerId: "route-a",
    providerName: "Route A",
    clientKeyId: "client-a",
    clientKeyName: "Client A",
    model: "gpt-test",
    endpoint: "/v1/chat/completions",
    method: "POST",
    reasoningLevel: "high",
    status: 200,
    inputTokens: totalTokens,
    totalTokens,
  });
}

async function connectedFixture() {
  const fixture = createFixture();
  await fixture.manager.connect({ token: "test-token", repository: "sync-repo", syncUpstream: false });
  fixture.provider.resetRoundTracking();
  return fixture;
}

function closeFixture({ root, ledger, manager }) {
  if (manager.timer) clearTimeout(manager.timer);
  ledger.close();
  fs.rmSync(root, { recursive: true, force: true });
}

test("coalesces manual, scheduled, config-change, and before-update calls into one round", async () => {
  const fixture = await connectedFixture();
  const { ledger, manager, provider, syncRuns } = fixture;
  try {
    append(ledger, "event-concurrent-1", 11);
    provider.blockNextUpload();

    const manual = manager.syncNow("manual");
    await provider.waitUntilBlocked();
    const scheduled = manager.syncNow("scheduled");
    const configChange = manager.syncNow("config-changed");
    const beforeUpdate = manager.syncNow("before-update");

    assert.strictEqual(scheduled, manual, "scheduled call must join the active round");
    assert.strictEqual(configChange, manual, "config-change call must join the active round");
    assert.strictEqual(beforeUpdate, manual, "before-update call must join the active round");
    assert.equal(provider.maxActive, 1, "joiners must not enter provider writes while the round is blocked");

    provider.releaseUpload();
    const statuses = await Promise.all([manual, scheduled, configChange, beforeUpdate]);
    assert.equal(provider.maxActive, 1, "one manager round must never overlap provider/manifest work");
    assert.deepEqual(new Set(statuses.map((status) => status.generation)), new Set([2]));
    assert.equal(new Set(statuses.map((status) => status.lastSyncAt)).size, 1, "joiners receive one round result");
    assert.equal(syncRuns.filter((run) => run.state === "SYNCING").at(-1).summary, "manual", "first caller owns the round reason");
    assert.equal(syncRuns.filter((run) => run.state === "SYNCING").length, 2, "one connect round plus one concurrent round");
    assert.equal([...provider.assets.keys()].filter((name) => name.startsWith("manifest-")).length, 2);
  } finally {
    closeFixture(fixture);
  }
});

test("releases the manager slot after a failed round so a retry can write", async () => {
  const fixture = await connectedFixture();
  const { ledger, manager, provider } = fixture;
  try {
    append(ledger, "event-concurrent-failure", 13);
    provider.failManifestOnce = true;
    const scheduled = manager.syncNow("scheduled");
    const beforeUpdate = manager.syncNow("before-update");
    assert.strictEqual(beforeUpdate, scheduled, "failure joiner must share the same rejected round");
    await assert.rejects(scheduled, /simulated_manifest_failure/);
    await assert.rejects(beforeUpdate, /simulated_manifest_failure/);

    const retry = await manager.syncNow("manual-retry");
    assert.equal(retry.state, "IDLE");
    assert.equal(retry.generation, 2);
  } finally {
    closeFixture(fixture);
  }
});

test("pauses the timer, waits for the active round, blocks ordinary triggers, and runs the final update sync", async () => {
  const fixture = await connectedFixture();
  const { ledger, manager, provider } = fixture;
  try {
    append(ledger, "event-before-update-active", 17);
    provider.blockNextUpload();
    const activeRound = manager.syncNow("manual");
    await provider.waitUntilBlocked();

    append(ledger, "event-during-update-wait", 19);
    const updateSync = manager.syncBeforeUpdate();
    assert.equal(manager.timer, null, "update pause must clear the delayed timer immediately");
    await assert.rejects(manager.syncNow("manual-during-update"), /sync_paused_for_update/);
    assert.equal(provider.maxActive, 1, "the update must wait instead of overlapping the current provider write");

    provider.releaseUpload();
    const finalStatus = await updateSync;
    await activeRound;
    assert.equal(finalStatus.generation, 3, "the update-only round must sync entries added during the active round");
    assert.equal(ledger.pendingUsage().length, 0, "the final committed manifest must drain the pending outbox");
    assert.equal(manager.timer, null, "successful final sync stays paused until the update finishes");

    manager.resumeAfterUpdate();
    assert.ok(manager.timer, "resume must restore the automatic timer");
    await assert.doesNotReject(manager.syncNow("manual-after-update"));
  } finally {
    closeFixture(fixture);
  }
});

test("restores scheduled sync after a failed update-only final round and preserves pending outbox", async () => {
  const fixture = await connectedFixture();
  const { ledger, manager, provider } = fixture;
  try {
    append(ledger, "event-update-final-failure", 23);
    provider.failManifestOnce = true;
    await assert.rejects(manager.syncBeforeUpdate(), /simulated_manifest_failure/);
    assert.ok(manager.timer, "a failed final sync must resume the delayed timer");
    assert.equal(ledger.pendingUsage().length, 1, "uncommitted outbox entries must remain available for retry");

    const retry = await manager.syncNow("manual-after-update-failure");
    assert.equal(retry.state, "IDLE");
    assert.equal(ledger.pendingUsage().length, 0);
  } finally {
    closeFixture(fixture);
  }
});

test("restores ordinary sync when the update final sync is cancelled", async () => {
  const fixture = await connectedFixture();
  const { ledger, manager, provider } = fixture;
  try {
    append(ledger, "event-update-final-cancel", 29);
    provider.blockNextUpload();
    const controller = new AbortController();
    const updateSync = manager.syncBeforeUpdate({ signal: controller.signal });
    await provider.waitUntilBlocked();
    controller.abort();
    await assert.rejects(updateSync, { name: "AbortError" });
    assert.ok(manager.timer, "cancelling the update sync must restore the delayed timer");

    provider.releaseUpload();
    await manager.syncNow("manual-after-update-cancel");
    assert.equal(ledger.pendingUsage().length, 0, "the still-running final round must retain and eventually commit its outbox");
  } finally {
    closeFixture(fixture);
  }
});

test("cancelling while waiting for an active round resumes without starting the update sync", async () => {
  const fixture = await connectedFixture();
  const { ledger, manager, provider, syncRuns } = fixture;
  try {
    append(ledger, "event-update-wait-cancel-active", 31);
    provider.blockNextUpload();
    const activeRound = manager.syncNow("manual-before-update");
    await provider.waitUntilBlocked();
    append(ledger, "event-update-wait-cancel-pending", 37);

    const controller = new AbortController();
    const updateSync = manager.syncBeforeUpdate({ signal: controller.signal });
    controller.abort();
    await assert.rejects(updateSync, { name: "AbortError" });
    assert.ok(manager.timer, "cancellation while draining the active round must resume the timer");

    provider.releaseUpload();
    await activeRound;
    assert.equal(syncRuns.filter((run) => run.state === "SYNCING").length, 2, "cancellation must not start a separate final round");
    assert.equal(ledger.pendingUsage().length, 1, "the event added during the cancelled wait must remain in the durable outbox");
    await manager.syncNow("manual-after-wait-cancel");
    assert.equal(ledger.pendingUsage().length, 0);
  } finally {
    closeFixture(fixture);
  }
});

test("cancelling the update after its final sync resumes the timer", async () => {
  const fixture = await connectedFixture();
  const { manager } = fixture;
  try {
    const controller = new AbortController();
    await manager.syncBeforeUpdate({ signal: controller.signal });
    assert.equal(manager.timer, null, "successful final sync must leave scheduled sync paused during the update");
    controller.abort();
    assert.ok(manager.timer, "the update cancellation signal must resume scheduled sync after final sync success");
  } finally {
    closeFixture(fixture);
  }
});

test("connect and conflict resolution cannot bypass the update pause gate", async () => {
  const fixture = await connectedFixture();
  const { manager } = fixture;
  try {
    await manager.pauseForUpdate();
    await assert.rejects(manager.connect({ token: "test-token", repository: "sync-repo", syncUpstream: false }), /sync_paused_for_update/);
    await assert.rejects(manager.resolveConflict({ choice: "local" }), /sync_paused_for_update/);
    await assert.rejects(manager.setEnabled(false), /sync_paused_for_update/);
    await assert.rejects(manager.unlockVault({ password: "test-password" }), /sync_paused_for_update/);
    await assert.rejects(manager.disconnect(), /sync_paused_for_update/);
    manager.resumeAfterUpdate();
  } finally {
    closeFixture(fixture);
  }
});

test("an update waits for an already-started connect control operation", async () => {
  const fixture = await connectedFixture();
  const { manager, provider } = fixture;
  try {
    provider.blockNextEnsureReady();
    const connecting = manager.connect({ token: "test-token", repository: "sync-repo", syncUpstream: false });
    await provider.waitUntilEnsureReady();
    let pauseSettled = false;
    const pausing = manager.pauseForUpdate().then((value) => { pauseSettled = true; return value; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pauseSettled, false, "update pause must wait for provider inspection and control writes already in flight");
    provider.releaseEnsureReady();
    await connecting;
    await pausing;
    manager.resumeAfterUpdate();
  } finally {
    provider.releaseEnsureReady();
    closeFixture(fixture);
  }
});
