/** Pure retention planning and bounded, lossless usage-segment compaction. */
import { parseCompressedJsonLines, sha256, stableJson, verifyAsset } from "./sync-common.mjs";

const COMPACT_SEGMENTS = 64;
const MAX_COMPACT_SEGMENTS = 256;
const MAX_COMPACT_COMPRESSED = 24 * 1024 * 1024;
const MAX_COMPACT_DECOMPRESSED = 64 * 1024 * 1024;

export async function compactUsage({ inherited, pending, catalog, provider, makeAssets, assetTag, force = false }) {
  const usage = inherited.filter((item) => item.type === "usage-segment");
  const unchanged = () => ({ inherited, candidates: makeAssets(pending, assetTag), compacted: false });
  if (usage.length < COMPACT_SEGMENTS && !force) return unchanged();
  if (usage.length < 2) return unchanged();
  // Compact the smallest segments first; large history remains in its original files.
  const selected = [];
  let compressed = 0;
  for (const descriptor of [...usage].sort((a, b) => a.size - b.size || a.assetName.localeCompare(b.assetName))) {
    if (selected.length >= MAX_COMPACT_SEGMENTS || compressed + descriptor.size > MAX_COMPACT_COMPRESSED) break;
    selected.push(descriptor);
    compressed += descriptor.size;
  }
  if (selected.length < 2) return unchanged();
  const events = new Map();
  let decompressed = 0;
  const add = (event) => {
    const id = event?.eventId || event?.id;
    if (typeof id !== "string" || !id || !event.deviceId || !Number.isSafeInteger(Number(event.deviceEpoch))
      || !Number.isSafeInteger(Number(event.sequence)) || Number.isNaN(Date.parse(event.at))) throw new Error("sync_invalid_usage_event");
    const bytes = stableJson(event);
    // Only exact duplicates are collapsed. Older writers may represent the same
    // event ID differently; preserve both versions instead of choosing one.
    if (!events.has(bytes)) {
      events.set(bytes, event);
      decompressed += Buffer.byteLength(bytes);
      if (decompressed > MAX_COMPACT_DECOMPRESSED) throw new Error("sync_compaction_size_limit");
    }
  };
  for (const descriptor of selected) {
    const asset = catalog.find((item) => item.name === descriptor.assetName);
    if (!asset) throw new Error("sync_asset_missing");
    const bytes = verifyAsset(descriptor, await provider.downloadAsset(asset));
    for (const event of parseCompressedJsonLines(bytes, MAX_COMPACT_DECOMPRESSED - decompressed)) add(event);
  }
  for (const event of pending) add(event);
  const candidates = makeAssets([...events.values()], assetTag);
  if (candidates.length >= selected.length) return unchanged();
  const pendingIds = new Set(pending.map((event) => event.eventId || event.id));
  for (const candidate of candidates) candidate.eventIds = candidate.eventIds.filter((id) => pendingIds.has(id));
  const replaced = new Set(selected.map((item) => item.assetName));
  return { inherited: inherited.filter((item) => !replaced.has(item.assetName)), candidates, compacted: true };
}

const ASSET_TAG = "(?:g\\d{6}-ssync_[0-9a-f-]{36}|\\d{8}-\\d{6}-\\d{3}-ssync_[0-9a-f-]{36})";
const PAYLOAD_NAME = new RegExp(`^(?:(?:summary|client-metadata|config)-${ASSET_TAG}\\.json\\.gz|vault-${ASSET_TAG}\\.enc|usage-.+-e\\d+-\\d{6}-s\\d+-e\\d+-${ASSET_TAG}\\.jsonl\\.gz)$`, "i");
export const isSyncPayload = (name) => PAYLOAD_NAME.test(name);

export function retiredAssets(parents, catalog, files, atUtc) {
  const referenced = new Set(files.map((item) => item.assetName));
  const previouslyReferenced = new Set(parents.filter(Boolean).flatMap((parent) => parent.files).map((item) => item.assetName));
  const previous = new Map();
  for (const parent of parents) {
    for (const item of parent?.retention?.retiredAssets || []) {
      if (typeof item?.assetName !== "string" || !Number.isFinite(Date.parse(item.unreferencedAtUtc))) continue;
      const old = previous.get(item.assetName);
      // A more recent retirement wins when branches disagree about references.
      if (!old || Date.parse(old) < Date.parse(item.unreferencedAtUtc)) previous.set(item.assetName, item.unreferencedAtUtc);
    }
  }
  return catalog.filter((asset) => isSyncPayload(asset.name) && !referenced.has(asset.name))
    .map((asset) => ({ assetName: asset.name, unreferencedAtUtc: previouslyReferenced.has(asset.name) ? atUtc : previous.get(asset.name) || atUtc }))
    .sort((a, b) => a.assetName.localeCompare(b.assetName));
}

export function retentionPlan(manifests, now, { pressure = false, keep = 4 } = {}) {
  const groups = new Map();
  for (const item of manifests) {
    item.hash = sha256(item.bytes);
    const group = groups.get(item.manifest.datasetId) || [];
    group.push(item); groups.set(item.manifest.datasetId, group);
  }
  const protectedNames = new Set();
  const retired = new Map();
  for (const group of groups.values()) {
    group.sort((a, b) => b.manifest.generation - a.manifest.generation
      || String(b.manifest.createdAtUtc).localeCompare(String(a.manifest.createdAtUtc)) || b.asset.name.localeCompare(a.asset.name));
    const byHash = new Map(group.map((item) => [item.hash, item]));
    for (const item of group[0].manifest.retention?.retiredAssets || []) {
      const at = Date.parse(item?.unreferencedAtUtc);
      if (typeof item?.assetName === "string" && Number.isFinite(at)) {
        retired.set(item.assetName, Math.max(retired.get(item.assetName) || 0, at));
      }
    }
    const covered = new Set();
    const pending = [group[0].hash];
    while (pending.length) {
      const hash = pending.pop();
      if (!hash || covered.has(hash)) continue;
      covered.add(hash);
      const manifest = byHash.get(hash)?.manifest;
      if (manifest) pending.push(manifest.parentManifestSha256, ...(manifest.mergedManifestSha256s || []));
    }
    // Late, unmerged device branches must never be collected by generation rank.
    for (const item of group) if (group.indexOf(item) < keep || !covered.has(item.hash)) protectedNames.add(item.asset.name);
  }
  const grace = pressure ? 10 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const expired = (asset) => {
    const created = Date.parse(asset.createdAt);
    return Number.isFinite(created) && created <= now - grace;
  };
  const removed = manifests.filter((item) => !protectedNames.has(item.asset.name) && expired(item.asset));
  const removedNames = new Set(removed.map((item) => item.asset.name));
  const marked = new Set();
  const historicalFiles = new Set();
  for (const item of manifests) {
    for (const file of item.manifest.files) historicalFiles.add(file.assetName);
    if (removedNames.has(item.asset.name)) continue;
    marked.add(item.asset.name);
    for (const file of item.manifest.files) marked.add(file.assetName);
  }
  return { removed, marked, historicalFiles, expired, retired, grace };
}
