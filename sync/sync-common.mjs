/**
 * 中文：云同步公共格式工具。
 *
 * 这里放的是加密模块和同步引擎共同依赖、但本身不包含秘密的确定性序列化、压缩、
 * 哈希、资产描述和 manifest 校验。不要把密码或明文上游 Key 放入这些 helper；
 * `sync-crypto.mjs` 负责敏感数据，`sync-engine.mjs` 负责提交顺序。
 *
 * English: Shared cloud-sync format helpers.
 *
 * This module contains deterministic serialization, compression, hashing, asset descriptors,
 * and manifest validation shared by the crypto module and sync engine. It must remain secret-free:
 * passwords and plaintext upstream keys belong to `sync-crypto.mjs`, while commit ordering belongs
 * to `sync-engine.mjs`.
 */
import crypto from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

export const SYNC_FORMAT = "cherry-ai-connect-sync";
export const SYNC_SCHEMA_VERSION = 1;
export const SYNC_PRODUCT_VERSION = "1.1";
export const MAX_COMPRESSED_ASSET_BYTES = 24 * 1024 * 1024;
export const MAX_DECOMPRESSED_ASSET_BYTES = 128 * 1024 * 1024;

export function sha256(value) {
  // 中文：哈希只用于资产/manifest 完整性校验，不替代 AES-GCM 的认证标签。
  // English: Hashes identify asset/manifest bytes; they do not replace AES-GCM authentication.
  return crypto.createHash("sha256").update(value).digest("hex");
}
export function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function ordered(value) {
  // 中文：递归排序对象键，确保不同设备为同一逻辑内容生成同样的 JSON 字节。
  // English: Recursively sort object keys so all devices produce identical JSON bytes for the
  // same logical content.
  if (Array.isArray(value)) return value.map(ordered);
  if (!value || typeof value !== "object" || value instanceof Date || Buffer.isBuffer(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(value[key])]));
}

export function stableJson(value, spacing = 0) {
  return JSON.stringify(ordered(value), null, spacing);
}

export function jsonBuffer(value) {
  return Buffer.from(stableJson(value), "utf8");
}

export function gzipJson(value) {
  // 中文：固定 gzip mtime，避免时间戳让相同内容产生不同资产，便于哈希验证。
  // English: Fix gzip mtime so timestamps do not make equal content produce different assets.
  return gzipSync(jsonBuffer(value), { level: 9, mtime: 0 });
}

export function gzipJsonLines(values) {
  const body = values.map((value) => stableJson(value)).join("\n");
  return gzipSync(Buffer.from(body ? `${body}\n` : "", "utf8"), { level: 9, mtime: 0 });
}

export function boundedGunzip(value, limit = MAX_DECOMPRESSED_ASSET_BYTES) {
  // 中文：压缩包来自远端，先限制压缩输入再限制解压输出，防止 zip-bomb 类资源耗尽。
  // English: Remote compressed bytes are bounded before and after decompression to prevent
  // zip-bomb-style resource exhaustion.
  const input = Buffer.from(value);
  if (input.length > MAX_COMPRESSED_ASSET_BYTES) throw new Error("sync_asset_too_large");
  let output;
  try { output = gunzipSync(input, { maxOutputLength: limit }); }
  catch (error) {
    if (/larger than|too large|maxOutputLength/i.test(String(error?.message || error))) throw new Error("sync_decompressed_limit");
    throw new Error("sync_invalid_gzip");
  }
  if (output.length > limit) throw new Error("sync_decompressed_limit");
  return output;
}

export function parseCompressedJson(value, limit) {
  try { return JSON.parse(boundedGunzip(value, limit).toString("utf8")); }
  catch (error) {
    if (String(error?.message || "").startsWith("sync_")) throw error;
    throw new Error("sync_invalid_json");
  }
}

export function parseCompressedJsonLines(value, limit) {
  const text = boundedGunzip(value, limit).toString("utf8").trim();
  if (!text) return [];
  try { return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); }
  catch { throw new Error("sync_invalid_jsonl"); }
}

export function assetDescriptor(type, assetName, bytes) {
  // 中文：descriptor 与实际上传 bytes 同时生成，manifest 不接受调用方手写的尺寸/哈希。
  // English: Build the descriptor from the exact bytes being uploaded; callers cannot hand-write
  // a size or hash that disagrees with the asset.
  const buffer = Buffer.from(bytes);
  if (buffer.length > MAX_COMPRESSED_ASSET_BYTES) throw new Error("sync_asset_too_large");
  return { type, assetName, sha256: sha256(buffer), size: buffer.length };
}

export function verifyAsset(descriptor, bytes) {
  // 中文：下载数据进入解析前必须经过尺寸和 SHA-256 双重检查。
  // English: Downloaded bytes must pass both size and SHA-256 checks before parsing.
  const buffer = Buffer.from(bytes);
  if (!descriptor || descriptor.size !== buffer.length) throw new Error("sync_asset_size_mismatch");
  if (descriptor.sha256 !== sha256(buffer)) throw new Error("sync_asset_hash_mismatch");
  return buffer;
}

export function sanitizeText(value, maximum = 300) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
}

// 中文：文件名使用 UTC+8 可读时间；manifest 内仍保存 generation，不能依赖文件名判断新旧。
// English: Asset names use readable UTC+8 time; generation remains authoritative inside the manifest.
export function syncTimestamp(value = new Date()) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error("sync_invalid_timestamp");
  const utc8 = new Date(date.valueOf() + 8 * 60 * 60 * 1000);
  const year = utc8.getUTCFullYear();
  const month = String(utc8.getUTCMonth() + 1).padStart(2, "0");
  const day = String(utc8.getUTCDate()).padStart(2, "0");
  const hour = String(utc8.getUTCHours()).padStart(2, "0");
  const minute = String(utc8.getUTCMinutes()).padStart(2, "0");
  const second = String(utc8.getUTCSeconds()).padStart(2, "0");
  const millisecond = String(utc8.getUTCMilliseconds()).padStart(3, "0");
  return `${year}${month}${day}-${hour}${minute}${second}-${millisecond}`;
}

export function syncAssetTag(syncId, value = new Date()) {
  return `${syncTimestamp(value)}-s${syncId}`;
}

export function manifestName(syncId, value = new Date()) {
  return `manifest-${syncAssetTag(syncId, value)}.json`;
}

export function isManifestAssetName(value) {
  const name = String(value || "");
  return /^manifest-(?:g\d{6}-ssync_[0-9a-f-]{36}|\d{8}-\d{6}-\d{3}-ssync_[0-9a-f-]{36})\.json$/i.test(name);
}

export function versionAtLeast(current, required) {
  const numbers = (value) => String(value || "0").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const left = numbers(current);
  const right = numbers(required);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if ((left[index] || 0) !== (right[index] || 0)) return (left[index] || 0) > (right[index] || 0);
  }
  return true;
}

export function validateManifest(value, expectedDatasetId = "") {
  // 中文：manifest 是跨设备提交点；任何格式、数据集、版本或文件描述异常都必须拒绝。
  // English: The manifest is the cross-device commit point; reject any format, dataset, version,
  // or file-descriptor mismatch before using it.
  if (!value || typeof value !== "object") throw new Error("sync_invalid_manifest");
  if (value.format !== SYNC_FORMAT || Number(value.schemaVersion) !== SYNC_SCHEMA_VERSION) throw new Error("sync_unsupported_schema");
  if (value.state !== "committed") throw new Error("sync_manifest_not_committed");
  if (!/^ds_[0-9a-f-]{36}$/i.test(String(value.datasetId || ""))) throw new Error("sync_invalid_dataset");
  if (expectedDatasetId && value.datasetId !== expectedDatasetId) throw new Error("sync_dataset_conflict");
  if (!versionAtLeast(SYNC_PRODUCT_VERSION, value.minReaderVersion)) throw new Error("sync_reader_too_old");
  if (!versionAtLeast(SYNC_PRODUCT_VERSION, value.minWriterVersion)) throw new Error("sync_writer_too_old");
  if (!Number.isSafeInteger(value.generation) || value.generation < 1) throw new Error("sync_invalid_generation");
  if (!Array.isArray(value.files) || value.files.some((item) => !item?.assetName || !item?.sha256 || !Number.isSafeInteger(item?.size))) throw new Error("sync_invalid_manifest_files");
  return value;
}
