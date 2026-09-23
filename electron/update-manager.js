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
    fs.rmSync(file, { force: true });
    fs.renameSync(temporary, file);
  }
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}

function safeVersion(value) {
  const clean = String(value || "").replace(/^v/i, "").trim();
  if (!/^\d+(?:\.\d+){1,3}$/.test(clean)) throw new Error("update_invalid_version");
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

function criticalDataIsPresent(runtimeDataRoot) {
  const gateway = path.join(runtimeDataRoot, "gateway-data");
  return fs.existsSync(path.join(gateway, "config.json"))
    && fs.existsSync(path.join(gateway, ".gateway-secret"))
    && fs.existsSync(path.join(gateway, "device.json"));
}

function connectedSyncNeedsCredential(gatewayRoot) {
  const state = readJson(path.join(gatewayRoot, "sync-state.json"), {});
  return state?.enabled === true && !fs.existsSync(path.join(gatewayRoot, ".github-token"));
}

function restoreMissingSyncCredential(backupRoot, destination) {
  const backupGateway = path.join(backupRoot, "gateway-data");
  const destinationGateway = path.join(destination, "gateway-data");
  const backupState = readJson(path.join(backupGateway, "sync-state.json"), {});
  if (backupState?.enabled !== true) return false;
  const credentialBackup = path.join(backupGateway, ".github-token");
  if (!fs.existsSync(credentialBackup)) throw new Error("update_recovery_sync_credential_missing");
  const oldDevice = readJson(path.join(backupGateway, "device.json"), {});
  const currentDevice = readJson(path.join(destinationGateway, "device.json"), {});
  if (!oldDevice.deviceId || oldDevice.deviceId !== currentDevice.deviceId) return false;
  const destinationStateFile = path.join(destinationGateway, "sync-state.json");
  const destinationState = readJson(destinationStateFile);
  // An explicit disconnect after backup is newer user intent; never reconnect it silently.
  if (destinationState && destinationState.enabled !== true) return false;
  if (fs.existsSync(path.join(destinationGateway, ".github-token"))) return false;
  if (!destinationState) fs.copyFileSync(path.join(backupGateway, "sync-state.json"), destinationStateFile);
  fs.copyFileSync(credentialBackup, path.join(destinationGateway, ".github-token"));
  return true;
}

function createUpdateBackup({ runtimeDataRoot, updateRecoveryRoot, legacyUserDataRoot, targetVersion }) {
  const version = safeVersion(targetVersion);
  const sourceRoot = path.resolve(runtimeDataRoot);
  if (!criticalDataIsPresent(sourceRoot)) throw new Error("update_source_data_incomplete");
  if (connectedSyncNeedsCredential(path.join(sourceRoot, "gateway-data"))) throw new Error("update_source_sync_credential_missing");
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const backupRoot = path.join(path.resolve(updateRecoveryRoot), `backup-${stamp}-v${version}`);
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
  const destination = path.resolve(runtimeDataRoot);
  const pointer = readJson(recoveryPointerFile(legacyUserDataRoot));
  if (!pointer?.backupRoot) return { restored: false, reason: "no-update-backup" };
  const backupRoot = path.resolve(String(pointer.backupRoot));
  const manifest = readJson(path.join(backupRoot, "recovery-manifest.json"));
  if (!manifest || path.resolve(String(manifest.backupRoot || "")) !== backupRoot) return { restored: false, reason: "invalid-update-backup" };
  const targetVersion = safeVersion(manifest.targetVersion || pointer.targetVersion);
  // 中文：恢复指针是一次性事务。首次启动已经消费后，后续启动绝不能再次用旧备份覆盖新数据。
  // English: A recovery pointer is a one-shot transaction. Once consumed, later launches must never
  // reuse the old backup to overwrite newer local data.
  if (pointer.restoredAt) {
    if (!criticalDataIsPresent(destination)) {
      // 中文：1.31 的首次恢复可能在安装器完成后留下“已消费指针”，但网关数据尚未完整落盘，
      // 这必须允许一次受版本限制的修复恢复；否则主进程会在启动阶段直接崩溃。
      // English: A 1.31 first restore could leave a consumed pointer while gateway data was not
      // fully materialized. Allow one version-bounded repair instead of crashing the main process.
      if (pointer.recoveryRepairAt || !canRepairConsumedRecovery(pointer.targetVersion || manifest.targetVersion, currentVersion)) {
        throw new Error("update_recovery_data_missing_after_consumption");
      }
      const sourceGateway = path.join(backupRoot, "gateway-data");
      if (!criticalDataIsPresent(backupRoot)) throw new Error("update_recovery_backup_incomplete");
      const destinationGateway = path.join(destination, "gateway-data");
      if (fs.existsSync(destinationGateway) && fs.readdirSync(destinationGateway).length) {
        throw new Error("update_recovery_partial_data_after_consumption");
      }
      fs.mkdirSync(destination, { recursive: true });
      fs.cpSync(sourceGateway, destinationGateway, { recursive: true, errorOnExist: false });
      const settingsBackup = path.join(backupRoot, "desktop-settings.json");
      const settingsDestination = path.join(destination, "desktop-settings.json");
      if (fs.existsSync(settingsBackup) && !fs.existsSync(settingsDestination)) fs.copyFileSync(settingsBackup, settingsDestination);
      if (!criticalDataIsPresent(destination)) throw new Error("update_recovery_repair_verification_failed");
      atomicJson(recoveryPointerFile(legacyUserDataRoot), {
        ...manifest,
        ...pointer,
        recoveryRepairAt: new Date().toISOString(),
        repairedTo: destination,
        restoreReason: "gateway-data-repaired-after-consumption",
      });
      return { restored: true, reason: "gateway-data-repaired-after-consumption", backupRoot, targetVersion };
    }
    return { restored: false, reason: "update-backup-already-consumed", backupRoot };
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
  const sourceGateway = path.join(backupRoot, "gateway-data");
  if (!criticalDataIsPresent(backupRoot)) return { restored: false, reason: "backup-data-incomplete", backupRoot };
  const destinationGateway = path.join(destination, "gateway-data");
  if (fs.existsSync(destinationGateway) && fs.readdirSync(destinationGateway).length) {
    return { restored: false, reason: "partial-current-data-needs-review", backupRoot };
  }
  fs.mkdirSync(destination, { recursive: true });
  fs.cpSync(sourceGateway, destinationGateway, { recursive: true, errorOnExist: false });
  if (fs.existsSync(settingsBackup) && !fs.existsSync(settingsDestination)) fs.copyFileSync(settingsBackup, settingsDestination);
  if (!criticalDataIsPresent(destination)) throw new Error("update_restore_verification_failed");
  atomicJson(recoveryPointerFile(legacyUserDataRoot), {
    ...manifest,
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
  downloadVerifiedInstaller,
  normalizeSha256,
  recoveryPointerFile,
  restoreUpdateBackupIfNeeded,
  canRepairConsumedRecovery,
  safeVersion,
  sha256File,
};
