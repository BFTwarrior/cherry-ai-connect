/**
 * 中文：不可变 Release Asset + manifest-last 同步引擎。Provider 只是云端读写适配器。
 * English: Immutable Release-asset, manifest-last sync engine with a pluggable cloud provider.
 */
import {
  SYNC_FORMAT,
  SYNC_PRODUCT_VERSION,
  SYNC_SCHEMA_VERSION,
  assetDescriptor,
  gzipJson,
  gzipJsonLines,
  jsonBuffer,
  manifestName,
  parseCompressedJson,
  parseCompressedJsonLines,
  randomId,
  sha256,
  stableJson,
  validateManifest,
  verifyAsset,
} from "./sync-common.mjs";

const MAX_SYNC_ATTEMPTS = 3;
const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;
const WARN_ASSET_COUNT = 800;
const STOP_ASSET_COUNT = 900;
const KEEP_GENERATIONS = 4;

function publicErrorCode(error) {
  const explicit = String(error?.code || error?.message || "");
  if (/401|auth/i.test(explicit)) return "AUTH_REQUIRED";
  if (/429|rate/i.test(explicit)) return "PENDING_NETWORK";
  if (/timeout|ECONN|ENOTFOUND|network|offline|reset/i.test(explicit)) return "PENDING_NETWORK";
  if (/dataset|schema|reader_too_old|writer_too_old|tamper/i.test(explicit)) return "ERROR_FATAL";
  if (/conflict|parent_changed|409|412/i.test(explicit)) return "CONFLICT";
  return "ERROR_RECOVERABLE";
}

function monthOf(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "197001" : `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function usageAssets(events, generation, syncId) {
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
      const name = `usage-${deviceId}-e${deviceEpoch}-${month}-s${first}-e${last}-${syncId}.jsonl.gz`;
      assets.push({ descriptor: assetDescriptor("usage-segment", name, bytes), bytes, eventIds: chunk.map((item) => item.eventId || item.id) });
    }
  }
  return assets;
}

async function readLatestManifest(provider, expectedDatasetId = "") {
  const assets = await provider.listAssets();
  const candidates = assets
    .filter((asset) => /^manifest-g\d{6}-ssync_[0-9a-f-]{36}\.json$/i.test(asset.name))
    .sort((left, right) => right.name.localeCompare(left.name));
  for (const asset of candidates) {
    try {
      const bytes = await provider.downloadAsset(asset);
      const manifest = validateManifest(JSON.parse(Buffer.from(bytes).toString("utf8")), expectedDatasetId);
      return { manifest, bytes: Buffer.from(bytes), asset };
    } catch (error) {
      if (String(error?.message || "") === "sync_dataset_conflict") throw error;
      // 中文：损坏或未提交的候选不能成为当前代，继续查看更早的完整代。
      // English: A damaged candidate cannot become current; fall back to an earlier committed generation.
    }
  }
  return null;
}

async function downloadAndVerify(provider, descriptor) {
  const asset = (await provider.listAssets()).find((item) => item.name === descriptor.assetName);
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

  async #pullRemote(latest, datasetId) {
    if (!latest) return { remoteConfig: null, remoteVault: null, importedEvents: 0 };
    const summaryDescriptor = latest.manifest.files.find((item) => item.type === "summary");
    let counters = [];
    let tombstones = latest.manifest.tombstones || [];
    if (summaryDescriptor) {
      const summary = parseCompressedJson(await downloadAndVerify(this.provider, summaryDescriptor));
      if (summary.datasetId !== datasetId) throw new Error("sync_dataset_conflict");
      counters = Array.isArray(summary.counters) ? summary.counters : [];
      tombstones = Array.isArray(summary.tombstones) ? summary.tombstones : tombstones;
    }
    const events = [];
    let totalCompressed = 0;
    for (const descriptor of latest.manifest.files.filter((item) => item.type === "usage-segment")) {
      totalCompressed += descriptor.size;
      if (totalCompressed > 512 * 1024 * 1024) throw new Error("sync_restore_size_limit");
      events.push(...parseCompressedJsonLines(await downloadAndVerify(this.provider, descriptor)));
    }
    if (events.length || counters.length || tombstones.length) this.source.mergeRemoteUsage({ datasetId, events, counters, tombstones });
    const configDescriptor = latest.manifest.files.find((item) => item.type === "config");
    const vaultDescriptor = latest.manifest.files.find((item) => item.type === "vault");
    return {
      remoteConfig: configDescriptor ? parseCompressedJson(await downloadAndVerify(this.provider, configDescriptor)) : null,
      remoteVault: vaultDescriptor ? await downloadAndVerify(this.provider, vaultDescriptor) : null,
      importedEvents: events.length,
    };
  }

  async #run(reason, options = {}) {
    const startedAtUtc = this.now().toISOString();
    const syncId = randomId("sync");
    this.emit({ state: "SYNCING", reason, errorCode: "", error: "", startedAtUtc });
    this.source.recordSyncRun?.({ syncId, state: "SYNCING", startedAtUtc, summary: reason });
    try {
      await this.provider.ensureReady?.();
      for (let attempt = 1; attempt <= MAX_SYNC_ATTEMPTS; attempt += 1) {
        let initial = this.source.getSyncSnapshot();
        let datasetId = initial.identity.datasetId;
        let latest = await readLatestManifest(this.provider);
        if (latest && latest.manifest.datasetId !== datasetId) {
          if (!options.adoptRemoteIfPristine || !this.source.canAdoptSyncDataset?.()) throw new Error("sync_dataset_conflict");
          this.source.adoptSyncDataset(latest.manifest.datasetId);
          initial = this.source.getSyncSnapshot();
          datasetId = initial.identity.datasetId;
        }
        const remote = await this.#pullRemote(latest, datasetId);
        let snapshot = this.source.getSyncSnapshot();
        const configOrder = remote.remoteConfig
          ? revisionOrder(snapshot.publicConfig.configRevision, remote.remoteConfig.configRevision)
          : "equal";
        let importedSecureConfig = null;
        if (options.configPolicy === "remote" && remote.remoteVault && this.vault) {
          const imported = await this.vault.importEnvelope(remote.remoteVault, {
            password: String(options.password || ""),
            recoveryCode: String(options.recoveryCode || ""),
            expectedDatasetId: datasetId,
          });
          importedSecureConfig = imported.secrets;
        }
        if (remote.remoteConfig && configOrder !== "equal") {
          if (options.configPolicy === "remote") {
            let secureConfig = { schemaVersion: 1, datasetId, providers: [] };
            if ((remote.remoteConfig.providers || []).length) {
              if (!importedSecureConfig) throw new Error("sync_remote_vault_missing");
              secureConfig = importedSecureConfig;
            }
            this.source.replaceConfigFromSync?.(remote.remoteConfig, secureConfig);
            snapshot = this.source.getSyncSnapshot();
          } else if (options.configPolicy === "local" || configOrder === "local-newer") {
            if (options.configPolicy === "local" && configOrder !== "local-newer") this.source.bumpConfigRevisionForSync?.();
            snapshot = this.source.getSyncSnapshot();
          } else {
            throw new Error("sync_config_conflict");
          }
        }
        const assetsBefore = await this.provider.listAssets();
        if (assetsBefore.length >= STOP_ASSET_COUNT) {
          await this.collectGarbage();
          if ((await this.provider.listAssets()).length >= STOP_ASSET_COUNT) throw new Error("sync_asset_count_limit");
        }
        const parent = latest?.manifest || null;
        const currentVault = this.vault ? await this.vault.getEnvelope(snapshot.secureConfig, datasetId) : null;
        const noLocalChanges = snapshot.events.length === 0
          && parent
          && sameRevision(parent.configRevision, snapshot.publicConfig.configRevision)
          && Number(parent.vaultRevision || 0) === Number(currentVault?.vaultRevision || 0);
        if (noLocalChanges) {
          const finishedAtUtc = this.now().toISOString();
          this.source.recordSyncRun?.({ syncId, state: "IDLE", generation: parent.generation, startedAtUtc, finishedAtUtc, summary: `no-op:${reason}` });
          return this.emit({ state: "IDLE", generation: parent.generation, pendingCount: 0, lastSyncAt: finishedAtUtc, warning: assetsBefore.length >= WARN_ASSET_COUNT ? "sync_asset_count_warning" : "" });
        }

        const generation = Number(parent?.generation || 0) + 1;
        const generationTag = `g${String(generation).padStart(6, "0")}-s${syncId}`;
        const summaryBytes = gzipJson({
          format: SYNC_FORMAT,
          schemaVersion: SYNC_SCHEMA_VERSION,
          datasetId,
          generatedAtUtc: this.now().toISOString(),
          counters: snapshot.counters,
          tombstones: snapshot.tombstones,
        });
        const configBytes = gzipJson({
          format: SYNC_FORMAT,
          schemaVersion: SYNC_SCHEMA_VERSION,
          datasetId,
          ...snapshot.publicConfig,
        });
        const candidates = [
          { descriptor: assetDescriptor("summary", `summary-${generationTag}.json.gz`, summaryBytes), bytes: summaryBytes, eventIds: [] },
          { descriptor: assetDescriptor("config", `config-${generationTag}.json.gz`, configBytes), bytes: configBytes, eventIds: [] },
          ...usageAssets(snapshot.events, generation, syncId),
        ];
        if (currentVault) {
          const bytes = jsonBuffer(currentVault);
          candidates.push({ descriptor: assetDescriptor("vault", `vault-${generationTag}.enc`, bytes), bytes, eventIds: [] });
        }
        const inherited = (parent?.files || []).filter((item) => item.type === "usage-segment");

        latest = await readLatestManifest(this.provider, datasetId);
        if (Number(latest?.manifest?.generation || 0) !== Number(parent?.generation || 0)
          || String(latest ? sha256(latest.bytes) : "") !== String(latest && parent ? sha256(jsonBuffer(parent)) : "")) {
          if (attempt < MAX_SYNC_ATTEMPTS) continue;
          throw new Error("sync_parent_changed");
        }

        for (const candidate of candidates) {
          await this.provider.uploadAsset(candidate.descriptor.assetName, candidate.bytes, candidate.descriptor.type);
          await downloadAndVerify(this.provider, candidate.descriptor);
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
          createdAtUtc: this.now().toISOString(),
          displayTimezone: "Asia/Shanghai",
          state: "committed",
          configRevision: snapshot.publicConfig.configRevision,
          keyEpoch: Number(currentVault?.keyEpoch || 0),
          vaultRevision: Number(currentVault?.vaultRevision || 0),
          files: [...inherited, ...candidates.map((item) => item.descriptor)],
          tombstones: snapshot.tombstones,
          retention: { localDetailCacheBytes: 50 * 1024 ** 2, localDetailTargetBytes: 45 * 1024 ** 2, prunedBeforeUtc: null },
        };
        const manifestBytes = jsonBuffer(manifest);
        const name = manifestName(generation, syncId);
        await this.provider.uploadAsset(name, manifestBytes, "manifest");
        const uploadedManifest = (await this.provider.listAssets()).find((item) => item.name === name);
        if (!uploadedManifest) throw new Error("sync_manifest_missing_after_upload");
        validateManifest(JSON.parse(Buffer.from(await this.provider.downloadAsset(uploadedManifest)).toString("utf8")), datasetId);
        const eventIds = candidates.flatMap((item) => item.eventIds);
        this.source.markSyncEvents(eventIds);
        const finishedAtUtc = this.now().toISOString();
        this.source.recordSyncRun?.({ syncId, state: "IDLE", generation, startedAtUtc, finishedAtUtc, summary: `${reason}: ${eventIds.length} event(s)` });
        this.emit({ state: "IDLE", generation, pendingCount: 0, lastSyncAt: finishedAtUtc, warning: assetsBefore.length >= WARN_ASSET_COUNT ? "sync_asset_count_warning" : "", errorCode: "", error: "" });
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
    for (const asset of assets.filter((item) => /^manifest-g\d{6}-s/.test(item.name))) {
      try {
        const bytes = await this.provider.downloadAsset(asset);
        const manifest = validateManifest(JSON.parse(Buffer.from(bytes).toString("utf8")));
        manifests.push({ asset, manifest });
      } catch { /* invalid candidates are handled as orphans below */ }
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
