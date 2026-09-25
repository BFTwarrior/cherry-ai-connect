/**
 * 中文：本地同步保险库存储层。
 *
 * 本文件只负责磁盘文件、原子写入、备份和 Windows 安全存储的边界；Argon2id、
 * AES-256-GCM、AAD 以及 envelope 格式全部由 `sync-crypto.mjs` 负责。本地文件中
 * 只保存加密 envelope 和由系统保护的 DEK，不保存密码、恢复码或明文上游配置。
 * 任何远端 envelope 在写入前都必须先完成结构校验和 GCM 解密验证。
 *
 * English: Local storage boundary for the sync vault.
 *
 * This file owns disk files, atomic writes, backups, and Windows secure-storage integration.
 * Argon2id, AES-256-GCM, AAD, and the envelope format are owned by `sync-crypto.mjs`.
 * Local storage contains only the encrypted envelope and a system-protected DEK; it never
 * stores passwords, recovery codes, or plaintext upstream configuration. Every remote envelope
 * must pass structural validation and authenticated decryption before it is written locally.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createVault, openVaultWithDek, unlockVault, updateVault, validateVaultEnvelope } from "./vault.mjs";
import { stableJson } from "./sync-common.mjs";

/**
 * 中文：先写临时文件，再原子替换目标文件，避免进程中断时留下半个 vault.enc。
 * English: Write a temporary file before replacing the destination so an interruption cannot
 * leave a half-written vault.enc that would make future synchronization impossible.
 */
function atomicWrite(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, bytes);
  try { fs.renameSync(temporary, file); }
  catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* best effort cleanup */ }
    throw error;
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

  /**
   * 中文：读取并验证本地 envelope；文件存在但格式损坏时不能静默当成“未初始化”。
   * English: Read and validate the local envelope. A damaged existing file must not be silently
   * treated as an uninitialized vault, because that could overwrite recoverable sync state.
   */
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

  /**
   * 中文：DEK 只以系统保护后的 base64url 文本落盘，明文 Buffer 只在短暂内存窗口存在。
   * English: Persist the DEK only as system-protected base64url text; the plaintext Buffer is
   * intentionally kept to a short in-memory window.
   */
  #saveDek(dek) {
    if (!Buffer.isBuffer(dek) || dek.length !== 32) throw new Error("vault_invalid_dek");
    atomicWrite(this.localKeyFile, Buffer.from(this.protect(dek.toString("base64url"))));
  }

  /**
   * 中文：保存新 envelope 前留下带时间戳的旧副本，方便同步故障回退；随后用原子写入
   * 替换当前文件。备份只在本机，绝不上传到 GitHub。
   * English: Keep a timestamped local copy before replacing the envelope so a sync failure can
   * be rolled back. These backups stay on the device and are never uploaded to GitHub.
   */
  #saveEnvelope(envelope) {
    if (fs.existsSync(this.vaultFile)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
      const name = `vault-${new Date().toISOString().replace(/[:.]/g, "-")}.enc`;
      fs.copyFileSync(this.vaultFile, path.join(this.backupDir, name));
    }
    atomicWrite(this.vaultFile, Buffer.from(JSON.stringify(envelope, null, 2), "utf8"));
  }

  /**
   * 中文：vault、受保护 DEK 与同步配置作为一个可回滚提交处理。先保留各文件原字节，
   * 任一写入或配置提交失败时恢复原文件；首次初始化失败则删除本次新建的文件。
   * English: Treat the vault, protected DEK, and synchronized config as one rollback-capable
   * commit. Restore original bytes on any write or config-commit error, or remove newly created
   * files when first initialization fails.
   */
  #commitVaultState(envelope, dek, commitConfig) {
    const targets = [
      { file: this.vaultFile, bytes: Buffer.from(JSON.stringify(envelope, null, 2), "utf8") },
      { file: this.localKeyFile, bytes: Buffer.from(this.protect(dek.toString("base64url"))) },
    ];
    const previous = targets.map(({ file }) => ({ file, existed: fs.existsSync(file), bytes: fs.existsSync(file) ? fs.readFileSync(file) : null }));
    try {
      this.#saveEnvelope(envelope);
      atomicWrite(this.localKeyFile, targets[1].bytes);
      if (typeof commitConfig === "function") commitConfig();
    } catch (error) {
      for (const item of previous.reverse()) {
        try {
          if (item.existed) atomicWrite(item.file, item.bytes);
          else if (fs.existsSync(item.file)) fs.unlinkSync(item.file);
        } catch {
          // Preserve the original failure. The prior bytes remain available in the vault backup
          // for the envelope; callers receive the commit failure and must not report success.
        }
      }
      throw error;
    }
  }

  /**
   * 中文：首次初始化同时写入 envelope 和受保护 DEK；任一步失败都会抛错，避免形成
   * “有 vault 文件但没有本机解锁密钥”的假成功状态。
   * English: Initialization writes the envelope and protected DEK as one logical operation.
   * Any failure is surfaced instead of reporting success with an unusable local vault.
   */
  async initialize({ datasetId, secrets, password, kdfOptions } = {}) {
    if (this.readEnvelope()) throw new Error("vault_already_initialized");
    const created = await createVault({ datasetId, secrets, password, kdfOptions });
    try {
      this.#commitVaultState(created.envelope, created.dek);
      return { envelope: created.envelope, recoveryCode: created.recoveryCode };
    } finally { created.dek.fill(0); }
  }

  /**
   * 中文：密码或恢复码只用于解开远端/本地 wrapper；成功后立即把 DEK 保存进系统保护
   * 存储，随后清空内存副本。
   * English: A password or recovery code is used only to open a wrapper. After success the DEK
   * is immediately saved in secure storage and the in-memory copy is cleared.
   */
  async unlock({ password, recoveryCode } = {}) {
    const envelope = this.readEnvelope();
    if (!envelope) throw new Error("vault_not_initialized");
    const result = await unlockVault(envelope, { password, recoveryCode });
    try {
      this.#saveDek(result.dek);
      return { ok: true, keyEpoch: envelope.keyEpoch, vaultRevision: envelope.vaultRevision };
    } finally { result.dek.fill(0); }
  }

  /**
   * 中文：导入远端 envelope 的安全顺序：解析 → 校验数据集 → 尝试现有 DEK → 再要求
   * 用户凭证 → 解密并验证业务数据 → 调用提交前校验 → 最后才写本地文件。配置层
   * 仍在校验时，远端 vault 不得先落盘，避免 vault/config 形成跨层半提交状态。
   * English: Remote-import order is parse -> validate dataset -> try the existing DEK -> ask
   * for a credential -> decrypt and authenticate payload -> run the pre-commit validation ->
   * write local files last. The remote vault therefore cannot be persisted while configuration
   * validation is still pending, avoiding a cross-layer half-commit between vault and config.
   */
  async importEnvelope(bytes, { password = "", recoveryCode = "", expectedDatasetId = "", beforeCommit, commitConfig } = {}) {
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
      // 中文：同步引擎在这里检查公开配置与解密后的 secure 配置；回调失败时不执行任何
      // 本地写入。回调只能做校验，不应把明文 secrets 上传或持久化到云端。
      // English: SyncEngine validates public metadata against the decrypted secure config here;
      // if it fails, no local write is performed. The callback is validation-only and must never
      // upload or persist the plaintext secrets.
      if (typeof beforeCommit === "function") await beforeCommit({ envelope: remote, secrets });
      this.#commitVaultState(remote, dek, typeof commitConfig === "function" ? () => commitConfig({ envelope: remote, secrets }) : undefined);
      return { envelope: remote, secrets };
    } finally { dek.fill(0); }
  }

  /**
   * 中文：生成待上传的 envelope。只有明文业务内容真正变化时才提升 vaultRevision；
   * 没有本机 DEK 或无法解密时抛出稳定错误，让同步引擎保留远端旧资产而不是丢掉它。
   * English: Prepare the envelope for upload. The vault revision advances only when plaintext
   * business data changes. If the local DEK is unavailable, throw a stable error so SyncEngine
   * preserves the previous remote asset instead of publishing a manifest that drops it.
   */
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

  /**
   * 中文：状态检查不能只看文件是否存在，必须实际用本机 DEK 验证 GCM。否则 UI 会把
   * 已损坏或无法解锁的 vault 误报为“已连接”，同步随后才会突然失败。
   * English: Status cannot rely on file existence; it must authenticate the envelope with the
   * local DEK. Otherwise the UI may report a broken vault as connected and fail unexpectedly
   * during the next synchronization.
   */
  status() {
    try {
      const envelope = this.readEnvelope();
      let unlocked = false;
      let error = "";
      if (envelope && fs.existsSync(this.localKeyFile)) {
        try {
          const dek = this.#readDek();
          if (dek) {
            openVaultWithDek(envelope, dek);
            unlocked = true;
          }
          dek?.fill(0);
        } catch (reason) {
          // 中文：文件存在不等于密钥可用；必须实际尝试解密，界面才能显示正确的恢复入口。
          // English: File existence does not mean the key is usable; perform a real decrypt attempt
          // so the UI can show the correct recovery action instead of a false connected state.
          error = String(reason?.message || reason);
        }
      }
      return {
        initialized: Boolean(envelope),
        unlocked,
        datasetId: envelope?.datasetId || "",
        keyEpoch: Number(envelope?.keyEpoch || 0),
        vaultRevision: Number(envelope?.vaultRevision || 0),
        ...(error ? { error } : {}),
      };
    } catch (error) { return { initialized: true, unlocked: false, error: String(error?.message || error) }; }
  }
}
