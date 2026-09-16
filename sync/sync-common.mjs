/**
 * 中文：云同步使用的确定性序列化、压缩、哈希和限界解压工具。
 * English: Deterministic serialization, compression, hashing, and bounded decompression helpers.
 */
import crypto from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

export const SYNC_FORMAT = "cherry-ai-connect-sync";
export const SYNC_SCHEMA_VERSION = 1;
export const SYNC_PRODUCT_VERSION = "1.00";
export const MAX_COMPRESSED_ASSET_BYTES = 24 * 1024 * 1024;
export const MAX_DECOMPRESSED_ASSET_BYTES = 128 * 1024 * 1024;

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
export function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function ordered(value) {
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
  return gzipSync(jsonBuffer(value), { level: 9, mtime: 0 });
}

export function gzipJsonLines(values) {
  const body = values.map((value) => stableJson(value)).join("\n");
  return gzipSync(Buffer.from(body ? `${body}\n` : "", "utf8"), { level: 9, mtime: 0 });
}

export function boundedGunzip(value, limit = MAX_DECOMPRESSED_ASSET_BYTES) {
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
  const buffer = Buffer.from(bytes);
  if (buffer.length > MAX_COMPRESSED_ASSET_BYTES) throw new Error("sync_asset_too_large");
  return { type, assetName, sha256: sha256(buffer), size: buffer.length };
}

export function verifyAsset(descriptor, bytes) {
  const buffer = Buffer.from(bytes);
  if (!descriptor || descriptor.size !== buffer.length) throw new Error("sync_asset_size_mismatch");
  if (descriptor.sha256 !== sha256(buffer)) throw new Error("sync_asset_hash_mismatch");
  return buffer;
}

export function sanitizeText(value, maximum = 300) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
}

export function manifestName(generation, syncId) {
  return `manifest-g${String(generation).padStart(6, "0")}-s${syncId}.json`;
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
