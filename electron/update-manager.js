/**
 * 中文：更新下载与数据恢复工具。更新必须先校验安装包，再把关键数据备份到安装目录之外。
 * 同一设备只允许恢复原客户端 Key；任何失败都应停止安装，不能用空目录继续运行。
 * English: Update download and recovery helpers. Verify the installer first, then copy critical data
 * outside the install folder. Same-device updates restore existing client keys and abort on unsafe states.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");

const POINTER_NAME = "cherry-ai-connect-update-recovery.json";
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "github-releases.githubusercontent.com",
]);

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  // 中文：Windows 不能总是用 rename 覆盖现有文件；先尝试原子替换，失败时只删除明确的目标文件后再移动。
  // English: Windows cannot always replace an existing file with rename; retry against the exact target only.
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    if (!fs.existsSync(file)) throw error;
    // Preserve the previous recovery pointer if Windows cannot replace the target in place.
    // A crash between removing the target and renaming the temporary file must remain recoverable.
    fs.copyFileSync(file, `${file}.previous`);
    fs.rmSync(file, { force: true });
    try { fs.renameSync(temporary, file); }
    catch (replaceError) {
      try { fs.copyFileSync(`${file}.previous`, file); }
      catch { /* the .previous copy remains available for startup recovery */ }
      throw replaceError;
    }
  }
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function regularFile(file) {
  try { return fs.lstatSync(file).isFile(); }
  catch { return false; }
}

function directory(file) {
  try { return fs.lstatSync(file).isDirectory(); }
  catch { return false; }
}

function validJsonObjectFile(file) {
  return regularFile(file) && isPlainObject(readJson(file));
}

function validSecretFile(file) {
  if (!regularFile(file)) return false;
  try { return fs.readFileSync(file, "utf8").trim().length > 0; }
  catch { return false; }
}

function validDeviceFile(file) {
  const device = readJson(file);
  return regularFile(file)
    && isPlainObject(device)
    && typeof device.deviceId === "string"
    && device.deviceId.length > 0
    && device.deviceId.length <= 256
    && device.deviceId.trim() === device.deviceId
    && !device.deviceId.includes("\0");
}

function absolutePath(value, errorCode = "update_invalid_path") {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0") || !path.isAbsolute(value)) {
    throw new Error(errorCode);
  }
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) throw new Error(errorCode);
  return resolved;
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function pathContains(parent, child, allowEqual = false) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  if (relative === "") return allowEqual;
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function pathsOverlap(left, right) {
  return samePath(left, right) || pathContains(left, right) || pathContains(right, left);
}

function safeVersion(value) {
  const clean = String(value || "").replace(/^v/i, "").trim();
  if (!/^\d+(?:\.\d+){1,3}$/.test(clean)) throw new Error("update_invalid_version");
  const parts = clean.split(".");
  if (parts.some((part) => part.length > 9 || !Number.isSafeInteger(Number(part)))) {
    throw new Error("update_invalid_version");
  }
  return clean;
}

function compareVersions(left, right) {
  const a = safeVersion(left).split(".").map(Number);
  const b = safeVersion(right).split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const nextA = a[index] || 0;
    const nextB = b[index] || 0;
    if (nextA !== nextB) return nextA > nextB ? 1 : -1;
  }
  return 0;
}

function canRepairConsumedRecovery(targetVersion, currentVersion) {
  if (!currentVersion) return false;
  const target = safeVersion(targetVersion).split(".").map(Number);
  const current = safeVersion(currentVersion).split(".").map(Number);
  if ((target[0] || 0) !== (current[0] || 0)) return false;
  const targetMinor = target[1] || 0;
  const currentMinor = current[1] || 0;
  return targetMinor === currentMinor || targetMinor === currentMinor - 1;
}

function recoveryPointerFile(legacyUserDataRoot) {
  return path.join(path.resolve(legacyUserDataRoot), POINTER_NAME);
}

function readRecoveryPointer(legacyUserDataRoot) {
  const file = recoveryPointerFile(legacyUserDataRoot);
  return readJson(file) || readJson(`${file}.previous`);
}

function nonEmptyFile(file) {
  try { const info = fs.lstatSync(file); return info.isFile() && info.size > 0; }
  catch { return false; }
}

function gatewayCoreDataIsPresent(runtimeDataRoot) {
  const gateway = path.join(runtimeDataRoot, "gateway-data");
  if (!directory(gateway)) return false;
  const syncStateFile = path.join(gateway, "sync-state.json");
  const tokenFile = path.join(gateway, ".github-token");
  const usageJson = path.join(gateway, "usage.json");
  const usageDb = path.join(gateway, "usage.db");
  return validJsonObjectFile(path.join(gateway, "config.json"))
    && validSecretFile(path.join(gateway, ".gateway-secret"))
    && validDeviceFile(path.join(gateway, "device.json"))
    // An existing device without its ledger must not silently start with empty usage history.
    && (!fs.existsSync(usageJson) || validJsonObjectFile(usageJson))
    && (nonEmptyFile(usageDb) || validJsonObjectFile(usageJson))
    && (!fs.existsSync(syncStateFile)
      || (validJsonObjectFile(syncStateFile) && (readJson(syncStateFile).enabled === undefined || typeof readJson(syncStateFile).enabled === "boolean")))
    && (!fs.existsSync(tokenFile) || validSecretFile(tokenFile))
    && (!fs.existsSync(path.join(runtimeDataRoot, "desktop-settings.json"))
      || validJsonObjectFile(path.join(runtimeDataRoot, "desktop-settings.json")));
}

function criticalDataIsPresent(runtimeDataRoot) {
  if (!gatewayCoreDataIsPresent(runtimeDataRoot)) return false;
  const gateway = path.join(runtimeDataRoot, "gateway-data");
  const syncStateFile = path.join(gateway, "sync-state.json");
  if (!fs.existsSync(syncStateFile)) return true;
  const syncState = readJson(syncStateFile);
  if (!isPlainObject(syncState)) return false;
  return syncState.enabled !== true || validSecretFile(path.join(gateway, ".github-token"));
}

function hasPartialGatewayData(runtimeDataRoot) {
  const gateway = path.join(runtimeDataRoot, "gateway-data");
  return fs.existsSync(gateway) && fs.readdirSync(gateway).length > 0 && !criticalDataIsPresent(runtimeDataRoot);
}

// Copy to a staging directory, verify it, then rename only into an absent or empty gateway directory.
// Never replace a current gateway, and never delete the source snapshot.
function copyGatewayIntoEmptyDestination(sourceRoot, destinationRoot) {
  if (!gatewayCoreDataIsPresent(sourceRoot)) throw new Error("update_recovery_backup_incomplete");
  if (connectedSyncNeedsCredential(path.join(sourceRoot, "gateway-data"))) {
    throw new Error("update_recovery_sync_credential_missing");
  }
  const destinationGateway = path.join(destinationRoot, "gateway-data");
  if (fs.existsSync(destinationGateway) && (!directory(destinationGateway) || fs.readdirSync(destinationGateway).length)) {
    throw new Error("update_recovery_partial_data_needs_review");
  }
  fs.mkdirSync(destinationRoot, { recursive: true });
  const stagingGateway = path.join(destinationRoot, `.gateway-data-${process.pid}-${crypto.randomBytes(4).toString("hex")}.tmp`);
  try {
    fs.cpSync(path.join(sourceRoot, "gateway-data"), stagingGateway, { recursive: true, errorOnExist: true });
    for (const name of ["config.json", ".gateway-secret", "device.json"]) {
      if ((name === ".gateway-secret" && !validSecretFile(path.join(stagingGateway, name)))
        || (name === "device.json" && !validDeviceFile(path.join(stagingGateway, name)))
        || (name === "config.json" && !validJsonObjectFile(path.join(stagingGateway, name)))) {
        throw new Error("update_recovery_copy_incomplete");
      }
    }
    if (!nonEmptyFile(path.join(stagingGateway, "usage.db")) && !validJsonObjectFile(path.join(stagingGateway, "usage.json"))) {
      throw new Error("update_recovery_usage_missing");
    }
    if (fs.existsSync(destinationGateway)) fs.rmdirSync(destinationGateway);
    fs.renameSync(stagingGateway, destinationGateway);
    const settingsSource = path.join(sourceRoot, "desktop-settings.json");
    const settingsDestination = path.join(destinationRoot, "desktop-settings.json");
    if (fs.existsSync(settingsSource) && !fs.existsSync(settingsDestination)) fs.copyFileSync(settingsSource, settingsDestination);
    if (!criticalDataIsPresent(destinationRoot)) throw new Error("update_recovery_copy_incomplete");
  } finally {
    if (fs.existsSync(stagingGateway)) fs.rmSync(stagingGateway, { recursive: true, force: true });
  }
}

function validateRecoveryManifest(manifest, pointer, backupRoot, destination, expectedSourceRoot) {
  if (!isPlainObject(manifest) || manifest.schemaVersion !== undefined && manifest.schemaVersion !== 1) return null;
  try {
    const manifestBackupRoot = absolutePath(manifest.backupRoot);
    const sourceRuntimeDataRoot = absolutePath(manifest.sourceRuntimeDataRoot);
    const targetVersion = safeVersion(manifest.targetVersion);
    if (!samePath(manifestBackupRoot, backupRoot) || !directory(backupRoot) || !regularFile(path.join(backupRoot, "recovery-manifest.json"))) return null;
    if (fs.existsSync(sourceRuntimeDataRoot) && !directory(sourceRuntimeDataRoot)) return null;
    if (expectedSourceRoot && !samePath(sourceRuntimeDataRoot, expectedSourceRoot)) return null;
    if (destination && !samePath(sourceRuntimeDataRoot, destination)) return null;
    if (pathsOverlap(sourceRuntimeDataRoot, backupRoot)) return null;
    if (pointer.targetVersion !== undefined && compareVersions(targetVersion, pointer.targetVersion) !== 0) return null;
    if (pointer.sourceRuntimeDataRoot !== undefined
      && !samePath(sourceRuntimeDataRoot, absolutePath(pointer.sourceRuntimeDataRoot))) return null;
    return { ...manifest, backupRoot: manifestBackupRoot, sourceRuntimeDataRoot, targetVersion };
  } catch { return null; }
}

function markRecoveryAttempt(legacyUserDataRoot, pointer, field, errorCode) {
  if (pointer[field]) throw new Error(errorCode);
  const updated = { ...pointer, [field]: new Date().toISOString() };
  atomicJson(recoveryPointerFile(legacyUserDataRoot), updated);
  return updated;
}

function migrateLegacyInstallDataIfNeeded({ legacyInstallDataRoot, runtimeDataRoot }) {
  const source = path.resolve(legacyInstallDataRoot);
  const destination = path.resolve(runtimeDataRoot);
  if (source === destination || !fs.existsSync(source) || criticalDataIsPresent(destination)) {
    return { migrated: false };
  }
  if (!criticalDataIsPresent(source)) {
    if (hasPartialGatewayData(source)) throw new Error("update_legacy_install_data_incomplete");
    return { migrated: false };
  }
  copyGatewayIntoEmptyDestination(source, destination);
  return { migrated: true, source };
}

function inspectManualUpdateRecovery({ runtimeDataRoot, legacyUserDataRoot, updateRecoveryRoot, legacyInstallDataRoot }) {
  let destination;
  let recoveryRoot;
  try {
    destination = absolutePath(runtimeDataRoot);
    recoveryRoot = absolutePath(updateRecoveryRoot);
  } catch { return { available: false, reason: "invalid-update-backup" }; }
  if (fs.existsSync(recoveryRoot) && !directory(recoveryRoot)) return { available: false, reason: "backup-outside-recovery-root" };
  if (criticalDataIsPresent(destination)) return { available: false, reason: "current-data-present" };
  if (hasPartialGatewayData(destination)) return { available: false, reason: "partial-current-data-needs-review" };
  const pointer = readRecoveryPointer(legacyUserDataRoot);
  if (!isPlainObject(pointer) || !pointer.backupRoot) return { available: false, reason: "no-update-backup" };
  let backupRoot;
  try { backupRoot = absolutePath(pointer.backupRoot); }
  catch { return { available: false, reason: "backup-outside-recovery-root" }; }
  const relative = path.relative(recoveryRoot, backupRoot);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return { available: false, reason: "backup-outside-recovery-root" };
  }
  const manifest = readJson(path.join(backupRoot, "recovery-manifest.json"));
  if (!isPlainObject(manifest)) {
    return { available: false, reason: "invalid-update-backup" };
  }
  try {
    if (!samePath(absolutePath(manifest.backupRoot), backupRoot)) return { available: false, reason: "invalid-update-backup" };
    if (pointer.targetVersion !== undefined && compareVersions(manifest.targetVersion, pointer.targetVersion) !== 0) {
      return { available: false, reason: "update-backup-version-mismatch" };
    }
    if (legacyInstallDataRoot && !samePath(absolutePath(manifest.sourceRuntimeDataRoot), legacyInstallDataRoot)) {
      return { available: false, reason: "update-backup-source-mismatch" };
    }
  } catch { return { available: false, reason: "invalid-update-backup" }; }
  const validated = validateRecoveryManifest(manifest, pointer, backupRoot, null, legacyInstallDataRoot);
  if (!validated) return { available: false, reason: "invalid-update-backup" };
  if (!criticalDataIsPresent(backupRoot) || connectedSyncNeedsCredential(path.join(backupRoot, "gateway-data"))) {
    return { available: false, reason: "update-backup-incomplete" };
  }
  return { available: true, backupRoot, targetVersion: validated.targetVersion, createdAt: validated.createdAt };
}

function restoreUpdateBackupWithConsent(options) {
  const candidate = inspectManualUpdateRecovery(options);
  if (!candidate.available) throw new Error(candidate.reason);
  copyGatewayIntoEmptyDestination(candidate.backupRoot, path.resolve(options.runtimeDataRoot));
  const pointerFile = recoveryPointerFile(options.legacyUserDataRoot);
  atomicJson(pointerFile, {
    ...readRecoveryPointer(options.legacyUserDataRoot),
    manualRecoveryAt: new Date().toISOString(),
    manuallyRecoveredTo: path.resolve(options.runtimeDataRoot),
  });
  return { restored: true, reason: "manual-update-backup-restored", ...candidate };
}

function connectedSyncNeedsCredential(gatewayRoot) {
  const stateFile = path.join(gatewayRoot, "sync-state.json");
  if (!fs.existsSync(stateFile)) return false;
  const state = readJson(stateFile);
  if (!isPlainObject(state) || (state.enabled !== undefined && typeof state.enabled !== "boolean")) return true;
  return state.enabled === true && !validSecretFile(path.join(gatewayRoot, ".github-token"));
}

function restoreMissingSyncCredential(backupRoot, destination) {
  const backupGateway = path.join(backupRoot, "gateway-data");
  const destinationGateway = path.join(destination, "gateway-data");
  const backupStateFile = path.join(backupGateway, "sync-state.json");
  const backupState = readJson(backupStateFile);
  if (fs.existsSync(backupStateFile) && !isPlainObject(backupState)) throw new Error("update_recovery_sync_credential_missing");
  if (backupState?.enabled !== true) return false;
  const credentialBackup = path.join(backupGateway, ".github-token");
  if (!validSecretFile(credentialBackup)) throw new Error("update_recovery_sync_credential_missing");
  const oldDevice = readJson(path.join(backupGateway, "device.json"));
  const currentDevice = readJson(path.join(destinationGateway, "device.json"));
  if (!validDeviceFile(path.join(backupGateway, "device.json")) || !validDeviceFile(path.join(destinationGateway, "device.json"))) {
    throw new Error("update_recovery_device_invalid");
  }
  if (oldDevice.deviceId !== currentDevice.deviceId) return false;
  const destinationStateFile = path.join(destinationGateway, "sync-state.json");
  const destinationState = readJson(destinationStateFile);
  // An explicit disconnect after backup is newer user intent; never reconnect it silently.
  if (destinationState && destinationState.enabled !== true) return false;
  if (validSecretFile(path.join(destinationGateway, ".github-token"))) return false;
  if (!destinationState) fs.copyFileSync(path.join(backupGateway, "sync-state.json"), destinationStateFile);
  fs.copyFileSync(credentialBackup, path.join(destinationGateway, ".github-token"));
  return true;
}

function createUpdateBackup({ runtimeDataRoot, updateRecoveryRoot, legacyUserDataRoot, targetVersion }) {
  const version = safeVersion(targetVersion);
  const sourceRoot = absolutePath(runtimeDataRoot);
  const recoveryRoot = absolutePath(updateRecoveryRoot);
  absolutePath(legacyUserDataRoot);
  if (pathsOverlap(sourceRoot, recoveryRoot)) throw new Error("update_recovery_path_invalid");
  if (fs.existsSync(recoveryRoot) && !directory(recoveryRoot)) throw new Error("update_recovery_path_invalid");
  if (!gatewayCoreDataIsPresent(sourceRoot)) throw new Error("update_source_data_incomplete");
  if (connectedSyncNeedsCredential(path.join(sourceRoot, "gateway-data"))) throw new Error("update_source_sync_credential_missing");
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const backupRoot = path.join(recoveryRoot, `backup-${stamp}-v${version}`);
  if (fs.existsSync(backupRoot)) throw new Error("update_backup_already_exists");
  fs.mkdirSync(backupRoot, { recursive: true });
  fs.cpSync(path.join(sourceRoot, "gateway-data"), path.join(backupRoot, "gateway-data"), { recursive: true, errorOnExist: true });
  const settingsSource = path.join(sourceRoot, "desktop-settings.json");
  if (fs.existsSync(settingsSource)) fs.copyFileSync(settingsSource, path.join(backupRoot, "desktop-settings.json"));
  const manifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    targetVersion: version,
    sourceRuntimeDataRoot: sourceRoot,
    backupRoot,
  };
  atomicJson(path.join(backupRoot, "recovery-manifest.json"), manifest);
  atomicJson(recoveryPointerFile(legacyUserDataRoot), manifest);
  return manifest;
}

function restoreUpdateBackupIfNeeded({ runtimeDataRoot, legacyUserDataRoot, currentVersion = "" }) {
  let destination;
  try { destination = absolutePath(runtimeDataRoot); }
  catch { return { restored: false, reason: "invalid-update-backup" }; }
  if (fs.existsSync(destination) && !directory(destination)) return { restored: false, reason: "invalid-update-backup" };
  const pointer = readRecoveryPointer(legacyUserDataRoot);
  if (!isPlainObject(pointer) || !pointer.backupRoot) return { restored: false, reason: "no-update-backup" };
  let backupRoot;
  try { backupRoot = absolutePath(pointer.backupRoot); }
  catch { return { restored: false, reason: "invalid-update-backup" }; }
  const manifest = readJson(path.join(backupRoot, "recovery-manifest.json"));
  // A consumed pointer may belong to the legacy manual-recovery layout, where the
  // old source directory is no longer the current destination. Keep validating the
  // absolute, non-overlapping source boundary, but defer the destination decision
  // until the one-shot consumed protocol below.
  const consumedPointer = Boolean(pointer.restoredAt);
  const validated = validateRecoveryManifest(
    manifest,
    pointer,
    backupRoot,
    consumedPointer ? null : destination,
    consumedPointer ? null : destination,
  );
  if (!validated) return { restored: false, reason: "invalid-update-backup" };
  const targetVersion = validated.targetVersion;
  // 中文：恢复指针是一次性事务。首次启动已经消费后，后续启动绝不能再次用旧备份覆盖新数据。
  // English: A recovery pointer is a one-shot transaction. Once consumed, later launches must never
  // reuse the old backup to overwrite newer local data.
  if (pointer.restoredAt) {
    if (!samePath(validated.sourceRuntimeDataRoot, destination)) {
      if (pointer.manualRecoveryAt) return { restored: false, reason: "manual-recovery-complete", backupRoot, targetVersion };
      throw new Error("update_recovery_data_missing_after_consumption");
    }
    if (gatewayCoreDataIsPresent(destination) && connectedSyncNeedsCredential(path.join(destination, "gateway-data"))) {
      if (pointer.syncCredentialRepairAttemptedAt) throw new Error("update_recovery_sync_credential_missing");
      const attemptedPointer = markRecoveryAttempt(legacyUserDataRoot, pointer, "syncCredentialRepairAttemptedAt", "update_recovery_sync_credential_missing");
      const syncCredentialRestored = restoreMissingSyncCredential(backupRoot, destination);
      if (connectedSyncNeedsCredential(path.join(destination, "gateway-data"))) throw new Error("update_recovery_sync_credential_missing");
      atomicJson(recoveryPointerFile(legacyUserDataRoot), {
        ...attemptedPointer,
        syncCredentialRepairAt: new Date().toISOString(),
        restoreReason: "sync-credential-restored",
      });
      return { restored: syncCredentialRestored, reason: syncCredentialRestored ? "sync-credential-restored" : "update-backup-already-consumed", backupRoot, targetVersion };
    }
    if (!criticalDataIsPresent(destination)) {
      // 中文：1.31 的首次恢复可能在安装器完成后留下“已消费指针”，但网关数据尚未完整落盘，
      // 这必须允许一次受版本限制的修复恢复；否则主进程会在启动阶段直接崩溃。
      // English: A 1.31 first restore could leave a consumed pointer while gateway data was not
      // fully materialized. Allow one version-bounded repair instead of crashing the main process.
      if (pointer.recoveryRepairAt || pointer.recoveryRepairAttemptedAt || !canRepairConsumedRecovery(targetVersion, currentVersion)) {
        throw new Error("update_recovery_data_missing_after_consumption");
      }
      if (!criticalDataIsPresent(backupRoot)) throw new Error("update_recovery_backup_incomplete");
      const attemptedPointer = markRecoveryAttempt(legacyUserDataRoot, pointer, "recoveryRepairAttemptedAt", "update_recovery_data_missing_after_consumption");
      copyGatewayIntoEmptyDestination(backupRoot, destination);
      if (!criticalDataIsPresent(destination)) throw new Error("update_recovery_repair_verification_failed");
      atomicJson(recoveryPointerFile(legacyUserDataRoot), {
        ...attemptedPointer,
        recoveryRepairAt: new Date().toISOString(),
        repairedTo: destination,
        restoreReason: "gateway-data-repaired-after-consumption",
      });
      return { restored: true, reason: "gateway-data-repaired-after-consumption", backupRoot, targetVersion };
    }
    if (pointer.syncCredentialRepairAttemptedAt) return { restored: false, reason: "update-backup-already-consumed", backupRoot, targetVersion };
    const syncCredentialRestored = restoreMissingSyncCredential(backupRoot, destination);
    if (connectedSyncNeedsCredential(path.join(destination, "gateway-data"))) throw new Error("update_recovery_sync_credential_missing");
    return { restored: syncCredentialRestored, reason: syncCredentialRestored ? "sync-credential-restored" : "update-backup-already-consumed", backupRoot };
  }
  if (currentVersion) {
    const versionRelation = compareVersions(targetVersion, currentVersion);
    if (versionRelation !== 0) {
      if (!criticalDataIsPresent(destination)) throw new Error("update_recovery_version_mismatch");
      return { restored: false, reason: versionRelation < 0 ? "stale-update-backup" : "future-update-backup", backupRoot, targetVersion };
    }
  }
  const settingsBackup = path.join(backupRoot, "desktop-settings.json");
  const settingsDestination = path.join(destination, "desktop-settings.json");
  // Existing settings may have changed since backup; only restore files the installer removed.
  let settingsRestored = false;
  if (fs.existsSync(settingsBackup) && !fs.existsSync(settingsDestination)) {
    fs.mkdirSync(destination, { recursive: true });
    fs.copyFileSync(settingsBackup, settingsDestination);
    settingsRestored = true;
  }
  if (gatewayCoreDataIsPresent(destination) && connectedSyncNeedsCredential(path.join(destination, "gateway-data"))) {
    if (pointer.automaticRecoveryAttemptedAt) throw new Error("update_recovery_sync_credential_missing");
    const attemptedPointer = markRecoveryAttempt(legacyUserDataRoot, pointer, "automaticRecoveryAttemptedAt", "update_recovery_sync_credential_missing");
    const syncCredentialRestored = restoreMissingSyncCredential(backupRoot, destination);
    if (connectedSyncNeedsCredential(path.join(destination, "gateway-data"))) throw new Error("update_recovery_sync_credential_missing");
    atomicJson(recoveryPointerFile(legacyUserDataRoot), {
      ...attemptedPointer,
      restoredAt: new Date().toISOString(),
      restoredTo: destination,
      restoreReason: "sync-credential-restored",
    });
    return { restored: syncCredentialRestored, reason: syncCredentialRestored ? "sync-credential-restored" : "current-data-preserved", backupRoot, settingsRestored: false, syncCredentialRestored };
  }
  if (criticalDataIsPresent(destination)) {
    const syncCredentialRestored = restoreMissingSyncCredential(backupRoot, destination);
    if (connectedSyncNeedsCredential(path.join(destination, "gateway-data"))) throw new Error("update_recovery_sync_credential_missing");
    atomicJson(recoveryPointerFile(legacyUserDataRoot), {
      ...manifest,
      restoredAt: new Date().toISOString(),
      restoredTo: destination,
      restoreReason: syncCredentialRestored ? "sync-credential-restored" : settingsRestored ? "desktop-settings-restored" : "current-data-preserved",
    });
    return { restored: settingsRestored || syncCredentialRestored, reason: syncCredentialRestored ? "sync-credential-restored" : settingsRestored ? "desktop-settings-restored" : "current-data-preserved", backupRoot, settingsRestored, syncCredentialRestored };
  }
  if (!criticalDataIsPresent(backupRoot)) return { restored: false, reason: "backup-data-incomplete", backupRoot };
  if (hasPartialGatewayData(destination)) {
    return { restored: false, reason: "partial-current-data-needs-review", backupRoot };
  }
  if (pointer.automaticRecoveryAttemptedAt) throw new Error("update_recovery_attempt_already_attempted");
  const attemptedPointer = markRecoveryAttempt(legacyUserDataRoot, pointer, "automaticRecoveryAttemptedAt", "update_recovery_attempt_already_attempted");
  copyGatewayIntoEmptyDestination(backupRoot, destination);
  if (!criticalDataIsPresent(destination)) throw new Error("update_restore_verification_failed");
  atomicJson(recoveryPointerFile(legacyUserDataRoot), {
    ...attemptedPointer,
    restoredAt: new Date().toISOString(),
    restoredTo: destination,
    restoreReason: "gateway-data-restored",
  });
  return { restored: true, backupRoot, targetVersion };
}

function normalizeSha256(value) {
  const clean = String(value || "").replace(/^sha256:/i, "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(clean) ? clean : "";
}

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

function downloadFile(url, destination, onProgress = () => {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error("update_too_many_redirects"));
    let parsed;
    try { parsed = new URL(String(url)); }
    catch { return reject(new Error("update_invalid_download_url")); }
    if (parsed.protocol !== "https:" || !ALLOWED_DOWNLOAD_HOSTS.has(parsed.hostname)) return reject(new Error("update_untrusted_download_url"));
    const request = https.get(parsed, { headers: { "user-agent": "Cherry-AI-Connect-Updater" }, timeout: 30000 }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        return downloadFile(new URL(response.headers.location, parsed).toString(), destination, onProgress, redirects + 1).then(resolve, reject);
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        return reject(new Error(`update_download_http_${response.statusCode || 0}`));
      }
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const temporary = `${destination}.${process.pid}.part`;
      const output = fs.createWriteStream(temporary, { flags: "w" });
      const total = Math.max(0, Number(response.headers["content-length"] || 0));
      let received = 0;
      response.on("data", (chunk) => {
        received += chunk.length;
        onProgress({ received, total, percent: total ? Math.min(100, Math.round((received / total) * 100)) : 0 });
      });
      response.pipe(output);
      output.on("finish", () => {
        output.close(() => {
          try { fs.renameSync(temporary, destination); resolve({ file: destination, bytes: received }); }
          catch (error) { reject(error); }
        });
      });
      output.on("error", (error) => { output.close(); try { fs.unlinkSync(temporary); } catch {} reject(error); });
    });
    request.on("timeout", () => request.destroy(new Error("update_download_timeout")));
    request.on("error", reject);
  });
}

async function downloadVerifiedInstaller({ asset, destination, onProgress }) {
  const expected = normalizeSha256(asset?.sha256 || asset?.digest);
  if (!expected) throw new Error("update_checksum_missing");
  const result = await downloadFile(asset.url, destination, onProgress);
  const actual = sha256File(destination);
  if (actual !== expected) {
    try { fs.unlinkSync(destination); } catch {}
    throw new Error("update_checksum_mismatch");
  }
  return { ...result, sha256: actual };
}

module.exports = {
  createUpdateBackup,
  criticalDataIsPresent,
  connectedSyncNeedsCredential,
  downloadVerifiedInstaller,
  hasPartialGatewayData,
  inspectManualUpdateRecovery,
  migrateLegacyInstallDataIfNeeded,
  normalizeSha256,
  recoveryPointerFile,
  restoreUpdateBackupWithConsent,
  restoreUpdateBackupIfNeeded,
  canRepairConsumedRecovery,
  safeVersion,
  sha256File,
};
