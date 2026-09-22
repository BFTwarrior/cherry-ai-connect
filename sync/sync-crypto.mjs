/**
 * 中文：同步数据专用加密模块。
 *
 * 这个文件只负责“云同步保险库”的密码学格式和加解密，不负责文件读写、GitHub
 * 请求、同步冲突处理或界面状态。这样可以把最容易影响跨设备兼容性的部分集中在
 * 一个稳定边界内，避免同步编排代码重复实现加密规则。
 *
 * 加密格式的兼容性约束：
 * 1. 外层 envelope 的字段名、SYNC_FORMAT、SYNC_SCHEMA_VERSION、objectType 不能
 *    随意改变；已有的 vault.enc 和远端 Release 资产必须继续可读取。
 * 2. 密码和恢复码不是直接加密业务数据，而是分别包裹同一个 32 字节 DEK。
 *    因此用户可以用任一凭证解锁同一份数据，同时不会产生两份不一致的密钥。
 * 3. 业务数据先使用 gzip 固定压缩，再使用 AES-256-GCM 加密。AAD 把数据集、密钥
 *    代次和 vault 修订号绑定在一起，防止把别的数据集、旧版本或其他对象拼接过来。
 * 4. 密码、恢复码、KEK 和 DEK 绝不写入同步资产；临时得到的密钥在调用方完成任务
 *    后必须清零。本模块也会在自己的错误路径上清零能安全清零的中间密钥。
 *
 * English: Dedicated cryptography module for synchronized data.
 *
 * This file owns only the cloud-sync vault format and cryptographic operations. It does not
 * perform file I/O, GitHub requests, merge/conflict handling, or UI state updates. Keeping the
 * compatibility-sensitive rules here prevents sync orchestration code from reimplementing or
 * accidentally changing the encryption contract.
 *
 * Compatibility invariants:
 * 1. The envelope field names, SYNC_FORMAT, SYNC_SCHEMA_VERSION, and objectType are part of
 *    the persisted format. Existing local vaults and Release assets must remain readable.
 * 2. The password and recovery code wrap the same 32-byte DEK instead of encrypting business
 *    data independently. Either credential therefore unlocks one consistent data set.
 * 3. Secrets are deterministically JSON-serialized, gzip-compressed, and then encrypted with
 *    AES-256-GCM. AAD binds the data set, key epoch, and vault revision to the ciphertext.
 * 4. Passwords, recovery codes, KEKs, and DEKs never enter sync assets. Callers must clear a
 *    returned DEK after use; this module also clears intermediate keys on its failure paths.
 */
import crypto from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { argon2idAsync } from "@noble/hashes/argon2.js";
import { SYNC_FORMAT, SYNC_SCHEMA_VERSION, stableJson } from "./sync-common.mjs";

/**
 * 中文：这些 KDF 参数是持久化格式的一部分。提高参数需要版本迁移策略，不能只在
 *    某次重构中直接改默认值，否则旧密码无法打开旧保险库。
 * English: These KDF parameters are persisted format data. Raising them requires a migration
 *    strategy; changing the defaults in an ordinary refactor would strand existing vaults.
 */
const DEFAULT_KDF = Object.freeze({ algorithm: "argon2id", t: 2, m: 65536, p: 1, dkLen: 32, version: 0x13 });
const MAX_VAULT_PLAINTEXT_BYTES = 8 * 1024 * 1024;

/**
 * 中文：同步 JSON 统一使用 base64url，避免密码学字段出现斜杠、加号和换行。
 * English: Sync cryptographic fields use base64url so JSON assets never contain slash, plus,
 * or line-break characters that could be altered by a transport layer.
 */
function base64(value) { return Buffer.from(value).toString("base64url"); }
function unbase64(value) {
  try { return Buffer.from(String(value || ""), "base64url"); }
  catch { throw new Error("vault_invalid_encoding"); }
}

/**
 * 中文：数据集 ID 是 AAD 的根身份。先严格校验再进入 AAD，避免空字符串或任意文本
 * 被当成合法数据集，从而造成跨数据集解密。
 * English: The dataset ID is the root identity for AAD. Validate it before building AAD so
 * an empty or arbitrary string can never be treated as a legitimate sync data set.
 */
function validDatasetId(value) {
  if (!/^ds_[0-9a-f-]{36}$/i.test(String(value || ""))) throw new Error("vault_invalid_dataset");
  return String(value);
}

/**
 * 中文：DEK 包裹层的 AAD 绑定“这是密码包裹还是恢复码包裹”，防止两层对象互换。
 * English: Wrapper AAD binds whether a DEK wrapper belongs to the password or recovery-code
 * credential, preventing the two wrapper objects from being swapped.
 */
function wrapperAad(datasetId, objectType, keyEpoch) {
  return Buffer.from(stableJson({ format: SYNC_FORMAT, schemaVersion: SYNC_SCHEMA_VERSION, datasetId, objectType, keyEpoch }), "utf8");
}

/**
 * 中文：业务密文的 AAD 绑定当前 vault 修订号。修改 envelope 元数据而不重新加密时，
 * AES-GCM 验证会失败，调用方不会误用被篡改或错配的内容。
 * English: Payload AAD binds the current vault revision. Editing envelope metadata without
 * re-encrypting the payload therefore fails AES-GCM authentication instead of being accepted.
 */
function payloadAad(datasetId, keyEpoch, vaultRevision) {
  return Buffer.from(stableJson({ format: SYNC_FORMAT, schemaVersion: SYNC_SCHEMA_VERSION, datasetId, objectType: "vault", keyEpoch, vaultRevision }), "utf8");
}

/**
 * 中文：统一的 AES-256-GCM 写入路径。每次加密都生成新的 96-bit nonce；绝不能复用同一
 * 个 key + nonce 组合。返回的 tag 是完整认证标签，接收端必须验证后才能得到明文。
 * English: Shared AES-256-GCM encryption path. Every operation gets a fresh 96-bit nonce;
 * never reuse a key/nonce pair. The returned tag is required for authenticated decryption.
 */
function encryptAes(plaintext, key, aad) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(key), nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  return { nonce: base64(nonce), ciphertext: base64(ciphertext), tag: base64(cipher.getAuthTag()) };
}

/**
 * 中文：统一的 AES-256-GCM 读取路径。认证失败统一转换为稳定错误码，避免把底层
 * OpenSSL 文本暴露给界面，也让同步引擎能区分错误密码、篡改和普通网络错误。
 * English: Shared AES-256-GCM decryption path. Authentication failures become stable error
 * codes instead of leaking OpenSSL text, allowing the sync engine to handle bad credentials,
 * tampering, and network errors deterministically.
 */
function decryptAes(value, key, aad, errorCode = "vault_authentication_failed") {
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(key), unbase64(value.nonce));
    decipher.setAAD(aad);
    decipher.setAuthTag(unbase64(value.tag));
    return Buffer.concat([decipher.update(unbase64(value.ciphertext)), decipher.final()]);
  } catch { throw new Error(errorCode); }
}

/**
 * 中文：规范化并限制远端提供的 KDF 参数。限制内存和并行度既防止恶意 envelope 消耗
 * 过多资源，也保证不同设备使用同一套可预期的参数范围。
 * English: Normalize and bound KDF parameters supplied by a remote envelope. The limits avoid
 * resource-exhaustion payloads while keeping all devices within a predictable parameter range.
 */
function normalizedKdf(options = {}) {
  const value = { ...DEFAULT_KDF, ...options, algorithm: "argon2id", dkLen: 32, version: 0x13 };
  if (!Number.isInteger(value.t) || value.t < 1 || value.t > 10) throw new Error("vault_invalid_kdf");
  if (!Number.isInteger(value.m) || value.m < 8 || value.m > 262144) throw new Error("vault_invalid_kdf");
  if (!Number.isInteger(value.p) || value.p < 1 || value.p > 4) throw new Error("vault_invalid_kdf");
  return value;
}

/**
 * 中文：用 Argon2id 把用户凭证转换成 KEK。KEK 只在内存中短暂存在，用来包裹 DEK，
 * 不直接用于业务数据，以便密码/恢复码可以独立轮换。
 * English: Derive a KEK from a user credential with Argon2id. The KEK is short-lived and wraps
 * the DEK rather than encrypting business data, so password and recovery-code wrappers rotate
 * independently without changing the data key.
 */
async function deriveKey(credential, salt, kdf) {
  if (!credential || String(credential).length < 8) throw new Error("vault_credential_too_short");
  const options = normalizedKdf(kdf);
  const bytes = await argon2idAsync(String(credential), unbase64(salt), {
    t: options.t,
    m: options.m,
    p: options.p,
    dkLen: options.dkLen,
    version: options.version,
    maxmem: Math.max(128 * 1024 * 1024, options.m * 1024 + 16 * 1024 * 1024),
    asyncTick: 8,
  });
  return Buffer.from(bytes);
}

/**
 * 中文：用独立随机 salt 派生 KEK，并把 DEK 加密成一个带 AAD 的 wrapper。
 * English: Derive a KEK with an independent random salt and encrypt the DEK into an AAD-bound
 * wrapper. Password and recovery-code wrappers therefore cannot be confused with each other.
 */
async function createWrapper(dek, credential, datasetId, objectType, keyEpoch, kdfOptions) {
  const salt = crypto.randomBytes(16);
  const kdf = normalizedKdf(kdfOptions);
  const kek = await deriveKey(credential, base64(salt), kdf);
  try { return { kdf, salt: base64(salt), ...encryptAes(dek, kek, wrapperAad(datasetId, objectType, keyEpoch)) }; }
  finally { kek.fill(0); }
}

/**
 * 中文：打开 wrapper 后只返回 DEK，不改变 envelope。错误凭证统一返回 vault_wrong_credential，
 * 远端恢复流程因此不会把错误密码当成空配置写回本机。
 * English: Open a wrapper and return only the DEK without mutating the envelope. Wrong
 * credentials use one stable error so remote restore never writes an empty configuration locally.
 */
async function openWrapper(wrapper, credential, datasetId, objectType, keyEpoch) {
  if (!wrapper?.kdf || !wrapper?.salt) throw new Error("vault_missing_wrapper");
  const kek = await deriveKey(credential, wrapper.salt, wrapper.kdf);
  try { return decryptAes(wrapper, kek, wrapperAad(datasetId, objectType, keyEpoch), "vault_wrong_credential"); }
  finally { kek.fill(0); }
}

/**
 * 中文：业务数据的唯一写入路径。明文大小先限制，再固定 gzip，最后 AES-GCM；固定
 * mtime 保证相同数据的压缩结果可复现，便于同步资产验证和测试。
 * English: The only payload-writing path. Bound the plaintext first, gzip it deterministically,
 * then apply AES-GCM. A fixed gzip mtime keeps equivalent payloads reproducible for verification.
 */
function encryptPayload(secrets, dek, datasetId, keyEpoch, vaultRevision) {
  const raw = Buffer.from(stableJson(secrets), "utf8");
  if (raw.length > MAX_VAULT_PLAINTEXT_BYTES) throw new Error("vault_plaintext_too_large");
  const compressed = gzipSync(raw, { level: 9, mtime: 0 });
  return { compression: "gzip", contentType: "application/json", ...encryptAes(compressed, dek, payloadAad(datasetId, keyEpoch, vaultRevision)) };
}

/**
 * 中文：业务数据的唯一读取路径。先通过 GCM 认证，再限制解压输出大小，最后解析 JSON；
 * 顺序不能反过来，否则恶意密文可能触发无界解压或把未认证数据送入业务层。
 * English: The only payload-reading path. Authenticate with GCM first, bound decompression,
 * then parse JSON. Reversing this order could expose the business layer to unauthenticated data
 * or an oversized decompression payload.
 */
function decryptPayload(envelope, dek) {
  const compressed = decryptAes(envelope.vault, dek, payloadAad(envelope.datasetId, envelope.keyEpoch, envelope.vaultRevision));
  let raw;
  try { raw = gunzipSync(compressed, { maxOutputLength: MAX_VAULT_PLAINTEXT_BYTES }); }
  catch { throw new Error("vault_invalid_payload"); }
  if (raw.length > MAX_VAULT_PLAINTEXT_BYTES) throw new Error("vault_plaintext_too_large");
  try { return JSON.parse(raw.toString("utf8")); }
  catch { throw new Error("vault_invalid_payload"); }
}

/**
 * 中文：恢复码只在创建时返回一次；它不会写入 vault、同步资产或本地状态文件。
 * English: The recovery code is returned only at creation time. It is never written into the
 * vault, a sync asset, or a local state file.
 */
export function createRecoveryCode() {
  const raw = crypto.randomBytes(24).toString("base64url").toUpperCase();
  return `CGRC-${raw.match(/.{1,6}/g).join("-")}`;
}

/**
 * 中文：创建一份新的同步保险库。返回的 dek 只供 LocalVaultStore 立刻保存本机保护副本，
 * 调用方完成保存后必须 fill(0)。
 * English: Create a new sync vault. The returned DEK exists only so LocalVaultStore can save
 * a locally protected copy immediately; callers must fill(0) after that save completes.
 */
export async function createVault({ datasetId, secrets, password, recoveryCode = createRecoveryCode(), keyEpoch = 1, vaultRevision = 1, kdfOptions } = {}) {
  const id = validDatasetId(datasetId);
  const dek = crypto.randomBytes(32);
  try {
    const passwordWrap = await createWrapper(dek, password, id, "dek-password", keyEpoch, kdfOptions);
    const recoveryWrap = await createWrapper(dek, recoveryCode, id, "dek-recovery", keyEpoch, kdfOptions);
    const now = new Date().toISOString();
    const envelope = {
      format: SYNC_FORMAT,
      schemaVersion: SYNC_SCHEMA_VERSION,
      objectType: "vault",
      datasetId: id,
      keyEpoch,
      vaultRevision,
      createdAtUtc: now,
      updatedAtUtc: now,
      passwordWrap,
      recoveryWrap,
      vault: encryptPayload(secrets, dek, id, keyEpoch, vaultRevision),
    };
    return { envelope, recoveryCode, dek };
  } catch (error) {
    dek.fill(0);
    throw error;
  }
}

/**
 * 中文：用密码或恢复码解锁。解锁失败时 DEK 会在本模块内清零；成功时由调用方负责
 * 在使用完毕后清零，因为调用方可能需要立刻写入本机保护存储。
 * English: Unlock with a password or recovery code. On failure this module clears the DEK;
 * on success the caller owns it and must clear it after local protected storage is updated.
 */
export async function unlockVault(envelope, { password, recoveryCode } = {}) {
  validateVaultEnvelope(envelope);
  let dek;
  if (password) dek = await openWrapper(envelope.passwordWrap, password, envelope.datasetId, "dek-password", envelope.keyEpoch);
  else if (recoveryCode) dek = await openWrapper(envelope.recoveryWrap, recoveryCode, envelope.datasetId, "dek-recovery", envelope.keyEpoch);
  else throw new Error("vault_credential_required");
  try { return { secrets: decryptPayload(envelope, dek), dek }; }
  catch (error) { dek.fill(0); throw error; }
}

/**
 * 中文：使用已经由本机安全存储解出的 DEK 打开远端或本地 envelope；不会再次派生密码。
 * English: Open a local or remote envelope with a DEK already released by secure local storage;
 * no password derivation is repeated here.
 */
export function openVaultWithDek(envelope, dek) {
  validateVaultEnvelope(envelope);
  if (!Buffer.isBuffer(dek) || dek.length !== 32) throw new Error("vault_invalid_dek");
  return decryptPayload(envelope, dek);
}

/**
 * 中文：在同一 DEK 下生成新修订。每次更新都会更换 payload nonce，并把新 revision 写入
 * AAD；旧资产仍保持不可变，远端 manifest 可以安全指向新资产。
 * English: Create a new revision under the same DEK. Each update gets a fresh payload nonce
 * and binds the new revision into AAD; old immutable assets remain readable.
 */
export function updateVault(envelope, secrets, dek) {
  validateVaultEnvelope(envelope);
  if (!Buffer.isBuffer(dek) || dek.length !== 32) throw new Error("vault_invalid_dek");
  const vaultRevision = Number(envelope.vaultRevision) + 1;
  return {
    ...envelope,
    vaultRevision,
    updatedAtUtc: new Date().toISOString(),
    vault: encryptPayload(secrets, dek, envelope.datasetId, envelope.keyEpoch, vaultRevision),
  };
}

/**
 * 中文：修改密码只重包裹同一个 DEK，同时重新写入 payload revision；业务密文不会被
 * 错误地用密码直接加密，也不会让恢复码 wrapper 失效。
 * English: Changing the password re-wraps the same DEK and writes a new payload revision.
 * Business ciphertext is never encrypted directly with the password, and the recovery wrapper
 * remains valid.
 */
export async function changeVaultPassword(envelope, oldCredential, nextPassword, { recovery = false, kdfOptions } = {}) {
  validateVaultEnvelope(envelope);
  const unlocked = await unlockVault(envelope, recovery ? { recoveryCode: oldCredential } : { password: oldCredential });
  try {
    const nextRevision = Number(envelope.vaultRevision) + 1;
    return {
      ...envelope,
      vaultRevision: nextRevision,
      updatedAtUtc: new Date().toISOString(),
      passwordWrap: await createWrapper(unlocked.dek, nextPassword, envelope.datasetId, "dek-password", envelope.keyEpoch, kdfOptions),
      vault: encryptPayload(unlocked.secrets, unlocked.dek, envelope.datasetId, envelope.keyEpoch, nextRevision),
    };
  } finally { unlocked.dek.fill(0); }
}

/**
 * 中文：验证 envelope 的结构和格式版本，但不尝试解密。真正的完整性验证仍必须经过
 * AES-GCM；结构校验只是让读取路径提前拒绝明显错误的远端资产。
 * English: Validate envelope structure and format version without decrypting. Full integrity
 * still requires AES-GCM; structural validation only rejects obviously invalid remote assets early.
 */
export function validateVaultEnvelope(value, expectedDatasetId = "") {
  if (!value || typeof value !== "object" || value.format !== SYNC_FORMAT || value.objectType !== "vault" || Number(value.schemaVersion) !== SYNC_SCHEMA_VERSION) throw new Error("vault_invalid_envelope");
  validDatasetId(value.datasetId);
  if (expectedDatasetId && value.datasetId !== expectedDatasetId) throw new Error("vault_dataset_mismatch");
  if (!Number.isSafeInteger(value.keyEpoch) || value.keyEpoch < 1 || !Number.isSafeInteger(value.vaultRevision) || value.vaultRevision < 1) throw new Error("vault_invalid_revision");
  if (!value.passwordWrap || !value.recoveryWrap || !value.vault) throw new Error("vault_missing_fields");
  return value;
}

/**
 * 中文：导出默认参数供测试和迁移工具只读使用；不要在业务代码中直接修改该对象。
 * English: Expose the default parameters for read-only tests and migration tooling; callers
 * must never mutate this object.
 */
export const vaultKdfDefaults = DEFAULT_KDF;
