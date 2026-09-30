/**
 * 中文：按稳定 ID 合并条目；缺省不是删除，明确删除标记永久压过旧条目。
 * 修订号使用本地单调时钟加设备 ID，离线并发修改也能得到确定的同一结果。
 * English: Merge records by stable ID. Omission never deletes; explicit tombstones defeat
 * stale records. A monotonic revision clock and device-ID tie break converge deterministically.
 */
import { stableJson } from "./sync-common.mjs";

export function revision(value, fallback = {}) {
  const input = value || fallback;
  const counter = Number(input.counter || 0);
  if (!Number.isSafeInteger(counter) || counter < 0) throw new Error("sync_invalid_revision");
  return { counter, deviceId: String(input.deviceId || "") };
}

export function compareRevision(left, right) {
  const a = revision(left), b = revision(right);
  return a.counter - b.counter || a.deviceId.localeCompare(b.deviceId, "en");
}

export function deletedIds(tombstones, type) {
  return new Set((tombstones || []).filter((item) => String(item.object_type || item.objectType) === type)
    .map((item) => String(item.object_id || item.objectId || "")));
}

export function mergeRecords(local, remote, { localRevision, remoteRevision, tombstones = [], type } = {}) {
  if (!Array.isArray(local) || !Array.isArray(remote)) throw new Error("sync_invalid_config");
  const deleted = deletedIds(tombstones, type);
  const values = new Map();
  for (const [records, fallback] of [[local, localRevision], [remote, remoteRevision]]) {
    const seen = new Set();
    for (const item of records) {
      const id = String(item?.id || "");
      if (!id || seen.has(id)) throw new Error("sync_invalid_config");
      seen.add(id);
      if (deleted.has(id)) continue;
      const next = { ...item, syncRevision: revision(item.syncRevision, fallback) };
      const previous = values.get(id);
      const order = previous ? compareRevision(next.syncRevision, previous.syncRevision) : 1;
      // 中文：同修订号的旧格式也用确定性内容排序，不依赖谁先拉取。
      // English: Equal legacy revisions also use a deterministic content tie break.
      if (!previous || order > 0 || (order === 0 && stableJson(next) > stableJson(previous))) values.set(id, next);
    }
  }
  return [...values.values()].sort((a, b) => a.id.localeCompare(b.id, "en"));
}

export function mergeOrder(local, remote, keys) {
  const a = local || { ids: [], revision: { counter: 0, deviceId: "" } };
  const b = remote || { ids: [], revision: { counter: 0, deviceId: "" } };
  for (const value of [a, b]) {
    if (!Array.isArray(value.ids) || value.ids.some((id) => typeof id !== "string") || new Set(value.ids).size !== value.ids.length) throw new Error("sync_invalid_key_order");
    revision(value.revision);
  }
  const diff = compareRevision(a.revision, b.revision);
  const winner = diff > 0 ? a : diff < 0 ? b : stableJson(a) >= stableJson(b) ? a : b;
  const available = new Set(keys.map((key) => key.id));
  const ids = winner.ids.filter((id) => available.has(id));
  const included = new Set(ids);
  ids.push(...keys.map((key) => key.id).filter((id) => !included.has(id)).sort());
  return { ids, revision: revision(winner.revision) };
}

export function clientMetadata(publicConfig, datasetId) {
  return {
    schemaVersion: 1, datasetId,
    configRevision: publicConfig.configRevision,
    // 中文：公开引用只有 ID 和显示名称，不包含线路地址、上游 Key 或本机密文。
    // English: Public route references carry only ID/name, never URLs, upstream keys or ciphertext.
    providers: publicConfig.providers.map(({ id, name }) => ({ id, name })),
    clientKeyMetadata: publicConfig.clientKeyMetadata.map((item) => ({
      id: item.id, name: item.name, nameCustomized: item.nameCustomized === true,
      providerId: item.providerId, reasoningLevel: item.reasoningLevel, createdAt: item.createdAt,
      enabled: item.enabled !== false, syncRevision: revision(item.syncRevision, publicConfig.configRevision),
      secretAvailableOnThisDevice: false,
    })),
    clientKeyOrder: publicConfig.clientKeyOrder,
  };
}
