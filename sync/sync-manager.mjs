/**
 * 中文：桌面端同步编排器。
 *
 * 本文件连接 UI、GitHub Provider、SyncEngine 和 LocalVaultStore，但不复制密码学逻辑。
 * GitHub token 使用 Windows 安全存储保护；同步保险库的密码/恢复码只在调用期间传给
 * LocalVaultStore，绝不进入 `sync-state.json` 或日志。SyncEngine 抛出错误时，本机服务
 * 仍保持可用，并通过状态对象明确告诉 UI 是用量可同步还是敏感配置需要解锁。
 *
 * English: Desktop synchronization coordinator.
 *
 * This module connects the UI, GitHub provider, SyncEngine, and LocalVaultStore without
 * duplicating cryptography. The GitHub token is protected by Windows secure storage; vault
 * passwords/recovery codes are passed to LocalVaultStore only for the current operation and
 * never enter `sync-state.json` or logs. When SyncEngine fails, the local service remains
 * available and the published state distinguishes usage-only sync from a vault unlock problem.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { GitHubReleaseProvider } from "./github-provider.mjs";
import { LocalVaultStore } from "./local-vault-store.mjs";
import { SyncEngine } from "./sync-engine.mjs";

const INTERVAL_MS = 30 * 60 * 1000;

function atomicJson(file, value) {
  // 中文：同步状态也采用临时文件替换，避免 UI 读到半截 JSON。
  // English: Sync state uses temporary-file replacement so the UI never reads half a JSON file.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  try { fs.renameSync(temporary, file); }
  catch (error) {
    try { fs.copyFileSync(temporary, file); fs.unlinkSync(temporary); }
    catch {
      // 中文：保留原始写入错误；临时文件清理失败不应伪装成同步成功。
      // English: Preserve the original write error; failed temporary-file cleanup must not look
      // like a successful sync.
      try { fs.unlinkSync(temporary); }
      catch {
        // 中文：清理失败不影响原始错误；临时状态文件不会作为同步状态读取。
        // English: Cleanup failure does not change the original error; the temporary state file
        // is never read as sync state.
      }
      throw error;
    }
  }
}

function readJson(file, fallback) {
  // 中文：状态文件损坏时回退到内存默认值，但不触碰 vault.enc 或同步资产。
  // English: A damaged state file falls back to in-memory defaults without touching vault.enc
  // or remote sync assets.
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
      syncUpstream: true,
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

  // 中文：token 文件只保存系统保护后的内容；原文只在创建 Provider 的瞬间存在。
  // English: The token file stores only system-protected content; plaintext exists only while
  // constructing a provider for the current operation.
  #saveToken(token) { fs.writeFileSync(this.credentialFile, Buffer.from(this.protect(String(token)))); }

  #readToken() {
    if (!fs.existsSync(this.credentialFile)) return "";
    try { return String(this.unprotect(fs.readFileSync(this.credentialFile))); }
    catch { throw new Error("github_local_credential_unavailable"); }
  }

  #hasReadableToken() {
    try { return Boolean(this.#readToken()); }
    catch { return false; }
  }

  #provider(token = this.#readToken()) {
    if (!token) throw new Error("github_auth_required");
    return this.providerFactory({ token, owner: this.state.owner, repository: this.state.repository });
  }

  #makeEngine(provider) {
    // 中文：所有同步状态通过回调回写，避免 engine 和 manager 各自维护一份不同步状态。
    // English: All sync status flows through one callback so the engine and manager cannot drift
    // into two conflicting state copies.
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
    // 中文：调度器只负责触发同步；加密状态和资产提交仍由 vault/store/engine 负责。
    // English: The scheduler only triggers synchronization; vault security and asset commits
    // remain owned by the vault store and engine.
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
      // 中文：未连接时不宣称开启中转站 API 同步；已连接的旧状态默认保持原有加密同步行为。
      // English: Do not claim upstream sync is enabled while disconnected; legacy connected
      // states keep encrypted upstream sync unless the user explicitly chose usage-only mode.
      syncUpstream: Boolean(this.state.account && this.state.syncUpstream !== false),
      // 中文：只有凭据文件存在且能被 Windows 安全存储解密时才显示“已连接”。
      // English: Show the account as connected only when the credential file exists and can be
      // decrypted by Windows secure storage.
      connected: Boolean(this.state.account && this.#hasReadableToken()),
      pendingCount: Number(snapshot.ledger?.pendingCount || this.state.pendingCount || 0),
      datasetId: snapshot.identity.datasetId,
      intervalMinutes: 30,
      vault: this.vault.status(),
    };
  }

  async connect({ token, repository = "cherry-ai-connect-sync", password = "", syncUpstream = true } = {}) {
    // 中文：连接顺序先探测仓库和远端数据，再决定初始化本机 vault；避免盲目创建新密钥
    // 覆盖用户原来的同步身份。
    // English: Inspect the repository and remote dataset before initializing the local vault;
    // never create a new local key blindly and risk replacing the user's sync identity.
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
    syncUpstream = Boolean(syncUpstream);
    const remoteHasVault = Boolean(latest?.manifest?.files?.some((item) => item.type === "vault"));
    const keepLocalVault = syncUpstream && (!remoteHasVault || !pristine);
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
      syncUpstream,
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
        ? { adoptRemoteIfPristine: true, configPolicy: "remote", allowGenerateClientSecrets: true, password: String(password), syncUpstream }
        : { syncUpstream });
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
    // 中文：解锁成功才清理错误状态；失败时保留 vault 错误，防止 UI 误报同步已恢复。
    // English: Clear error state only after a successful unlock; preserve vault errors on failure
    // so the UI cannot claim that sensitive sync has recovered prematurely.
    const result = await this.vault.unlock({ password, recoveryCode });
    this.#publish({ error: "", errorCode: "" });
    return { ok: true, ...result, status: this.status() };
  }

  async syncNow(reason = "manual", options = {}) {
    // 中文：每次主动同步都重新创建 Provider/Engine，保证读取到最新凭据和本地 vault 状态。
    // English: Recreate the provider/engine for each explicit sync so the latest credential and
    // local vault state are always used.
    if (!this.state.account) throw new Error("github_auth_required");
    try {
      const provider = this.#provider();
      this.engine = this.#makeEngine(provider);
      const result = await this.engine.sync(reason, { syncUpstream: Boolean(this.state.account && this.state.syncUpstream !== false), ...options });
      this.#publish({ ...result, enabled: this.state.enabled });
      return this.status();
    } catch (error) {
      const engineStatus = this.engine?.status() || {};
      this.#publish({ state: engineStatus.state || "ERROR_RECOVERABLE", errorCode: engineStatus.errorCode || String(error?.message || error), error: String(error?.message || error), lastAttemptAt: new Date().toISOString() });
      throw error;
    }
  }

  async resolveConflict({ choice, password = "", recoveryCode = "" } = {}) {
    // 中文：只有明确选择“本地”时才准备本机 vault；选择“远端”由 engine 先认证远端 vault。
    // English: Prepare the local vault only for an explicit local choice; a remote choice lets
    // the engine authenticate the remote vault first.
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
    // 中文：断开只删除本机 GitHub token，不删除 vault、历史同步状态或远端资产，便于重新连接。
    // English: Disconnect removes only the local GitHub token. Vault files, sync state, and
    // remote assets remain so the account can be safely reconnected later.
    await this.setEnabled(false).catch(() => {});
    if (fs.existsSync(this.credentialFile)) fs.unlinkSync(this.credentialFile);
    this.engine = null;
    this.#publish({ enabled: false, state: "DISABLED", account: null, owner: "", repositoryPrivate: false, nextSyncAt: "", error: "", errorCode: "" });
    return this.status();
  }

  async startup() {
    if (!this.state.enabled || !this.state.account) return this.status();
    try { await this.syncNow("startup"); }
    catch {
      // 中文：状态对象已经记录失败；本地连接服务继续可用，不因云同步中断而退出。
      // English: The state object already records the failure; keep the local connection service
      // available instead of exiting because cloud sync was interrupted.
    }
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
