/**
 * 中文：不可变 Release Asset + manifest-last 同步引擎。
 *
 * 本引擎只负责同步顺序和并发安全，不实现加密。敏感配置的加密/解密必须经过
 * LocalVaultStore → sync-crypto.mjs；本引擎只把已经认证的 vault envelope 当作一个
 * 不透明资产上传，或把远端资产交给 LocalVaultStore 验证后再交给 source。发布新
 * manifest 前，所有候选资产都会先上传并重新下载校验；manifest 永远最后写入。
 * 这样即使上传中断，也不会产生一个指向不完整加密数据的“已提交”版本。
 *
 * English: Immutable Release Asset + manifest-last synchronization engine.
 *
 * This engine owns ordering and concurrency, not cryptography. Sensitive configuration must
 * pass through LocalVaultStore -> sync-crypto.mjs. The engine treats an authenticated vault
 * envelope as an opaque asset and only hands remote bytes to LocalVaultStore for validation.
 * Every candidate asset is uploaded and downloaded for verification before the manifest is
 * committed last. An interrupted upload therefore cannot publish a committed generation that
 * points at incomplete encrypted data.
 */
import {
  SYNC_FORMAT,
  SYNC_PRODUCT_VERSION,
  SYNC_SCHEMA_VERSION,
  assetDescriptor,
  gzipJson,
  gzipJsonLines,
  isManifestAssetName,
  jsonBuffer,
  manifestName,
  parseCompressedJson,
  parseCompressedJsonLines,
  randomId,
  sha256,
  stableJson,
  syncAssetTag,
  validateManifest,
  verifyAsset,
} from "./sync-common.mjs";

const MAX_SYNC_ATTEMPTS = 3;
const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;
const WARN_ASSET_COUNT = 800;
const STOP_ASSET_COUNT = 900;
const KEEP_GENERATIONS = 4;

function publicErrorCode(error) {
  // 中文：只把可安全展示给界面的类别返回出去；底层 token、密码学细节和网络堆栈不外泄。
  // English: Expose only safe UI categories; never leak tokens, cryptographic details, or stacks.
  const explicit = String(error?.code || error?.message || "");
  if (/401|auth/i.test(explicit)) return "AUTH_REQUIRED";
  if (/429|rate/i.test(explicit)) return "PENDING_NETWORK";
  if (/timeout|ECONN|ENOTFOUND|network|offline|reset/i.test(explicit)) return "PENDING_NETWORK";
  if (/dataset|schema|reader_too_old|writer_too_old|tamper/i.test(explicit)) return "ERROR_FATAL";
  if (/conflict|parent_changed|409|412/i.test(explicit)) return "CONFLICT";
  return "ERROR_RECOVERABLE";
}

function isVaultUnavailable(error) {
  // 中文：保险库暂时不可用时仍允许用量同步，但不能伪造一个新的空 vault。
  // English: Usage sync may continue while the vault is unavailable, but a new empty vault must
  // never be fabricated in its place.
  const code = String(error?.code || error?.message || "");
  return code === "vault_local_key_unavailable" || code === "vault_unlock_required";
}

function monthOf(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "197001" : `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function usageAssets(events, assetTag) {
  const grouped = new Map();
  for (const event of events) {
    const key = `${event.deviceId}|${event.deviceEpoch}|${monthOf(event.at)}`;
    const values = grouped.get(key) || [];
    values.push(event);
    grouped.set(key, values);
  }
  const assets = [];
  for (const [key, values] of grouped) {
    const [deviceId, deviceEpoch, month] = key.split("|");
    values.sort((left, right) => Number(left.sequence) - Number(right.sequence));
    for (let index = 0; index < values.length; index += 2000) {
      const chunk = values.slice(index, index + 2000);
      const bytes = gzipJsonLines(chunk);
      const first = String(chunk[0].sequence).padStart(6, "0");
      const last = String(chunk.at(-1).sequence).padStart(6, "0");
      const name = `usage-${deviceId}-e${deviceEpoch}-${month}-s${first}-e${last}-${assetTag}.jsonl.gz`;
      assets.push({ descriptor: assetDescriptor("usage-segment", name, bytes), bytes, eventIds: chunk.map((item) => item.eventId || item.id) });
    }
  }
  return assets;
}

async function readLatestManifest(provider, expectedDatasetId = "", assetCatalog = null) {
  // 中文：候选 manifest 必须逐个下载、解析、验证，损坏的最新候选不能遮蔽更早的完整代。
  // English: Download, parse, and validate every candidate. A damaged newest candidate must not
  // hide an earlier complete generation.
  const assets = assetCatalog ?? await provider.listAssets();
  const candidates = [];
  let datasetConflict = false;
  for (const asset of assets.filter((item) => isManifestAssetName(item.name))) {
    try {
      const bytes = await provider.downloadAsset(asset);
      const manifest = validateManifest(JSON.parse(Buffer.from(bytes).toString("utf8")));
      if (expectedDatasetId && manifest.datasetId !== expectedDatasetId) { datasetConflict = true; continue; }
      candidates.push({ manifest, bytes: Buffer.from(bytes), asset });
    } catch (error) {
      // 中文：损坏或未提交的候选不能成为当前代，继续查看更早的完整代。
      // English: A damaged candidate cannot become current; fall back to an earlier committed generation.
    }
  }
  candidates.sort((left, right) => Number(right.manifest.generation) - Number(left.manifest.generation)
    || String(right.manifest.createdAtUtc || "").localeCompare(String(left.manifest.createdAtUtc || "")));
  if (candidates.length) return candidates[0];
  if (datasetConflict) throw new Error("sync_dataset_conflict");
  return null;
}

async function downloadAndVerify(provider, descriptor, assetCatalog = null) {
  // 中文：manifest 中的大小和哈希是资产进入业务层前的最低完整性门槛。
  // English: Manifest size and hash are the minimum integrity gate before an asset reaches the
  // synchronization logic.
  const assets = assetCatalog ?? await provider.listAssets();
  const asset = assets.find((item) => item.name === descriptor.assetName);
  if (!asset) throw new Error("sync_asset_missing");
  return verifyAsset(descriptor, await provider.downloadAsset(asset));
}

function sameRevision(left, right) {
  return Number(left?.counter || 0) === Number(right?.counter || 0) && String(left?.deviceId || "") === String(right?.deviceId || "");
}

function revisionOrder(local, remote) {
  if (sameRevision(local, remote)) return "equal";
  const localCounter = Number(local?.counter || 0);
  const remoteCounter = Number(remote?.counter || 0);
  if (localCounter > remoteCounter) return "local-newer";
  if (remoteCounter > localCounter) return "remote-newer";
  return "conflict";
}

export class SyncEngine {
  constructor({ provider, source, vault, onState = () => {}, now = () => new Date() }) {
    if (!provider || !source) throw new Error("sync_provider_and_source_required");
    this.provider = provider;
    this.source = source;
    this.vault = vault;
    this.onState = onState;
    this.now = now;
    this.running = null;
    this.state = { state: "IDLE", lastSyncAt: "", nextSyncAt: "", generation: 0, pendingCount: 0, warning: "", errorCode: "", error: "" };
  }

  emit(patch) {
    this.state = { ...this.state, ...patch };
    this.onState({ ...this.state });
    return this.state;
  }

  status() { return { ...this.state }; }

  inspectLatest() { return readLatestManifest(this.provider); }

  sync(reason = "manual", options = {}) {
    if (this.running) return this.running;
    this.running = this.#run(reason, options).finally(() => { this.running = null; });
    return this.running;
  }

  async #pullRemote(latest, datasetId, assetCatalog = null) {
    // 中文：用量明细先合并；配置公开索引与加密 vault 分开返回，确保“只同步用量”不触碰敏感配置。
    // English: Merge usage details independently; return public config and encrypted vault
    // separately so usage-only mode never touches sensitive configuration.
    if (!latest) return { remoteConfig: null, remoteVault: null, importedEvents: 0 };
    const summaryDescriptor = latest.manifest.files.find((item) => item.type === "summary");
    let counters = [];
    let tombstones = latest.manifest.tombstones || [];
    if (summaryDescriptor) {
      const summary = parseCompressedJson(await downloadAndVerify(this.provider, summaryDescriptor, assetCatalog));
      if (summary.datasetId !== datasetId) throw new Error("sync_dataset_conflict");
      counters = Array.isArray(summary.counters) ? summary.counters : [];
      tombstones = Array.isArray(summary.tombstones) ? summary.tombstones : tombstones;
    }
    const events = [];
    let totalCompressed = 0;
    for (const descriptor of latest.manifest.files.filter((item) => item.type === "usage-segment")) {
      totalCompressed += descriptor.size;
      if (totalCompressed > 512 * 1024 * 1024) throw new Error("sync_restore_size_limit");
      events.push(...parseCompressedJsonLines(await downloadAndVerify(this.provider, descriptor, assetCatalog)));
    }
    if (events.length || counters.length || tombstones.length) this.source.mergeRemoteUsage({ datasetId, events, counters, tombstones });
    const configDescriptor = latest.manifest.files.find((item) => item.type === "config");
    const vaultDescriptor = latest.manifest.files.find((item) => item.type === "vault");
    return {
      remoteConfig: configDescriptor ? parseCompressedJson(await downloadAndVerify(this.provider, configDescriptor, assetCatalog)) : null,
      remoteVault: vaultDescriptor ? await downloadAndVerify(this.provider, vaultDescriptor, assetCatalog) : null,
      tombstones,
      importedEvents: events.length,
    };
  }

  async #run(reason, options = {}) {
    const syncUpstream = options.syncUpstream !== false;
    const startedAtUtc = this.now().toISOString();
    const syncId = randomId("sync");
    this.emit({ state: "SYNCING", reason, errorCode: "", error: "", startedAtUtc });
    this.source.recordSyncRun?.({ syncId, state: "SYNCING", startedAtUtc, summary: reason });
    try {
      await this.provider.ensureReady?.();
      for (let attempt = 1; attempt <= MAX_SYNC_ATTEMPTS; attempt += 1) {
        // 中文：每次重试都重新读取本地和远端状态，避免在并发写入后继续使用过期 snapshot。
        // English: Re-read local and remote state on every retry so a concurrent write cannot
        // make the next manifest use a stale snapshot.
        let initial = this.source.getSyncSnapshot();
        let datasetId = initial.identity.datasetId;
        const initialAssetCatalog = await this.provider.listAssets();
        let latest = await readLatestManifest(this.provider, "", initialAssetCatalog);
        if (latest && latest.manifest.datasetId !== datasetId) {
          if (!options.adoptRemoteIfPristine || !this.source.canAdoptSyncDataset?.()) throw new Error("sync_dataset_conflict");
          this.source.adoptSyncDataset(latest.manifest.datasetId);
          initial = this.source.getSyncSnapshot();
          datasetId = initial.identity.datasetId;
        }
        const remote = await this.#pullRemote(latest, datasetId, initialAssetCatalog);
        let snapshot = this.source.getSyncSnapshot();
        const configOrder = remote.remoteConfig
          ? revisionOrder(snapshot.publicConfig.configRevision, remote.remoteConfig.configRevision)
          : "equal";
        let importedSecureConfig = null;
        let remoteConfigCommitted = false;
        if (syncUpstream && options.configPolicy === "remote" && remote.remoteVault && this.vault) {
          // 中文：远端 vault 必须先由专用加密存储层完成密码学验证，验证失败立即停止恢复，
          // 不允许把远端内容当作普通 JSON 或空配置写入本机。
          // English: The dedicated vault layer must authenticate the remote vault first. A
          // failure stops restore immediately; remote bytes are never treated as plain JSON or
          // replaced with an empty local configuration.
          const replaceOptions = {
            // 中文：远端缺少本机独有 Key 不代表删除；只有同步协议中的明确 tombstone
            // 才能删除该元数据。冲突策略仍由 configPolicy 的显式选择决定。
            // English: An omitted device-local key is not a deletion; only an explicit protocol
            // tombstone may delete its metadata. Conflict choice remains explicit in configPolicy.
            allowGenerateClientSecrets: options.allowGenerateClientSecrets === true,
            tombstones: remote.tombstones,
          };
          const shouldCommitConfigWithVault = Boolean(remote.remoteConfig
            && configOrder !== "equal"
            && typeof this.source.replaceConfigFromSync === "function");
          const imported = await this.vault.importEnvelope(remote.remoteVault, {
            password: String(options.password || ""),
            recoveryCode: String(options.recoveryCode || ""),
            expectedDatasetId: datasetId,
            // 中文：先完成完整配置校验，再让 LocalVaultStore 提交 vault；Key 元数据异常时
            // 不会留下“新 vault + 旧 config”。没有该可选接口的旧 source 仍保持原协议行为。
            // English: Validate the complete configuration before LocalVaultStore commits the
            // vault, so invalid key metadata cannot leave a new vault beside an old config.
            beforeCommit: remote.remoteConfig && typeof this.source.validateConfigFromSync === "function"
              ? ({ secrets }) => this.source.validateConfigFromSync(remote.remoteConfig, secrets, replaceOptions)
              : undefined,
            // 中文：把公开配置写入纳入 vault/DEK 提交边界；配置写入失败时由存储层恢复
            // 原 vault 与 DEK，避免跨文件半提交。
            // English: Include public config persistence in the vault/DEK commit boundary; the
            // store restores the old vault and DEK if config persistence fails.
            commitConfig: shouldCommitConfigWithVault
              ? ({ secrets }) => {
                this.source.replaceConfigFromSync(remote.remoteConfig, secrets, replaceOptions);
                remoteConfigCommitted = true;
              }
              : undefined,
          });
          importedSecureConfig = imported.secrets;
        }
        if (remote.remoteConfig && configOrder !== "equal") {
          if (syncUpstream && options.configPolicy === "remote") {
            let secureConfig = { schemaVersion: 1, datasetId, providers: [] };
            if ((remote.remoteConfig.providers || []).length) {
              if (!importedSecureConfig) throw new Error("sync_remote_vault_missing");
              secureConfig = importedSecureConfig;
            }
            if (!remoteConfigCommitted) this.source.replaceConfigFromSync?.(remote.remoteConfig, secureConfig, {
              // 中文：只有全新设备首次采用远端数据集时才允许创建本机客户端 Key。
              // English: Only a pristine device adopting its first remote dataset may create local client keys.
              allowGenerateClientSecrets: options.allowGenerateClientSecrets === true,
              tombstones: remote.tombstones,
            });
            snapshot = this.source.getSyncSnapshot();
          } else if (options.configPolicy === "local" || configOrder === "local-newer") {
            if (options.configPolicy === "local" && configOrder !== "local-newer") this.source.bumpConfigRevisionForSync?.();
            snapshot = this.source.getSyncSnapshot();
          } else if (!syncUpstream || !remote.remoteVault) {
            // 中文：未开启中转站 API 同步时只合并用量，不能把云端敏感配置拉入本机。
            // English: Usage-only mode never restores upstream configuration locally.
          } else {
            throw new Error("sync_config_conflict");
          }
        }
        const assetsBefore = await this.provider.listAssets();
        if (assetsBefore.length >= STOP_ASSET_COUNT) {
          await this.collectGarbage();
          if ((await this.provider.listAssets({ refresh: true })).length >= STOP_ASSET_COUNT) throw new Error("sync_asset_count_limit");
        }
        const parent = latest?.manifest || null;
        let currentVault = null;
        let vaultWarning = "";
        if (syncUpstream && this.vault) {
          try {
            currentVault = await this.vault.getEnvelope(snapshot.secureConfig, datasetId);
          } catch (error) {
            if (!isVaultUnavailable(error)) throw error;
            // 中文：用量记录本身不含上游 Key，不应因为本地保险库暂时无法解锁而整体停止。
            // 保留父代的 config/vault 资产，避免把云端已有的加密配置从新 manifest 中丢掉。
            // English: Usage records contain no upstream keys and must not stop when the local vault is
            // temporarily unavailable. Preserve parent config/vault assets so a new manifest never
            // drops the last valid encrypted configuration.
            vaultWarning = "sync_vault_unavailable_usage_only";
          }
        }
        const keepRemoteConfig = Boolean(parent && (!syncUpstream || vaultWarning));
        // 中文：本机 vault 暂不可用时继承远端 config/vault 描述，保证用量新 manifest 不会
        // 把云端已有的加密配置从文件列表中删除。
        // English: When the local vault is unavailable, inherit the remote config/vault entries
        // so a usage-only generation never removes the last valid encrypted configuration.
        const effectivePublicConfig = keepRemoteConfig && remote.remoteConfig
          ? remote.remoteConfig
          : snapshot.publicConfig;
        const noLocalChanges = snapshot.events.length === 0
          && parent
          && sameRevision(parent.configRevision, effectivePublicConfig.configRevision)
          && (keepRemoteConfig || Number(parent.vaultRevision || 0) === Number(currentVault?.vaultRevision || 0));
        if (noLocalChanges) {
          const finishedAtUtc = this.now().toISOString();
          this.source.recordSyncRun?.({ syncId, state: "IDLE", generation: parent.generation, startedAtUtc, finishedAtUtc, summary: `no-op:${reason}` });
          return this.emit({ state: "IDLE", generation: parent.generation, pendingCount: 0, lastSyncAt: finishedAtUtc, warning: vaultWarning || (assetsBefore.length >= WARN_ASSET_COUNT ? "sync_asset_count_warning" : "") });
        }

        const generation = Number(parent?.generation || 0) + 1;
        const generatedAt = this.now();
        const generatedAtUtc = generatedAt.toISOString();
        const assetTag = syncAssetTag(syncId, generatedAt);
        const summaryBytes = gzipJson({
          format: SYNC_FORMAT,
          schemaVersion: SYNC_SCHEMA_VERSION,
          datasetId,
          generatedAtUtc,
          counters: snapshot.counters,
          tombstones: snapshot.tombstones,
        });
        const candidates = [
          { descriptor: assetDescriptor("summary", `summary-${assetTag}.json.gz`, summaryBytes), bytes: summaryBytes, eventIds: [] },
          ...usageAssets(snapshot.events, assetTag),
        ];
        if (currentVault) {
          const configBytes = gzipJson({
            format: SYNC_FORMAT,
            schemaVersion: SYNC_SCHEMA_VERSION,
            datasetId,
            ...snapshot.publicConfig,
          });
          candidates.splice(1, 0, { descriptor: assetDescriptor("config", `config-${assetTag}.json.gz`, configBytes), bytes: configBytes, eventIds: [] });
          const bytes = jsonBuffer(currentVault);
          candidates.push({ descriptor: assetDescriptor("vault", `vault-${assetTag}.enc`, bytes), bytes, eventIds: [] });
        }
        const inherited = (parent?.files || []).filter((item) => item.type === "usage-segment"
          || (keepRemoteConfig && (item.type === "config" || item.type === "vault")));

        // 中文：提交前必须强制刷新远端清单，继续保留并发写入检测；普通读取则复用本轮缓存。
        // English: Force a fresh catalog before commit to preserve concurrent-write detection;
        // ordinary reads reuse the round-local cache.
        const commitAssetCatalog = await this.provider.listAssets({ refresh: true });
        latest = await readLatestManifest(this.provider, datasetId, commitAssetCatalog);
        if (Number(latest?.manifest?.generation || 0) !== Number(parent?.generation || 0)
          || String(latest ? sha256(latest.bytes) : "") !== String(latest && parent ? sha256(jsonBuffer(parent)) : "")) {
          if (attempt < MAX_SYNC_ATTEMPTS) continue;
          throw new Error("sync_parent_changed");
        }

        for (const candidate of candidates) {
          // 中文：Provider 工作保持串行，避免同步轮次与更新/冲突协调发生竞态；上传响应
          // 已直接用于校验，省去一次资产清单查询。
          // English: Keep provider work serialized to preserve update/conflict coordination;
          // verify the upload response directly to avoid another full asset-catalog query.
          const uploadedAsset = await this.provider.uploadAsset(candidate.descriptor.assetName, candidate.bytes, candidate.descriptor.type);
          if (uploadedAsset && Number.isSafeInteger(Number(uploadedAsset.id))) {
            verifyAsset(candidate.descriptor, await this.provider.downloadAsset(uploadedAsset));
          } else {
            // 中文：兼容旧 Provider；新 Provider 返回资产 ID 后不再重复查询整张清单。
            // English: Keep compatibility with older providers; new providers verify by returned ID.
            await downloadAndVerify(this.provider, candidate.descriptor);
          }
        }
        const manifest = {
          format: SYNC_FORMAT,
          schemaVersion: SYNC_SCHEMA_VERSION,
          minReaderVersion: SYNC_PRODUCT_VERSION,
          minWriterVersion: SYNC_PRODUCT_VERSION,
          datasetId,
          syncId,
          generation,
          parentGeneration: Number(parent?.generation || 0),
          parentManifestSha256: latest ? sha256(latest.bytes) : "",
          writerDeviceId: snapshot.identity.deviceId,
          writerDeviceEpoch: snapshot.identity.deviceEpoch,
          createdAtUtc: generatedAtUtc,
          displayTimezone: "Asia/Shanghai",
          state: "committed",
          configRevision: effectivePublicConfig.configRevision,
          keyEpoch: Number(currentVault?.keyEpoch || parent?.keyEpoch || 0),
          vaultRevision: Number(currentVault?.vaultRevision || parent?.vaultRevision || 0),
          files: [...inherited, ...candidates.map((item) => item.descriptor)],
          tombstones: snapshot.tombstones,
          retention: { localDetailCacheBytes: 50 * 1024 ** 2, localDetailTargetBytes: 45 * 1024 ** 2, prunedBeforeUtc: null },
        };
        const manifestBytes = jsonBuffer(manifest);
        const name = manifestName(syncId, generatedAt);
        const uploadedManifestResult = await this.provider.uploadAsset(name, manifestBytes, "manifest");
        const uploadedManifest = uploadedManifestResult && Number.isSafeInteger(Number(uploadedManifestResult.id))
          ? uploadedManifestResult
          : (await this.provider.listAssets()).find((item) => item.name === name);
        if (!uploadedManifest) throw new Error("sync_manifest_missing_after_upload");
        validateManifest(JSON.parse(Buffer.from(await this.provider.downloadAsset(uploadedManifest)).toString("utf8")), datasetId);
        // 中文：manifest-last 是提交点；从这里开始，这一代才对其他设备可见。
        // English: Manifest-last is the commit point; only after this line is the generation
        // visible as committed to other devices.
        const eventIds = candidates.flatMap((item) => item.eventIds);
        this.source.markSyncEvents(eventIds);
        const finishedAtUtc = this.now().toISOString();
        this.source.recordSyncRun?.({ syncId, state: "IDLE", generation, startedAtUtc, finishedAtUtc, summary: `${reason}: ${eventIds.length} event(s)` });
        this.emit({ state: "IDLE", generation, pendingCount: 0, lastSyncAt: finishedAtUtc, warning: vaultWarning || (assetsBefore.length >= WARN_ASSET_COUNT ? "sync_asset_count_warning" : ""), errorCode: "", error: "" });
        await this.collectGarbage().catch(() => {});
        return this.status();
      }
      throw new Error("sync_attempts_exhausted");
    } catch (error) {
      const errorCode = publicErrorCode(error);
      const finishedAtUtc = this.now().toISOString();
      this.source.recordSyncRun?.({ syncId, state: errorCode, startedAtUtc, finishedAtUtc, errorCode: String(error?.message || error), summary: reason });
      this.emit({ state: errorCode, errorCode: String(error?.message || error), error: String(error?.message || error), lastAttemptAt: finishedAtUtc });
      throw error;
    }
  }

  async collectGarbage() {
    const assets = await this.provider.listAssets();
    const manifests = [];
    for (const asset of assets.filter((item) => isManifestAssetName(item.name))) {
      try {
        const bytes = await this.provider.downloadAsset(asset);
        const manifest = validateManifest(JSON.parse(Buffer.from(bytes).toString("utf8")));
        manifests.push({ asset, manifest });
      } catch {
        // 中文：无效候选不能进入保留集合，后续按孤儿资产规则处理。
        // English: Invalid candidates are excluded from the retained set and handled as orphans
        // by the cleanup pass below.
      }
    }
    manifests.sort((left, right) => right.manifest.generation - left.manifest.generation);
    const retained = manifests.slice(0, KEEP_GENERATIONS);
    const marked = new Set(retained.map((item) => item.asset.name));
    for (const item of retained) for (const file of item.manifest.files) marked.add(file.assetName);
    const threshold = this.now().valueOf() - ORPHAN_GRACE_MS;
    let deleted = 0;
    for (const asset of assets) {
      const created = new Date(asset.createdAt || 0).valueOf();
      if (marked.has(asset.name) || !Number.isFinite(created) || created > threshold) continue;
      await this.provider.deleteAsset(asset);
      deleted += 1;
    }
    return { deleted, retainedGenerations: retained.map((item) => item.manifest.generation) };
  }
}

export { readLatestManifest };
