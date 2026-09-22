/**
 * 中文：同步保险库的兼容入口。
 *
 * 真正的 Argon2id、AES-256-GCM、AAD、DEK wrapper 和 payload 加解密实现集中在
 * `sync-crypto.mjs`。这里保留原来的模块路径，只做显式 re-export，确保旧的本地
 * 代码、测试和外部调用方不需要同时迁移，也避免因为“拆模块”改变同步格式。
 *
 * English: Compatibility entry point for the sync vault.
 *
 * The actual Argon2id, AES-256-GCM, AAD, DEK-wrapper, and payload encryption code lives in
 * `sync-crypto.mjs`. This file keeps the original import path and only re-exports the public
 * API, so existing local code, tests, and callers can migrate independently without changing
 * the persisted sync format.
 */
export {
  changeVaultPassword,
  createRecoveryCode,
  createVault,
  openVaultWithDek,
  unlockVault,
  updateVault,
  validateVaultEnvelope,
  vaultKdfDefaults,
} from "./sync-crypto.mjs";
