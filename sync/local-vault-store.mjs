/**
 * 中文：管理本地 vault.enc 和由 Windows DPAPI 保护的 DEK；不保存密码或恢复码。
 * English: Manages vault.enc and a Windows-DPAPI-protected DEK without storing passwords or recovery codes.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createVault, openVaultWithDek, unlockVault, updateVault, validateVaultEnvelope } from "./vault.mjs";
import { stableJson } from "./sync-common.mjs";

function atomicWrite(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, bytes);
  try { fs.renameSync(temporary, file); }
  catch (error) {
    try { fs.copyFileSync(temporary, file); fs.unlinkSync(temporary); }
    catch { try { fs.unlinkSync(temporary); } catch { /* best effort */ } throw error; }
  }
}

export class LocalVaultStore {
  constructor({ dataDir, protect, unprotect }) {
    if (!dataDir || typeof protect !== "function" || typeof unprotect !== "function") throw new Error("vault_store_protector_required");
    this.vaultFile = path.join(dataDir, "vault.enc");
    this.localKeyFile = path.join(dataDir, ".vault-local-key");
    this.backupDir = path.join(dataDir, "backups");
    this.protect = protect;
    this.unprotect = unprotect;
    fs.mkdirSync(dataDir, { recursive: true });
  }

  readEnvelope() {
    if (!fs.existsSync(this.vaultFile)) return null;
    try { return validateVaultEnvelope(JSON.parse(fs.readFileSync(this.vaultFile, "utf8"))); }
    catch { throw new Error("vault_local_file_invalid"); }
  }

  #readDek() {
    if (!fs.existsSync(this.localKeyFile)) return null;
    try {
      const value = Buffer.from(String(this.unprotect(fs.readFileSync(this.localKeyFile))), "base64url");
      if (value.length !== 32) throw new Error("length");
      return value;
    } catch { throw new Error("vault_local_key_unavailable"); }
  }

  #saveDek(dek) {
    if (!Buffer.isBuffer(dek) || dek.length !== 32) throw new Error("vault_invalid_dek");
    atomicWrite(this.localKeyFile, Buffer.from(this.protect(dek.toString("base64url"))));
  }

  #saveEnvelope(envelope) {
    if (fs.existsSync(this.vaultFile)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
      const name = `vault-${new Date().toISOString().replace(/[:.]/g, "-")}.enc`;
      fs.copyFileSync(this.vaultFile, path.join(this.backupDir, name));
    }
    atomicWrite(this.vaultFile, Buffer.from(JSON.stringify(envelope, null, 2), "utf8"));
  }

  async initialize({ datasetId, secrets, password, kdfOptions } = {}) {
    if (this.readEnvelope()) throw new Error("vault_already_initialized");
    const created = await createVault({ datasetId, secrets, password, kdfOptions });
    try {
      this.#saveEnvelope(created.envelope);
      this.#saveDek(created.dek);
      return { envelope: created.envelope, recoveryCode: created.recoveryCode };
    } finally { created.dek.fill(0); }
  }

  async unlock({ password, recoveryCode } = {}) {
    const envelope = this.readEnvelope();
    if (!envelope) throw new Error("vault_not_initialized");
    const result = await unlockVault(envelope, { password, recoveryCode });
    try {
      this.#saveDek(result.dek);
      return { ok: true, keyEpoch: envelope.keyEpoch, vaultRevision: envelope.vaultRevision };
    } finally { result.dek.fill(0); }
  }

  async importEnvelope(bytes, { password = "", recoveryCode = "", expectedDatasetId = "" } = {}) {
    let remote;
    try { remote = validateVaultEnvelope(JSON.parse(Buffer.from(bytes).toString("utf8")), expectedDatasetId); }
    catch (error) {
      if (String(error?.message || "").startsWith("vault_")) throw error;
      throw new Error("vault_remote_file_invalid");
    }

    let dek = null;
    const local = this.readEnvelope();
    if (local && local.datasetId === remote.datasetId && local.keyEpoch === remote.keyEpoch && fs.existsSync(this.localKeyFile)) {
      let candidate = null;
      try {
        candidate = this.#readDek();
        openVaultWithDek(remote, candidate);
        dek = candidate;
      } catch { candidate?.fill(0); dek = null; }
    }
    if (!dek) {
      const unlocked = await unlockVault(remote, { password, recoveryCode });
      dek = unlocked.dek;
    }
    try {
      const secrets = openVaultWithDek(remote, dek);
      this.#saveEnvelope(remote);
      this.#saveDek(dek);
      return { envelope: remote, secrets };
    } finally { dek.fill(0); }
  }

  async getEnvelope(secrets, datasetId) {
    const envelope = this.readEnvelope();
    if (!envelope) return null;
    validateVaultEnvelope(envelope, datasetId);
    const dek = this.#readDek();
    if (!dek) throw new Error("vault_unlock_required");
    try {
      const current = openVaultWithDek(envelope, dek);
      if (stableJson(current) === stableJson(secrets)) return envelope;
      const next = updateVault(envelope, secrets, dek);
      this.#saveEnvelope(next);
      return next;
    } finally { dek.fill(0); }
  }

  status() {
    try {
      const envelope = this.readEnvelope();
      return {
        initialized: Boolean(envelope),
        unlocked: Boolean(envelope && fs.existsSync(this.localKeyFile)),
        datasetId: envelope?.datasetId || "",
        keyEpoch: Number(envelope?.keyEpoch || 0),
        vaultRevision: Number(envelope?.vaultRevision || 0),
      };
    } catch (error) { return { initialized: true, unlocked: false, error: String(error?.message || error) }; }
  }
}
