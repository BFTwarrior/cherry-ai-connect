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
import { GitHubReleaseProvider, GitHubProviderError, createGitHubReadCache, githubRetryAt } from "./github-provider.mjs";
import { LocalVaultStore } from "./local-vault-store.mjs";
import { SyncEngine } from "./sync-engine.mjs";
import { stableJson } from './sync-common.mjs';

const INTERVAL_MS = 60 * 1000;

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

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("update_sync_aborted");
  error.name = "AbortError";
  return error;
}

function withAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => { cleanup(); reject(abortError(signal)); };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

export class SyncManager {
  #syncInFlight = null;
  #controlInFlight = null;
  #updatePaused = false;
  #updateAbortSignal = null;
  #updateAbortListener = null;
  #readCache = null;
  #readCacheKey = "";

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
    this.migrationSeedFile = path.join(dataDir, 'sync-v2-seed.json');
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
      syncFormat: 1,
      legacyProcessed: [],
      legacyPending: false,
      v2SeedPending: false,
      state: "DISABLED",
      generation: 0,
      pendingCount: 0,
      lastSyncAt: "",
      lastAttemptAt: "",
      nextSyncAt: "",
      errorCode: "",
      error: "",
      warning: "",
      retryAt: "",
      retryFailures: 0,
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

  #provider(token = this.#readToken(), format = this.state.syncFormat || 1) {
    if (!token) throw new Error("github_auth_required");
    const key = crypto.createHash("sha256").update(JSON.stringify([token, this.state.owner, this.state.repository])).digest("hex");
    if (key !== this.#readCacheKey) {
      this.#readCacheKey = key;
      this.#readCache = createGitHubReadCache();
    }
    return this.providerFactory({ token, owner: this.state.owner, repository: this.state.repository, releaseTag:format === 2 ? 'cherry-sync-v2' : 'cherry-sync', readCache: this.#readCache });
  }

  #makeEngine(provider, format = this.state.syncFormat || 1) {
    // 中文：所有同步状态通过回调回写，避免 engine 和 manager 各自维护一份不同步状态。
    // English: All sync status flows through one callback so the engine and manager cannot drift
    // into two conflicting state copies.
    return new SyncEngine({
      provider,
      source: new Proxy(this.source, {get:(source,key) => key === 'getSyncSnapshot' ? () => {
        const snapshot = this.source.getSyncSnapshot();
        if (format === 1) delete snapshot.publicConfig.catalogMetadata;
        if (format === 2 && this.state.v2SeedPending) {
          // Keep ALL legacy segment events until a v2 commit is verified. The
          // local display ledger may evict history under its size policy.
          const seed=JSON.parse(fs.readFileSync(this.migrationSeedFile,'utf8'));
          if(seed.datasetId!==snapshot.identity.datasetId || !Array.isArray(seed.events)) throw new Error('sync_migration_seed_invalid');
          snapshot.events=[...new Map([...seed.events,...(this.source.getMigrationEvents?.() || []),...snapshot.events].map(event=>[event.eventId || event.id,event])).values()];
        }
        return snapshot;
      } : typeof source[key] === 'function' ? source[key].bind(source) : source[key]}),
      schemaVersion: format,
      vault: this.vault,
      // Carry the last completed round into a fresh engine; starting or failing must not erase it.
      lastSyncAt: this.state.lastSyncAt,
      generation: this.state.generation,
      onState: (status) => {
        this.#publish({ ...status, enabled: this.state.enabled, nextSyncAt: this.state.enabled ? new Date(Math.max(Date.now() + INTERVAL_MS, Date.parse(this.state.retryAt) || 0)).toISOString() : "" });
      },
    });
  }

  #schedule() {
    // 中文：调度器只负责触发同步；加密状态和资产提交仍由 vault/store/engine 负责。
    // English: The scheduler only triggers synchronization; vault security and asset commits
    // remain owned by the vault store and engine.
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.state.enabled || this.#updatePaused) return;
    const delay = Math.max(INTERVAL_MS, (Date.parse(this.state.retryAt) || 0) - Date.now());
    const nextSyncAt = new Date(Date.now() + delay).toISOString();
    this.#publish({ nextSyncAt });
    this.timer = setTimeout(() => {
      void this.syncNow("scheduled").catch(() => {}).finally(() => this.#schedule());
    }, Math.min(delay, 2147483647));
    this.timer.unref?.();
  }

  status() {
    const snapshot = this.source.getSyncSnapshot();
    return {
      ...this.state,
      syncFormat: this.state.syncFormat || 1,
      state: this.state.legacyPending && this.state.state === 'IDLE' ? 'DIRTY' : this.state.state,
      warning: this.state.legacyPending ? (this.state.warning || 'sync_legacy_updates_pending') : this.state.warning,
      // The update pause is transient: expose it to every page, never persist a lock.
      pausedForUpdate: this.#updatePaused,
      nextSyncAt: this.#updatePaused ? "" : this.state.nextSyncAt,
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
      intervalMinutes: 1,
      vault: this.vault.status(),
    };
  }

  async connect({ token, repository = "cherry-ai-connect-sync", password = "", syncUpstream = true } = {}) {
    if (this.#updatePaused) throw new Error("sync_paused_for_update");
    const releaseControlOperation = this.#acquireControlOperation();
    try {
    // 中文：连接顺序先探测仓库和远端数据，再决定初始化本机 vault；避免盲目创建新密钥
    // 覆盖用户原来的同步身份。
    // English: Inspect the repository and remote dataset before initializing the local vault;
    // never create a new local key blindly and risk replacing the user's sync identity.
    const candidate = String(token || "").trim();
    if (!candidate) throw new Error("github_token_required");
    this.state.repository = String(repository || "cherry-ai-connect-sync").trim();
    if(this.state.syncFormat!==2) {
      const existingV2=await this.#makeEngine(this.#provider(candidate,2),2).inspectCommittedSet();
      if(existingV2.latest) this.#publish({syncFormat:2,releaseTag:'cherry-sync-v2'});
    }
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
    const automatic = typeof this.source.mergeConfigFromSync === "function";
    const keepLocalVault = syncUpstream && (!remoteHasVault || (!automatic && !pristine));
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
      retryAt: "",
      retryFailures: 0,
    });
    let result;
    try {
      result = await this.#startSync("connect", latest && pristine
        ? { adoptRemoteIfPristine: true, configPolicy: "remote", allowGenerateClientSecrets: true, password: String(password), syncUpstream }
        : { syncUpstream, password: String(password) }, { allowDuringUpdate: true });
    } catch (error) {
      // 中文：连接已建立时仍返回状态，尤其要保证新生成的恢复码能展示给用户。
      // English: Return the connected state so a newly generated recovery code is never hidden by a first-sync failure.
      if (!recoveryCode) throw error;
      result = this.engine.status();
    }
    this.#schedule();
    return { ok: true, recoveryCode, status: this.status(), sync: result };
    } finally {
      releaseControlOperation();
    }
  }

  async unlockVault({ password, recoveryCode } = {}) {
    // 中文：解锁成功才清理错误状态；失败时保留 vault 错误，防止 UI 误报同步已恢复。
    // English: Clear error state only after a successful unlock; preserve vault errors on failure
    // so the UI cannot claim that sensitive sync has recovered prematurely.
    if (this.#updatePaused) throw new Error("sync_paused_for_update");
    if (typeof this.source.mergeConfigFromSync === "function") {
      const releaseControlOperation = this.#acquireControlOperation();
      try {
        if (this.#syncInFlight) await this.#syncInFlight;
        const latest = await this.#makeEngine(this.#provider()).inspectLatest();
        const hasRemoteVault = latest?.manifest.files.some((item) => item.type === "vault");
        let nextRecoveryCode = "";
        if (!hasRemoteVault && !this.vault.status().initialized) {
          if (String(password || "").length < 8) throw new Error("vault_password_required");
          const snapshot = this.source.getSyncSnapshot();
          const initialized = await this.vault.initialize({ datasetId: snapshot.identity.datasetId, secrets: snapshot.secureConfig, password });
          nextRecoveryCode = initialized.recoveryCode;
        } else if (!hasRemoteVault) await this.vault.unlock({ password, recoveryCode });
        this.#publish({ syncUpstream: true });
        const status = await this.#startSync("unlock-vault", { password, recoveryCode });
        if (status.errorCode) throw new Error(status.errorCode);
        return { ok: true, recoveryCode: nextRecoveryCode, status: this.status() };
      } finally { releaseControlOperation(); }
    }
    const result = await this.vault.unlock({ password, recoveryCode });
    this.#publish({ error: "", errorCode: "" });
    return { ok: true, ...result, status: this.status() };
  }

  async #runSync(reason, options = {}) {
    // 中文：这是一个已经取得管理器同步槽位的完整轮次；所有账本和 manifest 写入都在此轮次内完成。
    // English: This is a complete manager-owned round; all ledger and manifest writes happen
    // inside this exclusively coordinated round.
    try {
      // 中文：每次真正开始的同步都重新创建 Provider/Engine，读取最新凭据和本地 vault 状态。
      // English: Recreate the provider/engine for each actual round so it reads the latest
      // credential and local vault state.
      // A new or reconnecting updated device must never write v1 once this
      // dataset has a committed v2 release, even if its local profile is old.
      if(this.state.syncFormat!==2) {
        const existingV2=await this.#makeEngine(this.#provider(undefined,2),2).inspectCommittedSet();
        if(existingV2.latest) this.#publish({syncFormat:2,releaseTag:'cherry-sync-v2'});
      }
      const provider = this.#provider();
      this.engine = this.#makeEngine(provider);
      const result = await this.engine.sync(reason, { syncUpstream: Boolean(this.state.account && this.state.syncUpstream !== false), ...options });
      this.#publish({ ...result, enabled: this.state.enabled, retryAt: "", retryFailures: 0 });
      await this.#checkLegacyUpdates();
      return this.status();
    } catch (error) {
      const engineStatus = this.engine?.status() || {};
      const failures = Number(this.state.retryFailures || 0) + 1;
      const capacityRetry = String(error?.message || "") === "sync_asset_count_limit" ? Number(error.retryAt) : 0;
      const retryAt = capacityRetry > Date.now() ? capacityRetry : githubRetryAt(error, Date.now(), failures);
      const detail = retryAt
        ? `${capacityRetry ? "云备份附件数量较多，等待保留期后整理" : "GitHub 暂时不可用，已暂停重试"}；将在 ${new Date(retryAt).toLocaleString("zh-CN", { timeZone: "Asia/Hong_Kong", hour12: false })}（UTC+8）后重试。本机待同步数据已保留。`
        : String(error?.message || error);
      this.#publish({ state: engineStatus.state || "ERROR_RECOVERABLE", errorCode: engineStatus.errorCode || String(error?.message || error), error: detail, lastAttemptAt: new Date().toISOString(), retryAt: retryAt ? new Date(retryAt).toISOString() : "", retryFailures: retryAt ? failures : 0 });
      if (retryAt) this.#schedule();
      throw error;
    }
  }

  #startSync(reason, options = {}, { allowDuringUpdate = false } = {}) {
    // 中文：同一轮的手动、定时、配置变更和更新前调用共享同一个 Promise；首个调用的 reason/options
    // 决定实际执行，加入者得到完全相同的成功状态或失败结果，不会启动第二个 Engine。
    // English: Manual, scheduled, config-change, and before-update calls in one round share one
    // Promise. The first call owns reason/options; joiners receive the exact same outcome and
    // never start another engine.
    if (this.#updatePaused && !allowDuringUpdate) return Promise.reject(new Error("sync_paused_for_update"));
    if (this.#syncInFlight) return this.#syncInFlight;
    if (!this.state.account) return Promise.reject(new Error("github_auth_required"));
    if ((Date.parse(this.state.retryAt) || 0) > Date.now()) {
      if (this.state.errorCode === "sync_asset_count_limit") {
        const error = new Error("sync_asset_count_limit");
        error.retryAt = Date.parse(this.state.retryAt);
        return Promise.reject(error);
      }
      return Promise.reject(new GitHubProviderError("github_sync_backoff", this.state.error || "GitHub sync is waiting before retrying", { rateReset: String(Math.ceil(Date.parse(this.state.retryAt) / 1000)) }));
    }

    const round = this.#runSync(reason, options);
    const coordinated = round.finally(() => {
      // 中文：仅清理当前轮次，避免旧轮次的 finally 误清理新轮次的协调槽位。
      // English: Clear only this round so an older finally handler cannot release a newer round.
      if (this.#syncInFlight === coordinated) this.#syncInFlight = null;
    });
    this.#syncInFlight = coordinated;
    return coordinated;
  }

  syncNow(reason = "manual", options = {}) {
    if (this.#updatePaused) return Promise.reject(new Error("sync_paused_for_update"));
    return this.#startSync(reason, options);
  }

  async previewFormatMigration() {
    if (this.#updatePaused) throw new Error('sync_paused_for_update');
    const release = this.#acquireControlOperation();
    try {
      if (this.#syncInFlight) await this.#syncInFlight;
      const provider = this.#provider(undefined,1);
      const legacy = this.#makeEngine(provider,1);
      const snapshot = await legacy.previewCommittedSet(this.source.getSyncSnapshot().identity.datasetId);
      const token = crypto.randomUUID();
      const local = stableJson(this.source.getSyncSnapshot().publicConfig);
      this.formatPreview = {token,snapshot,local,createdAt:Date.now()};
      const branches = snapshot.branches;
      const routes = [...new Set(branches.flatMap(b => b.remoteConfig?.providers || b.remoteMetadata?.providers || []).map(p => p.name || p.id))];
      return {token,format:this.state.syncFormat || 1,commits:snapshot.fingerprints.length,routeNames:routes,events:snapshot.usages.reduce((n,p)=>n+(p.events?.length || 0),0),includesSettings:branches.some(b=>b.remoteConfig),includesKeyOrder:branches.some(b=>b.remoteConfig?.clientKeyOrder || b.remoteMetadata?.clientKeyOrder)};
    } finally {release();}
  }

  async applyFormatMigration({token,password='',recoveryCode='',allDevicesUpgraded=false} = {}) {
    if (this.#updatePaused) throw new Error('sync_paused_for_update');
    const release = this.#acquireControlOperation();
    try {
      if (this.#syncInFlight) await this.#syncInFlight;
      const preview = this.formatPreview;
      if (!preview || preview.token!==token || Date.now()-preview.createdAt>10*60*1000) throw new Error('sync_migration_preview_expired');
      if (this.state.syncFormat!==2 && !allDevicesUpgraded) throw new Error('sync_all_devices_upgrade_required');
      const legacy = this.#makeEngine(this.#provider(undefined,1),1);
      const current = await legacy.inspectCommittedSet();
      if (stableJson(current.fingerprints)!==stableJson(preview.snapshot.fingerprints) || stableJson(this.source.getSyncSnapshot().publicConfig)!==preview.local) {
        this.formatPreview=null;throw new Error('sync_migration_preview_changed');
      }
      const datasetId=this.source.getSyncSnapshot().identity.datasetId;
      const authenticated=[];
      for (const branch of preview.snapshot.branches) {
        let secrets=null;
        if (branch.remoteConfig?.providers?.length) {
          if(!branch.remoteVault) throw new Error('sync_remote_vault_missing');
          secrets=await this.vault.authenticateEnvelope(branch.remoteVault,{password,recoveryCode,datasetId});
          for(const route of branch.remoteConfig.providers) if(!secrets?.providers?.some(p=>p.id===route.id && p.apiKey && p.baseUrl)) throw new Error('sync_remote_vault_incomplete');
        }
        if (branch.remoteConfig) this.source.mergeConfigFromSync(branch.remoteConfig,secrets || {schemaVersion:1,datasetId,providers:[]},{validateOnly:true,tombstones:branch.tombstones});
        authenticated.push({branch,secrets});
      }
      // Recheck after the potentially expensive credential validation, before any commit.
      const before = await legacy.inspectCommittedSet();
      if(stableJson(before.fingerprints)!==stableJson(current.fingerprints) || stableJson(this.source.getSyncSnapshot().publicConfig)!==preview.local) {this.formatPreview=null;throw new Error('sync_migration_preview_changed');}
      if(typeof this.source.createSyncMigrationBackup!=='function') throw new Error('sync_migration_backup_unavailable');
      const backup = this.source.createSyncMigrationBackup();
      for (const file of [this.stateFile,this.vault.vaultFile,this.vault.localKeyFile,this.credentialFile]) if(fs.existsSync(file)) fs.copyFileSync(file,path.join(backup,path.basename(file)));
      let recovery = '';
      if (!this.vault.status().unlocked) {
        const existing = authenticated.find(item => item.branch.remoteVault);
        if (existing) await this.vault.importEnvelope(existing.branch.remoteVault,{password,recoveryCode,expectedDatasetId:datasetId});
        else if (this.vault.status().initialized) await this.vault.unlock({password,recoveryCode});
        else if (this.state.syncUpstream !== false) {
          const initialized = await this.vault.initialize({datasetId,secrets:this.source.getSyncSnapshot().secureConfig,password});
          recovery = initialized.recoveryCode;
        }
      }
      for (const {branch,secrets} of authenticated) {
        if(branch.remoteConfig) this.source.mergeConfigFromSync(branch.remoteConfig,secrets || {schemaVersion:1,datasetId,providers:[]},{tombstones:branch.tombstones});
        else if(branch.remoteMetadata) this.source.mergeClientMetadataFromSync(branch.remoteMetadata,{tombstones:branch.tombstones});
      }
      for (const payload of preview.snapshot.usages) this.source.mergeRemoteUsage(payload);
      atomicJson(this.migrationSeedFile,{datasetId,events:[...new Map(preview.snapshot.usages.flatMap(payload=>payload.events || []).map(event=>[event.eventId || event.id,event])).values()]});
      this.#publish({syncFormat:2,releaseTag:'cherry-sync-v2',v2SeedPending:true,legacyPending:true,warning:'sync_v2_migration_pending',migrationBackup:backup});
      this.formatPreview=null;
      const provider=this.#provider(undefined,2);await provider.ensureReady();
      this.engine=this.#makeEngine(provider,2);
      const result=await this.engine.sync('format-v2-migration',{syncUpstream:this.state.syncUpstream !== false,password,recoveryCode});
      if(result.errorCode || result.warning==='sync_vault_unavailable_usage_only') throw new Error(result.errorCode || 'vault_unlock_required');
      const processed=[...new Set([...(this.state.legacyProcessed || []),...current.fingerprints])];
      this.#publish({...result,syncFormat:2,v2SeedPending:false,legacyProcessed:processed,legacyPending:false,warning:''});
      await this.#checkLegacyUpdates();
      this.#schedule();
      return {ok:true,status:this.status(),backup,recoveryCode:recovery};
    } catch(error) {
      if(this.state.syncFormat===2) this.#publish({state:'ERROR_RECOVERABLE',legacyPending:true,errorCode:String(error.message),error:String(error.message),warning:'sync_v2_migration_pending'});
      throw error;
    } finally {release();}
  }

  async #checkLegacyUpdates() {
    if(this.state.syncFormat!==2) return;
    try {
      const result=await this.#makeEngine(this.#provider(undefined,1),1).inspectCommittedSet();
      const processed=new Set(this.state.legacyProcessed || []);
      const pending=result.fingerprints.some(id=>!processed.has(id));
      this.#publish({legacyPending:pending || this.state.v2SeedPending,warning:pending?'sync_legacy_updates_pending':this.state.v2SeedPending?'sync_v2_migration_pending':/^sync_legacy_/.test(this.state.warning)?'':this.state.warning,...(pending?{state:'DIRTY'}:{})});
    } catch {this.#publish({legacyPending:true,warning:'sync_legacy_check_failed',state:'DIRTY'});}
  }

  async pauseForUpdate({ signal, tolerateSyncError = () => false } = {}) {
    // 中文：先封锁新触发并撤销定时器，再等待已有轮次完成，避免更新和同步并行读写。
    // English: Block new triggers and clear the timer before waiting for the active round, so an
    // update cannot overlap synchronization reads or writes.
    this.#updatePaused = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      this.notify(this.status());
      if (this.#controlInFlight) await withAbort(this.#controlInFlight, signal);
      if (this.#syncInFlight) {
        try { await withAbort(this.#syncInFlight, signal); }
        catch (error) {
          // The round has settled. Only an updater-owned, transient network failure may
          // proceed to local backup; cancellation and data-integrity failures still stop it.
          if (signal?.aborted || !tolerateSyncError(error)) throw error;
        }
      }
      if (signal?.aborted) throw abortError(signal);
      return this.status();
    } catch (error) {
      this.resumeAfterUpdate();
      throw error;
    }
  }

  async syncBeforeUpdate({ signal, retainPauseOnFailure = false } = {}) {
    // 中文：更新专用最后一轮可在暂停态运行；失败或取消会自动恢复定时同步，成功则保持暂停，
    // 由更新流程结束/取消时调用 resumeAfterUpdate。
    // English: Run the update-only final round while paused. Failure or cancellation restores
    // scheduled sync; success stays paused until the update flow calls resumeAfterUpdate.
    if (signal?.aborted) throw abortError(signal);
    try {
      await withAbort(this.pauseForUpdate(), signal);
      const finalSync = this.state.account
        ? this.#startSync("before-update", {}, { allowDuringUpdate: true })
        : Promise.resolve(this.status());
      const status = await withAbort(finalSync, signal);
      if (signal) {
        this.#clearUpdateAbortWatch();
        this.#updateAbortSignal = signal;
        this.#updateAbortListener = () => this.resumeAfterUpdate();
        signal.addEventListener("abort", this.#updateAbortListener, { once: true });
        if (signal.aborted) this.resumeAfterUpdate();
      }
      return status;
    } catch (error) {
      if (!retainPauseOnFailure || signal?.aborted) this.resumeAfterUpdate();
      throw error;
    }
  }

  resumeAfterUpdate() {
    // 中文：恢复普通触发并按原有启用状态重建定时器；outbox 未提交项由下轮继续处理。
    // English: Re-enable normal triggers and recreate the timer when sync is enabled; the next
    // round will continue any durable outbox entries that were not committed.
    this.#clearUpdateAbortWatch();
    this.#updatePaused = false;
    this.#schedule();
    if (!this.state.enabled) this.notify(this.status());
    return this.status();
  }

  #clearUpdateAbortWatch() {
    this.#updateAbortSignal?.removeEventListener("abort", this.#updateAbortListener);
    this.#updateAbortSignal = null;
    this.#updateAbortListener = null;
  }

  #acquireControlOperation() {
    // 中文：连接和冲突处理包含 ensureReady、vault 写入和配置写入，不能只保护最后一次 engine.sync。
    // English: Connect and conflict resolution include provider inspection, vault writes, and
    // config writes; protecting only the final engine.sync would leave a data-race window.
    if (this.#controlInFlight) throw new Error("sync_control_operation_in_flight");
    let release;
    const operation = new Promise((resolve) => { release = resolve; });
    this.#controlInFlight = operation;
    return () => {
      if (this.#controlInFlight === operation) this.#controlInFlight = null;
      release();
    };
  }

  async resolveConflict({ choice, password = "", recoveryCode = "" } = {}) {
    if (typeof this.source.mergeConfigFromSync === "function") {
      if (password || recoveryCode) return this.unlockVault({ password, recoveryCode });
      return { ok: true, status: await this.syncNow("automatic-merge") };
    }
    // 中文：只有明确选择“本地”时才准备本机 vault；选择“远端”由 engine 先认证远端 vault。
    // English: Prepare the local vault only for an explicit local choice; a remote choice lets
    // the engine authenticate the remote vault first.
    if (!this.state.account) throw new Error("github_auth_required");
    if (this.#updatePaused) throw new Error("sync_paused_for_update");
    const releaseControlOperation = this.#acquireControlOperation();
    try {
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
    if (this.#syncInFlight) await this.#syncInFlight;
    const result = await this.#startSync("resolve-conflict", {
      configPolicy: String(choice),
      password: String(password),
      recoveryCode: String(recoveryCode),
    }, { allowDuringUpdate: true });
    this.#publish({ ...result, enabled: this.state.enabled, error: "", errorCode: "" });
    this.#schedule();
    return { ok: true, recoveryCode: nextRecoveryCode, status: this.status() };
    } finally {
      releaseControlOperation();
    }
  }

  async setEnabled(enabled) {
    if (this.#updatePaused) throw new Error("sync_paused_for_update");
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
    if (this.#updatePaused) throw new Error("sync_paused_for_update");
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

export const syncIntervalMinutes = 1;
