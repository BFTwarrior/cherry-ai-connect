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

function recoveryPointerFile(legacyUserDataRoot) {
  return path.join(path.resolve(legacyUserDataRoot), POINTER_NAME);
}

function criticalDataIsPresent(runtimeDataRoot) {
  const gateway = path.join(runtimeDataRoot, "gateway-data");
  return fs.existsSync(path.join(gateway, "config.json"))
    && fs.existsSync(path.join(gateway, ".gateway-secret"))
    && fs.existsSync(path.join(gateway, "device.json"));
}

function createUpdateBackup({ runtimeDataRoot, updateRecoveryRoot, legacyUserDataRoot, targetVersion }) {
  const version = safeVersion(targetVersion);
  const sourceRoot = path.resolve(runtimeDataRoot);
  if (!criticalDataIsPresent(sourceRoot)) throw new Error("update_source_data_incomplete");
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

function restoreUpdateBackupIfNeeded({ runtimeDataRoot, legacyUserDataRoot }) {
  const destination = path.resolve(runtimeDataRoot);
  const pointer = readJson(recoveryPointerFile(legacyUserDataRoot));
  if (!pointer?.backupRoot) return { restored: false, reason: "no-update-backup" };
  const backupRoot = path.resolve(String(pointer.backupRoot));
  const manifest = readJson(path.join(backupRoot, "recovery-manifest.json"));
  if (!manifest || path.resolve(String(manifest.backupRoot || "")) !== backupRoot) return { restored: false, reason: "invalid-update-backup" };
  if (criticalDataIsPresent(destination)) return { restored: false, reason: "current-data-preserved", backupRoot };
  const sourceGateway = path.join(backupRoot, "gateway-data");
  if (!criticalDataIsPresent(backupRoot)) return { restored: false, reason: "backup-data-incomplete", backupRoot };
  const destinationGateway = path.join(destination, "gateway-data");
  if (fs.existsSync(destinationGateway) && fs.readdirSync(destinationGateway).length) {
    return { restored: false, reason: "partial-current-data-needs-review", backupRoot };
  }
  fs.mkdirSync(destination, { recursive: true });
  fs.cpSync(sourceGateway, destinationGateway, { recursive: true, errorOnExist: false });
  const settingsBackup = path.join(backupRoot, "desktop-settings.json");
  const settingsDestination = path.join(destination, "desktop-settings.json");
  if (fs.existsSync(settingsBackup) && !fs.existsSync(settingsDestination)) fs.copyFileSync(settingsBackup, settingsDestination);
  if (!criticalDataIsPresent(destination)) throw new Error("update_restore_verification_failed");
  atomicJson(recoveryPointerFile(legacyUserDataRoot), { ...manifest, restoredAt: new Date().toISOString(), restoredTo: destination });
  return { restored: true, backupRoot, targetVersion: String(manifest.targetVersion || "") };
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
  safeVersion,
  sha256File,
};
