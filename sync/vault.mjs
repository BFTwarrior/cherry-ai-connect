/**
 * 中文：使用 Argon2id + AES-256-GCM 的信封加密 vault；密码和恢复码分别包裹同一 DEK。
 * English: Argon2id and AES-256-GCM envelope encryption with password and recovery-code DEK wrappers.
 */
import crypto from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { argon2idAsync } from "@noble/hashes/argon2.js";
import { SYNC_FORMAT, SYNC_SCHEMA_VERSION, stableJson } from "./sync-common.mjs";

const DEFAULT_KDF = Object.freeze({ algorithm: "argon2id", t: 2, m: 65536, p: 1, dkLen: 32, version: 0x13 });
const MAX_VAULT_PLAINTEXT_BYTES = 8 * 1024 * 1024;

function base64(value) { return Buffer.from(value).toString("base64url"); }
function unbase64(value) {
  try { return Buffer.from(String(value || ""), "base64url"); }
  catch { throw new Error("vault_invalid_encoding"); }
}

function validDatasetId(value) {
  if (!/^ds_[0-9a-f-]{36}$/i.test(String(value || ""))) throw new Error("vault_invalid_dataset");
  return String(value);
}

function wrapperAad(datasetId, objectType, keyEpoch) {
  return Buffer.from(stableJson({ format: SYNC_FORMAT, schemaVersion: SYNC_SCHEMA_VERSION, datasetId, objectType, keyEpoch }), "utf8");
}

function payloadAad(datasetId, keyEpoch, vaultRevision) {
  return Buffer.from(stableJson({ format: SYNC_FORMAT, schemaVersion: SYNC_SCHEMA_VERSION, datasetId, objectType: "vault", keyEpoch, vaultRevision }), "utf8");
}

function encryptAes(plaintext, key, aad) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(key), nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  return { nonce: base64(nonce), ciphertext: base64(ciphertext), tag: base64(cipher.getAuthTag()) };
}

function decryptAes(value, key, aad, errorCode = "vault_authentication_failed") {
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(key), unbase64(value.nonce));
    decipher.setAAD(aad);
    decipher.setAuthTag(unbase64(value.tag));
    return Buffer.concat([decipher.update(unbase64(value.ciphertext)), decipher.final()]);
  } catch { throw new Error(errorCode); }
}

function normalizedKdf(options = {}) {
  const value = { ...DEFAULT_KDF, ...options, algorithm: "argon2id", dkLen: 32, version: 0x13 };
  if (!Number.isInteger(value.t) || value.t < 1 || value.t > 10) throw new Error("vault_invalid_kdf");
  if (!Number.isInteger(value.m) || value.m < 8 || value.m > 262144) throw new Error("vault_invalid_kdf");
  if (!Number.isInteger(value.p) || value.p < 1 || value.p > 4) throw new Error("vault_invalid_kdf");
  return value;
}

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

async function createWrapper(dek, credential, datasetId, objectType, keyEpoch, kdfOptions) {
  const salt = crypto.randomBytes(16);
  const kdf = normalizedKdf(kdfOptions);
  const kek = await deriveKey(credential, base64(salt), kdf);
  try { return { kdf, salt: base64(salt), ...encryptAes(dek, kek, wrapperAad(datasetId, objectType, keyEpoch)) }; }
  finally { kek.fill(0); }
}

async function openWrapper(wrapper, credential, datasetId, objectType, keyEpoch) {
  if (!wrapper?.kdf || !wrapper?.salt) throw new Error("vault_missing_wrapper");
  const kek = await deriveKey(credential, wrapper.salt, wrapper.kdf);
  try { return decryptAes(wrapper, kek, wrapperAad(datasetId, objectType, keyEpoch), "vault_wrong_credential"); }
  finally { kek.fill(0); }
}

function encryptPayload(secrets, dek, datasetId, keyEpoch, vaultRevision) {
  const raw = Buffer.from(stableJson(secrets), "utf8");
  if (raw.length > MAX_VAULT_PLAINTEXT_BYTES) throw new Error("vault_plaintext_too_large");
  const compressed = gzipSync(raw, { level: 9, mtime: 0 });
  return { compression: "gzip", contentType: "application/json", ...encryptAes(compressed, dek, payloadAad(datasetId, keyEpoch, vaultRevision)) };
}

function decryptPayload(envelope, dek) {
  const compressed = decryptAes(envelope.vault, dek, payloadAad(envelope.datasetId, envelope.keyEpoch, envelope.vaultRevision));
  let raw;
  try { raw = gunzipSync(compressed, { maxOutputLength: MAX_VAULT_PLAINTEXT_BYTES }); }
  catch { throw new Error("vault_invalid_payload"); }
  if (raw.length > MAX_VAULT_PLAINTEXT_BYTES) throw new Error("vault_plaintext_too_large");
  try { return JSON.parse(raw.toString("utf8")); }
  catch { throw new Error("vault_invalid_payload"); }
}

export function createRecoveryCode() {
  const raw = crypto.randomBytes(24).toString("base64url").toUpperCase();
  return `CGRC-${raw.match(/.{1,6}/g).join("-")}`;
}

export async function createVault({ datasetId, secrets, password, recoveryCode = createRecoveryCode(), keyEpoch = 1, vaultRevision = 1, kdfOptions } = {}) {
  const id = validDatasetId(datasetId);
  const dek = crypto.randomBytes(32);
  const passwordWrap = await createWrapper(dek, password, id, "dek-password", keyEpoch, kdfOptions);
  const recoveryWrap = await createWrapper(dek, recoveryCode, id, "dek-recovery", keyEpoch, kdfOptions);
  const envelope = {
    format: SYNC_FORMAT,
    schemaVersion: SYNC_SCHEMA_VERSION,
    objectType: "vault",
    datasetId: id,
    keyEpoch,
    vaultRevision,
    createdAtUtc: new Date().toISOString(),
    updatedAtUtc: new Date().toISOString(),
    passwordWrap,
    recoveryWrap,
    vault: encryptPayload(secrets, dek, id, keyEpoch, vaultRevision),
  };
  return { envelope, recoveryCode, dek };
}

export async function unlockVault(envelope, { password, recoveryCode } = {}) {
  validateVaultEnvelope(envelope);
  let dek;
  if (password) dek = await openWrapper(envelope.passwordWrap, password, envelope.datasetId, "dek-password", envelope.keyEpoch);
  else if (recoveryCode) dek = await openWrapper(envelope.recoveryWrap, recoveryCode, envelope.datasetId, "dek-recovery", envelope.keyEpoch);
  else throw new Error("vault_credential_required");
  try { return { secrets: decryptPayload(envelope, dek), dek }; }
  catch (error) { dek.fill(0); throw error; }
}

export function openVaultWithDek(envelope, dek) {
  validateVaultEnvelope(envelope);
  if (!Buffer.isBuffer(dek) || dek.length !== 32) throw new Error("vault_invalid_dek");
  return decryptPayload(envelope, dek);
}

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

export function validateVaultEnvelope(value, expectedDatasetId = "") {
  if (!value || typeof value !== "object" || value.format !== SYNC_FORMAT || value.objectType !== "vault" || Number(value.schemaVersion) !== SYNC_SCHEMA_VERSION) throw new Error("vault_invalid_envelope");
  validDatasetId(value.datasetId);
  if (expectedDatasetId && value.datasetId !== expectedDatasetId) throw new Error("vault_dataset_mismatch");
  if (!Number.isSafeInteger(value.keyEpoch) || value.keyEpoch < 1 || !Number.isSafeInteger(value.vaultRevision) || value.vaultRevision < 1) throw new Error("vault_invalid_revision");
  if (!value.passwordWrap || !value.recoveryWrap || !value.vault) throw new Error("vault_missing_fields");
  return value;
}

export const vaultKdfDefaults = DEFAULT_KDF;
