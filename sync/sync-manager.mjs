/**
 * 中文：桌面端同步编排器，负责凭证保护、30 分钟调度、重大事件同步和可读状态。
 * English: Desktop sync coordinator for protected credentials, scheduling, major-event syncs, and user-facing state.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { GitHubReleaseProvider } from "./github-provider.mjs";
import { LocalVaultStore } from "./local-vault-store.mjs";
import { SyncEngine } from "./sync-engine.mjs";

const INTERVAL_MS = 30 * 60 * 1000;

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  try { fs.renameSync(temporary, file); }
  catch (error) {
    try { fs.copyFileSync(temporary, file); fs.unlinkSync(temporary); }
    catch { try { fs.unlinkSync(temporary); } catch { /* best effort */ } throw error; }
  }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}

export class SyncManager {
  constructor({ dataDir, source, protect, unprotect, notify = () => {}, providerFactory } = {}) {
    if (!dataDir || !source || typeof protect !== "function" || typeof unprotect !== "function") throw new Error("sync_manager_dependencies_required");
    this.dataDir = dataDir;
    this.source = source;
    this.protect = protect;
    this.unprotect = unprotect;
    this.notify = notify;
    this.providerFactory = providerFactory || ((options) => new GitHubReleaseProvider(options));
    this.stateFile = path.join(dataDir, "sync-state.json");
    this.credentialFile = path.join(dataDir, ".github-token");
    this.vault = new LocalVaultStore({ dataDir, protect, unprotect });
    this.timer = null;
    this.engine = null;
    this.state = {
      schemaVersion: 1,
      enabled: false,
      provider: "github",
      owner: "",
      repository: "cherry-ai-connect-sync",
      account: null,
      repositoryPrivate: false,
      releaseTag: "cherry-sync",
      state: "DISABLED",
      generation: 0,
      pendingCount: 0,
      lastSyncAt: "",
      lastAttemptAt: "",
      nextSyncAt: "",
      errorCode: "",
      error: "",
      warning: "",
      ...readJson(this.stateFile, {}),
    };
    this.#publish();
  }

  #save() { atomicJson(this.stateFile, this.state); }

  #publish(patch = {}) {
    this.state = { ...this.state, ...patch };
    this.#save();
    this.notify(this.status());
  }

  #saveToken(token) { fs.writeFileSync(this.credentialFile, Buffer.from(this.protect(String(token)))); }

  #readToken() {
    if (!fs.existsSync(this.credentialFile)) return "";
    try { return String(this.unprotect(fs.readFileSync(this.credentialFile))); }
    catch { throw new Error("github_local_credential_unavailable"); }
  }

  #provider(token = this.#readToken()) {
    if (!token) throw new Error("github_auth_required");
    return this.providerFactory({ token, owner: this.state.owner, repository: this.state.repository });
  }

  #makeEngine(provider) {
    return new SyncEngine({
      provider,
      source: this.source,
      vault: this.vault,
      onState: (status) => {
        this.#publish({ ...status, enabled: this.state.enabled, nextSyncAt: this.state.enabled ? new Date(Date.now() + INTERVAL_MS).toISOString() : "" });
      },
    });
  }

  #schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.state.enabled) return;
    const nextSyncAt = new Date(Date.now() + INTERVAL_MS).toISOString();
    this.#publish({ nextSyncAt });
    this.timer = setTimeout(() => {
      void this.syncNow("scheduled").catch(() => {}).finally(() => this.#schedule());
    }, INTERVAL_MS);
    this.timer.unref?.();
  }

  status() {
    const snapshot = this.source.getSyncSnapshot();
    return {
      ...this.state,
      connected: Boolean(this.state.account && fs.existsSync(this.credentialFile)),
      pendingCount: Number(snapshot.ledger?.pendingCount || this.state.pendingCount || 0),
      datasetId: snapshot.identity.datasetId,
      intervalMinutes: 30,
      vault: this.vault.status(),
    };
  }

  async connect({ token, repository = "cherry-ai-connect-sync", password = "" } = {}) {
    const candidate = String(token || "").trim();
    if (!candidate) throw new Error("github_token_required");
    this.state.repository = String(repository || "cherry-ai-connect-sync").trim();
    const provider = this.#provider(candidate);
    const ready = await provider.ensureReady();
    this.engine = this.#makeEngine(provider);
    const latest = await this.engine.inspectLatest();
    const pristine = Boolean(this.source.canAdoptSyncDataset?.());
    let snapshot = this.source.getSyncSnapshot();
    if (latest && latest.manifest.datasetId !== snapshot.identity.datasetId) {
      if (!pristine) throw new Error("sync_dataset_conflict");
      this.source.adoptSyncDataset?.(latest.manifest.datasetId);
      snapshot = this.source.getSyncSnapshot();
    }
    const remoteHasVault = Boolean(latest?.manifest?.files?.some((item) => item.type === "vault"));
    const keepLocalVault = !remoteHasVault || !pristine;
    let recoveryCode = "";
    const vaultStatus = this.vault.status();
    if (keepLocalVault && !vaultStatus.initialized) {
      if (String(password).length < 8) throw new Error("vault_password_required");
      const initialized = await this.vault.initialize({ datasetId: snapshot.identity.datasetId, secrets: snapshot.secureConfig, password: String(password) });
      recoveryCode = initialized.recoveryCode;
    } else if (keepLocalVault && !vaultStatus.unlocked) {
      if (!password) throw new Error("vault_unlock_required");
      await this.vault.unlock({ password: String(password) });
    }
    this.#saveToken(candidate);
    this.#publish({
      enabled: true,
      owner: ready.owner,
      repository: ready.repository,
      account: ready.account,
      repositoryPrivate: ready.private === true,
      releaseTag: ready.releaseTag,
      state: "DIRTY",
      error: "",
      errorCode: "",
    });
    let result;
    try {
      result = await this.engine.sync("connect", latest && pristine
        ? { adoptRemoteIfPristine: true, configPolicy: "remote", password: String(password) }
        : {});
    } catch (error) {
      // 中文：连接已建立时仍返回状态，尤其要保证新生成的恢复码能展示给用户。
      // English: Return the connected state so a newly generated recovery code is never hidden by a first-sync failure.
      if (!recoveryCode) throw error;
      result = this.engine.status();
    }
    this.#schedule();
    return { ok: true, recoveryCode, status: this.status(), sync: result };
  }

  async unlockVault({ password, recoveryCode } = {}) {
    const result = await this.vault.unlock({ password, recoveryCode });
    this.#publish({ error: "", errorCode: "" });
    return { ok: true, ...result, status: this.status() };
  }

  async syncNow(reason = "manual") {
    if (!this.state.account) throw new Error("github_auth_required");
    const provider = this.#provider();
    this.engine = this.engine || this.#makeEngine(provider);
    try {
      const result = await this.engine.sync(reason);
      this.#publish({ ...result, enabled: this.state.enabled });
      return this.status();
    } catch (error) {
      this.#publish({ state: this.engine.status().state, errorCode: this.engine.status().errorCode, error: String(error?.message || error), lastAttemptAt: new Date().toISOString() });
      throw error;
    }
  }

  async resolveConflict({ choice, password = "", recoveryCode = "" } = {}) {
    if (!this.state.account) throw new Error("github_auth_required");
    if (!['local', 'remote'].includes(String(choice))) throw new Error("sync_conflict_choice_required");
    const provider = this.#provider();
    this.engine = this.engine || this.#makeEngine(provider);
    let nextRecoveryCode = "";
    if (choice === "local") {
      const vaultStatus = this.vault.status();
      if (!vaultStatus.initialized) {
        if (String(password).length < 8) throw new Error("vault_password_required");
        const snapshot = this.source.getSyncSnapshot();
        const initialized = await this.vault.initialize({
          datasetId: snapshot.identity.datasetId,
          secrets: snapshot.secureConfig,
          password: String(password),
        });
        nextRecoveryCode = initialized.recoveryCode;
      } else if (!vaultStatus.unlocked) {
        await this.vault.unlock({ password: String(password), recoveryCode: String(recoveryCode) });
      }
    }
    const result = await this.engine.sync("resolve-conflict", {
      configPolicy: String(choice),
      password: String(password),
      recoveryCode: String(recoveryCode),
    });
    this.#publish({ ...result, enabled: this.state.enabled, error: "", errorCode: "" });
    this.#schedule();
    return { ok: true, recoveryCode: nextRecoveryCode, status: this.status() };
  }

  async setEnabled(enabled) {
    if (enabled) {
      if (!this.state.account) throw new Error("github_auth_required");
      this.#publish({ enabled: true, state: "DIRTY" });
      const status = await this.syncNow("enable");
      this.#schedule();
      return status;
    }
    let warning = "";
    if (this.state.account) {
      try { await this.syncNow("disable"); }
      catch { warning = "sync_disabled_with_pending_data"; }
    }
    this.#publish({ enabled: false, state: "DISABLED", nextSyncAt: "", warning });
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    return this.status();
  }

  async disconnect() {
    await this.setEnabled(false).catch(() => {});
    if (fs.existsSync(this.credentialFile)) fs.unlinkSync(this.credentialFile);
    this.engine = null;
    this.#publish({ enabled: false, state: "DISABLED", account: null, owner: "", repositoryPrivate: false, nextSyncAt: "", error: "", errorCode: "" });
    return this.status();
  }

  async startup() {
    if (!this.state.enabled || !this.state.account) return this.status();
    try { await this.syncNow("startup"); }
    catch { /* status already captures the failure; local service stays available */ }
    this.#schedule();
    return this.status();
  }

  async resume() {
    if (!this.state.enabled) return this.status();
    try { return await this.syncNow("resume"); }
    finally { this.#schedule(); }
  }

  async shutdown(deadlineMs = 5000) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.state.enabled || !this.state.account) return this.status();
    return Promise.race([
      this.syncNow("shutdown").catch(() => this.status()),
      new Promise((resolve) => setTimeout(() => resolve(this.status()), Math.max(500, deadlineMs))),
    ]);
  }
}

export const syncIntervalMinutes = 30;
