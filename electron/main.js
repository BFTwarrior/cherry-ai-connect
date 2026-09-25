/**
 * 中文：Electron 主进程负责创建桌面窗口、托盘、开机启动和本地网关生命周期。
 * English: The Electron main process owns the desktop window, tray, auto-start, and local gateway lifecycle.
 */
const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, shell, clipboard, safeStorage, powerMonitor, dialog } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const { pathToFileURL } = require("node:url");
const { chooseGatewayPort } = require("./port-selector");
const { resolveRuntimePaths } = require("./runtime-paths");
const {
  createUpdateBackup,
  criticalDataIsPresent,
  connectedSyncNeedsCredential,
  downloadVerifiedInstaller,
  hasPartialGatewayData,
  inspectManualUpdateRecovery,
  migrateLegacyInstallDataIfNeeded,
  restoreUpdateBackupIfNeeded,
  restoreUpdateBackupWithConsent,
} = require("./update-manager");
const { expandedReleaseAsset, releaseBodySha256, releasePageMetadata } = require("./release-metadata");
const { buildClientImportDeepLink } = require("./client-import-links.cjs");
const {
  CODEX_USAGE_BINARY,
  resolveExecutable,
  startCodexUsageService,
  stopCodexUsageService,
} = require("./codex-usage-process.cjs");

const execFileAsync = promisify(execFile);
const DEFAULT_GATEWAY_PORT = 27891;
const RELEASE_API = "https://api.github.com/repos/BFTwarrior/cherry-ai-connect/releases/latest";
const RELEASE_PAGE_PREFIX = "https://github.com/BFTwarrior/cherry-ai-connect/";
const RELEASE_LATEST_PAGE = `${RELEASE_PAGE_PREFIX}releases/latest`;

let gatewayModule;
let mainWindow;
let tray;
let quitting = false;
let shutdownComplete = false;
let currentGatewayPort = DEFAULT_GATEWAY_PORT;
let syncManager;
let majorSyncTimer;
let gatewayResetRun;
let updateRun;
let updateSyncDirty = false;
let updateSyncPaused = false;
let pendingShowWindow = false;
let mainWindowReady = false;
let codexUsageProcess;
// 中文：更新任务跨页面存在；主进程保存状态和单调序号，渲染层卸载不会取消任务或回退进度。
// English: Updates outlive renderer pages; the main process owns the state and monotonic sequence
// so unmounting a page cannot cancel the task or move its progress backward.
let updateStatus = "idle";
let lastUpdateProgress = null;
let updateProgressSequence = 0;
let lastUpdateRelease = null;

// 中文：正式版把运行数据放在安装目录旁，用户选择 D 盘后不会把主要缓存留在 C 盘。
// English: Packaged builds keep runtime data beside the installation so a D-drive install stays on D.
const legacyUserDataRoot = app.getPath("userData");
const { runtimeDataRoot, legacyInstallDataRoot, browserCacheRoot, gatewayDataRoot, updateRecoveryRoot } = resolveRuntimePaths({
  isPackaged: app.isPackaged,
  executablePath: process.execPath,
  moduleDirectory: __dirname,
});
// Keep runtime data outside the installer-owned directory. Migrate surviving data before reading
// the recovery pointer; a stale, consumed pointer must never replace a newer local copy.
let updateRestoreResult = { restored: false, reason: "not-attempted" };
let startupRecoveryError = null;
const manualRecoveryOptions = { runtimeDataRoot, legacyUserDataRoot, updateRecoveryRoot, legacyInstallDataRoot };
try {
  if (app.isPackaged) migrateLegacyInstallDataIfNeeded({ legacyInstallDataRoot, runtimeDataRoot });
  migrateLegacyInstallDataIfNeeded({ legacyInstallDataRoot: legacyUserDataRoot, runtimeDataRoot });
  updateRestoreResult = restoreUpdateBackupIfNeeded({ runtimeDataRoot, legacyUserDataRoot, currentVersion: app.getVersion() });
  if (hasPartialGatewayData(runtimeDataRoot)
    || (!criticalDataIsPresent(runtimeDataRoot) && updateRestoreResult.reason !== "no-update-backup")) {
    throw new Error(hasPartialGatewayData(runtimeDataRoot) ? "runtime_data_incomplete" : updateRestoreResult.reason);
  }
  if (criticalDataIsPresent(runtimeDataRoot) && connectedSyncNeedsCredential(gatewayDataRoot)) {
    throw new Error("update_recovery_sync_credential_missing");
  }
  if (updateRestoreResult.restored) console.info(`已恢复更新前数据：${updateRestoreResult.backupRoot}`);
} catch (error) {
  startupRecoveryError = error;
  console.error("Update recovery needs attention:", error);
}
try {
  fs.mkdirSync(runtimeDataRoot, { recursive: true });
  app.setPath("userData", runtimeDataRoot);
  app.setPath("sessionData", browserCacheRoot);
} catch (error) {
  startupRecoveryError ||= error;
  console.error("Runtime data path needs attention:", error);
}

async function resolveStartupRecovery() {
  if (!startupRecoveryError) return true;
  let candidate;
  try { candidate = inspectManualUpdateRecovery(manualRecoveryOptions); }
  catch (error) { candidate = { available: false, reason: String(error?.message || error) }; }
  const buttons = candidate.available ? ["退出并保留现场", "恢复旧备份并启动"] : ["退出并保留现场"];
  const detail = candidate.available
    ? `当前数据目录不完整。找到 ${candidate.targetVersion} 版更新备份（${candidate.createdAt || "时间未知"}）。备份之后产生的本地记录可能不在其中；恢复只会写入空数据目录，不会删除备份。\n\n备份位置：${candidate.backupRoot}`
    : `当前数据目录不完整，未找到可安全自动恢复的备份。现有文件均已保留，请先核对数据目录和旧备份。\n\n错误：${String(startupRecoveryError?.message || startupRecoveryError)}\n备份状态：${candidate.reason}`;
  const { response } = await dialog.showMessageBox({
    type: "warning",
    title: "Cherry AI 连接中心：本地数据保护",
    message: "检测到更新后的本地数据缺失，已暂停启动",
    detail,
    buttons,
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (!candidate.available || response !== 1) { app.quit(); return false; }
  try {
    updateRestoreResult = restoreUpdateBackupWithConsent(manualRecoveryOptions);
    startupRecoveryError = null;
    return true;
  } catch (error) {
    await dialog.showMessageBox({
      type: "error",
      title: "Cherry AI 连接中心：恢复未完成",
      message: "备份恢复失败，程序已停止以保护现有文件",
      detail: String(error?.message || error),
      buttons: ["确定"],
    });
    app.quit();
    return false;
  }
}

function copyDirectoryIfMissing(source, destination) {
  if (!fs.existsSync(source) || fs.existsSync(destination)) return false;
  fs.cpSync(source, destination, { recursive: true, errorOnExist: true });
  return true;
}

// 中文：首次升级只复制必要数据，不自动删除旧目录，避免迁移异常造成不可恢复的数据丢失。
// English: First upgrade copies essential data but never auto-deletes the legacy folder.
function migrateLegacyDataOnce() {
  if (path.resolve(legacyUserDataRoot) === path.resolve(runtimeDataRoot)) return;
  const marker = path.join(runtimeDataRoot, ".legacy-data-checked");
  if (fs.existsSync(marker)) return;
  try {
    const legacySettings = path.join(legacyUserDataRoot, "desktop-settings.json");
    const nextSettings = path.join(runtimeDataRoot, "desktop-settings.json");
    if (fs.existsSync(legacySettings) && !fs.existsSync(nextSettings)) fs.copyFileSync(legacySettings, nextSettings);
    copyDirectoryIfMissing(path.join(legacyUserDataRoot, "gateway-data"), gatewayDataRoot);
    fs.writeFileSync(marker, JSON.stringify({ checkedAt: new Date().toISOString(), legacyUserDataRoot }, null, 2), "utf8");
  } catch (error) {
    console.warn("旧数据迁移未完成，将在下次启动重试：", error?.message || error);
  }
}

const singleInstance = app.requestSingleInstanceLock();

app.setAppUserModelId("com.bftwarrior.cherry-ai-connect");

const defaultDesktopSettings = { language: "zh", autoLaunch: false, startMinimized: false, closeToTray: true, gatewayPort: DEFAULT_GATEWAY_PORT };
function settingsFile() { return path.join(app.getPath("userData"), "desktop-settings.json"); }
function normalizeDesktopSettings(value) {
  const { setupCompleted: _legacySetupCompleted, ...settings } = value && typeof value === "object" ? value : {};
  return { ...defaultDesktopSettings, ...settings };
}
function readDesktopSettings() {
  try { return normalizeDesktopSettings(JSON.parse(fs.readFileSync(settingsFile(), "utf8"))); }
  catch { return { ...defaultDesktopSettings }; }
}
function writeDesktopSettings(value) {
  const next = normalizeDesktopSettings(value);
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  const temporary = `${settingsFile()}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(next, null, 2), "utf8");
  try { fs.renameSync(temporary, settingsFile()); }
  catch (error) { try { fs.copyFileSync(temporary, settingsFile()); fs.unlinkSync(temporary); } catch { throw error; } }
  return next;
}
function configureAutoLaunch(enabled) {
  const args = app.isPackaged ? ["--hidden"] : ["--hidden", app.getAppPath()];
  app.setLoginItemSettings({ openAtLogin: Boolean(enabled), openAsHidden: Boolean(enabled), path: process.execPath, args });
}

function gatewayInfo() {
  const origin = `http://127.0.0.1:${currentGatewayPort}`;
  return { port: currentGatewayPort, origin, apiBase: `${origin}/v1` };
}

function protectLocalSecret(value) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows 安全存储当前不可用，无法安全保存 GitHub 凭证");
  return safeStorage.encryptString(String(value));
}

function unprotectLocalSecret(value) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows 安全存储当前不可用，无法读取 GitHub 凭证");
  return safeStorage.decryptString(Buffer.from(value));
}

function syncSource() {
  return {
    getSyncSnapshot: () => gatewayModule.getSyncSnapshot(),
    mergeRemoteUsage: (payload) => gatewayModule.mergeRemoteUsage(payload),
    markSyncEvents: (ids) => gatewayModule.markSyncEvents(ids),
    recordSyncRun: (payload) => gatewayModule.recordSyncRun(payload),
    canAdoptSyncDataset: () => gatewayModule.canAdoptSyncDataset(),
    adoptSyncDataset: (datasetId) => gatewayModule.adoptSyncDataset(datasetId),
    replaceConfigFromSync: (publicConfig, secureConfig, options) => gatewayModule.replaceConfigFromSync(publicConfig, secureConfig, options),
    bumpConfigRevisionForSync: () => gatewayModule.bumpConfigRevisionForSync(),
  };
}

// 中文：更新期间暂停自动同步定时器；更新失败或没有新版时再补排一轮，避免同步穿插备份。
// English: Pause the delayed auto-sync timer during an update, then schedule one catch-up round
// after a failed or no-op update so synchronization cannot start between shutdown and backup.
function clearMajorSyncTimer() {
  if (majorSyncTimer) clearTimeout(majorSyncTimer);
  majorSyncTimer = null;
}

function scheduleMajorSync(reason) {
  clearMajorSyncTimer();
  if (updateRun) {
    updateSyncDirty = true;
    return;
  }
  const status = syncManager?.status();
  if (!status?.enabled || !status.connected) return;
  majorSyncTimer = setTimeout(() => {
    majorSyncTimer = null;
    void syncManager.syncNow(reason).catch(() => {});
  }, 1500);
}

async function initializeSyncManager() {
  if (syncManager) return syncManager;
  const syncPath = app.isPackaged
    ? path.join(process.resourcesPath, "app.asar", "sync", "sync-manager.mjs")
    : path.join(__dirname, "..", "sync", "sync-manager.mjs");
  const { SyncManager } = await import(pathToFileURL(syncPath).href);
  syncManager = new SyncManager({
    dataDir: gatewayDataRoot,
    source: syncSource(),
    protect: protectLocalSecret,
    unprotect: unprotectLocalSecret,
    notify: (status) => {
      mainWindow?.webContents.send("sync-status", status);
      refreshTrayMenu();
    },
  });
  gatewayModule.setSyncChangeHandler?.((reason) => {
    scheduleMajorSync(reason);
  });
  return syncManager;
}

function versionParts(value) {
  return String(value || "0.0.0").replace(/^v/i, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
}

function isNewerVersion(candidate, current) {
  const left = versionParts(candidate);
  const right = versionParts(current);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if ((left[index] || 0) !== (right[index] || 0)) return (left[index] || 0) > (right[index] || 0);
  }
  return false;
}

function releaseResult(latestVersion, releaseUrl, publishedAt = "", asset = null) {
  const currentVersion = app.getVersion();
  return {
    ok: true,
    currentVersion,
    latestVersion,
    updateAvailable: isNewerVersion(latestVersion, currentVersion),
    releaseUrl,
    publishedAt,
    checkedAt: new Date().toISOString(),
    asset,
  };
}

function fetchLatestReleaseFromApi() {
  return new Promise((resolve, reject) => {
    const request = https.get(RELEASE_API, {
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "Cherry-AI-Connect" },
      timeout: 12000,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(data?.message || `GitHub HTTP ${response.statusCode}`);
          const latestVersion = String(data.tag_name || "").replace(/^v/i, "");
          if (!latestVersion) throw new Error("未读取到 GitHub Release 版本号");
          const candidates = Array.isArray(data.assets) ? data.assets : [];
          const installer = candidates.find((item) => /^Cherry-AI-Connect-Setup-[0-9.]+\.exe$/i.test(String(item?.name || "")));
          const digest = String(installer?.digest || "");
          const asset = installer ? {
            name: String(installer.name),
            url: String(installer.browser_download_url || ""),
            size: Math.max(0, Number(installer.size || 0)),
            sha256: digest.replace(/^sha256:/i, "") || releaseBodySha256(data.body),
          } : null;
          resolve(releaseResult(latestVersion, String(data.html_url || RELEASE_LATEST_PAGE), String(data.published_at || ""), asset));
        } catch (error) { reject(error); }
      });
    });
    request.on("timeout", () => request.destroy(new Error("检查更新超时，请稍后重试")));
    request.on("error", reject);
  });
}

function requestText(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: { "user-agent": "Cherry-AI-Connect", ...headers },
      timeout: 12000,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`GitHub page request failed (HTTP ${response.statusCode || 0})`));
          return;
        }
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
    });
    request.on("timeout", () => request.destroy(new Error("GitHub page request timed out")));
    request.on("error", reject);
  });
}

// 中文：匿名 GitHub API 被限流时，读取官方 Release 页面和资产片段，保留安装包 URL 与 SHA-256。
// English: If the anonymous GitHub API is rate-limited, read the official Release page and asset
// fragment so the installer URL and SHA-256 remain available without weakening verification.
function fetchLatestReleaseFromRedirect() {
  return new Promise((resolve, reject) => {
    const request = https.get(RELEASE_LATEST_PAGE, {
      headers: { "user-agent": "Cherry-AI-Connect" },
      timeout: 12000,
    }, (response) => {
      const location = String(response.headers.location || "");
      const releaseUrl = location ? new URL(location, RELEASE_LATEST_PAGE).toString() : "";
      const tag = releaseUrl.startsWith(RELEASE_PAGE_PREFIX)
        ? decodeURIComponent(new URL(releaseUrl).pathname.split("/releases/tag/")[1] || "")
        : "";
      response.resume();
      if (response.statusCode >= 300 && response.statusCode < 400 && tag) {
        void (async () => {
          const releaseHtml = await requestText(releaseUrl);
          const page = releasePageMetadata(releaseHtml);
          const expandedUrl = page.expandedAssetsUrl || `${RELEASE_PAGE_PREFIX}releases/expanded_assets/${encodeURIComponent(`v${tag.replace(/^v/i, "")}`)}`;
          let asset = null;
          try {
            asset = expandedReleaseAsset(await requestText(expandedUrl), page.sha256);
          } catch {
            // 中文：页面元数据不可用时仍返回版本，但没有可信哈希就继续禁止安装。
            // English: Keep the version result when metadata is unavailable; installation remains blocked without a trusted hash.
          }
          resolve(releaseResult(tag.replace(/^v/i, ""), releaseUrl, page.publishedAt, asset));
        })().catch(reject);
      } else {
        reject(new Error(`GitHub Release 检查失败（HTTP ${response.statusCode || 0}）`));
      }
    });
    request.on("timeout", () => request.destroy(new Error("检查更新超时，请稍后重试")));
    request.on("error", reject);
  });
}

async function fetchLatestRelease() {
  try { return await fetchLatestReleaseFromApi(); }
  catch { return fetchLatestReleaseFromRedirect(); }
}

function emitUpdateProgress(value) {
  // 中文：每次进度都写入快照并广播；新页面先读快照再接收后续事件。
  // English: Persist and broadcast every progress event so a newly mounted page can resume from
  // the latest snapshot before receiving later events.
  const safeValue = {
    stage: value.stage,
    percent: Math.max(0, Math.min(100, Number(value.percent) || 0)),
    ...(Number.isFinite(Number(value.received)) ? { received: Math.max(0, Number(value.received)) } : {}),
    ...(Number.isFinite(Number(value.total)) ? { total: Math.max(0, Number(value.total)) } : {}),
    ...(value.error ? { error: redactLocalUpdatePaths(value.error) } : {}),
  };
  lastUpdateProgress = { at: new Date().toISOString(), sequence: ++updateProgressSequence, ...safeValue };
  updateStatus = value.stage === "error" ? "error" : value.stage === "completed" ? "completed" : "running";
  // 中文：切页或窗口销毁期间不能让 IPC 广播抛错；状态已经保存在主进程快照中，
  // 新页面会通过 get-update-progress 重新接管显示。
  // English: A page switch or destroyed window must not make IPC broadcasting throw; the state
  // already lives in the main-process snapshot and a new page will resume from get-update-progress.
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  try { mainWindow.webContents.send("update-progress", lastUpdateProgress); } catch { /* snapshot remains authoritative */ }
}

// 中文：异常文本可能包含运行数据或安装器位置；保留错误码和说明，但不把绝对本机根路径发给页面。
// English: Error text can contain runtime or installer locations; preserve the diagnostic while
// redacting known local roots before sending it to the renderer.
function redactLocalUpdatePaths(value) {
  let message = String(value || "update_failed");
  const roots = [runtimeDataRoot, updateRecoveryRoot, legacyUserDataRoot, legacyInstallDataRoot]
    .filter(Boolean)
    .sort((left, right) => String(right).length - String(left).length);
  for (const root of roots) {
    const variants = new Set([String(root), String(root).replaceAll("\\", "/"), String(root).replaceAll("/", "\\")]);
    for (const variant of variants) {
      const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      message = message.replace(new RegExp(escaped, "gi"), "[local path]");
    }
  }
  return message;
}

// 中文：保留页面可重建安装按钮所需的公开 Release 元数据，不缓存任何本地路径。
// English: Keep only public release metadata needed to rebuild the install action after a page
// remount; local paths are never part of this snapshot.
function cacheUpdateRelease(release) {
  lastUpdateRelease = release ? {
    ok: Boolean(release.ok),
    currentVersion: String(release.currentVersion || ""),
    latestVersion: String(release.latestVersion || ""),
    updateAvailable: Boolean(release.updateAvailable),
    releaseUrl: String(release.releaseUrl || ""),
    publishedAt: String(release.publishedAt || ""),
    checkedAt: String(release.checkedAt || ""),
    asset: release.asset ? {
      name: String(release.asset.name || ""),
      url: String(release.asset.url || ""),
      size: Math.max(0, Number(release.asset.size || 0)),
      sha256: String(release.asset.sha256 || ""),
    } : null,
  } : null;
  return lastUpdateRelease;
}

async function restoreGatewayAfterUpdateFailure(error) {
  try {
    await startGateway();
  } catch (restartError) {
    // 中文：恢复失败必须进入同一个错误消息，不能继续告诉用户旧版本仍然可用。
    // English: Surface gateway-restart failure in the same error; never claim the old version is
    // usable when the local service did not recover.
    const original = String(error?.message || error || "update_failed");
    const detail = String(restartError?.message || restartError || "unknown");
    if (error && typeof error === "object") error.message = `${original}; update_gateway_restart_failed:${detail}`;
    else throw new Error(`${original}; update_gateway_restart_failed:${detail}`);
  }
}

// 中文：一键更新的顺序固定为下载校验、云同步、停止网关、离线备份、启动安装器。
// 任一步失败都停止安装并保留当前版本，避免用“重新同步”掩盖本地数据丢失。
// English: One-click update always verifies, syncs, stops the gateway, creates an offline backup,
// and only then launches the installer. Any failure keeps the current version running.
async function downloadAndInstallLatestUpdate() {
  if (updateRun) return updateRun;
  updateSyncDirty = Boolean(majorSyncTimer);
  clearMajorSyncTimer();
  let installerHandedOff = false;
  updateRun = (async () => {
    // 中文：先写入运行快照，再等待网关重置；切回设置页时不能读到旧的 idle/completed 状态。
    // English: Publish the running snapshot before waiting for gateway reset so a remounted
    // Settings page cannot mistake this update for an old idle or completed task.
    emitUpdateProgress({ stage: "syncing", percent: 0 });
    // 中文：网关重置和更新都可能停止/启动同一个本地服务；更新必须等待已开始的重置完成。
    // English: Gateway reset and update can both stop/start the same local service; an update
    // waits for a reset that already began instead of interleaving with it.
    if (gatewayResetRun) await gatewayResetRun;
    if (syncManager) {
      await syncManager.pauseForUpdate();
      updateSyncPaused = true;
    }
    emitUpdateProgress({ stage: "checking", percent: 0 });
    let release;
    try {
      release = await fetchLatestRelease();
    } catch (error) {
      const raw = String(error?.message || error || "");
      if (/(ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|EAI_AGAIN|ENOTFOUND|GitHub request timed out|connect timed out)/i.test(raw)) {
        throw new Error("update_github_network_timeout");
      }
      throw error;
    }
    cacheUpdateRelease(release);
    if (!release.updateAvailable) {
      emitUpdateProgress({ stage: "completed", percent: 100 });
      return { ok: true, updateAvailable: false, release };
    }
    if (!release.asset?.url || !release.asset?.name) throw new Error("update_installer_missing");
    const installerDir = path.join(updateRecoveryRoot, "installers");
    const installerPath = path.join(installerDir, `${Date.now()}-${release.asset.name}`);
    emitUpdateProgress({ stage: "downloading", percent: 0, received: 0, total: release.asset.size || 0 });
    const downloaded = await downloadVerifiedInstaller({
      asset: release.asset,
      destination: installerPath,
      onProgress: (progress) => emitUpdateProgress({ stage: "downloading", ...progress }),
    });
    // 中文：渲染层只需要阶段，不需要接收本机安装器路径；路径仅留在主进程用于启动校验后的文件。
    // English: The renderer needs the stage but never the local installer path; keep that path in
    // the main process for the verified launch only.
    emitUpdateProgress({ stage: "syncing", percent: 100 });
    const syncStatus = syncManager?.status();
    if (syncStatus?.enabled && syncStatus?.connected) await syncManager.syncBeforeUpdate();
    try {
      await stopGateway();
    } catch (error) {
      // 中文：停止网关若只完成了一半，先尝试恢复旧版本服务，再把原始错误交给界面。
      // English: If gateway shutdown is only partially completed, restore the old service before
      // returning the original update error to the renderer.
      await restoreGatewayAfterUpdateFailure(error);
      throw error;
    }
    emitUpdateProgress({ stage: "backing-up", percent: 100 });
    let backup;
    try {
      backup = createUpdateBackup({ runtimeDataRoot, updateRecoveryRoot, legacyUserDataRoot, targetVersion: release.latestVersion });
    } catch (error) {
      await restoreGatewayAfterUpdateFailure(error);
      throw error;
    }
    emitUpdateProgress({ stage: "installing", percent: 100 });
    let child;
    try {
      child = await new Promise((resolve, reject) => {
        const installer = spawn(downloaded.file, ["--updated", "/S", "--force-run"], { detached: true, stdio: "ignore", windowsHide: true });
        installer.once("error", reject);
        installer.once("spawn", () => resolve(installer));
      });
    } catch (error) {
      // 中文：安装器若未真正启动，立即恢复当前网关，用户可以继续使用旧版本并重试。
      // English: If the installer never starts, restore the current gateway so the old version remains usable.
      await restoreGatewayAfterUpdateFailure(error);
      throw error;
    }
    child.unref();
    installerHandedOff = true;
    quitting = true;
    shutdownComplete = true;
    setTimeout(() => app.quit(), 250);
    return { ok: true, updateAvailable: true, launched: true, version: release.latestVersion };
  })().catch((error) => {
    const message = redactLocalUpdatePaths(error?.message || error);
    if (error && typeof error === "object" && typeof error.message === "string") error.message = message;
    emitUpdateProgress({ stage: "error", percent: 0, error: message });
    throw error;
  }).finally(() => {
    updateRun = null;
    if (updateSyncPaused && !installerHandedOff) {
      updateSyncPaused = false;
      syncManager?.resumeAfterUpdate();
    }
    if (updateSyncDirty && !installerHandedOff) {
      updateSyncDirty = false;
      scheduleMajorSync("after-update");
    } else if (installerHandedOff) updateSyncDirty = false;
  });
  return updateRun;
}

function trayImage() {
  const fileIcon = nativeImage.createFromPath(path.join(__dirname, "assets", "tray.png"));
  if (!fileIcon.isEmpty()) return fileIcon.resize({ width: 16, height: 16 });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32"><defs><linearGradient id="cherry-purple" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a56cff"/><stop offset=".56" stop-color="#8b50e8"/><stop offset="1" stop-color="#6738b7"/></linearGradient></defs><rect x="1" y="1" width="30" height="30" rx="9" fill="url(#cherry-purple)" stroke="#c7a7ff" stroke-width="1"/><path d="M16 5.5l2.3 8.2L26.5 16l-8.2 2.3L16 26.5l-2.3-8.2L5.5 16l8.2-2.3z" fill="none" stroke="#fff" stroke-width="2.1" stroke-linejoin="round"/></svg>`;
  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const image = nativeImage.createFromDataURL(dataUrl);
  if (image.isEmpty()) return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
  return image.resize({ width: 16, height: 16 });
}

function refreshTrayMenu() {
  if (!tray) return;
  const settings = readDesktopSettings();
  const english = settings.language === "en";
  const syncStatus = syncManager?.status();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: english ? "Show Cherry AI Connect" : "显示 Cherry AI 连接中心", click: () => mainWindow?.show() },
    { label: english ? "Hide to tray" : "隐藏到托盘", click: () => mainWindow?.hide() },
    { type: "separator" },
    { label: english ? "Copy local API URL" : "复制本地 API 地址", click: () => clipboard.writeText(gatewayInfo().apiBase) },
    {
      label: syncStatus?.enabled ? (english ? "Pause automatic sync" : "暂停自动同步") : (english ? "Resume automatic sync" : "恢复自动同步"),
      enabled: Boolean(syncStatus?.connected),
      click: () => { if (syncManager) void syncManager.setEnabled(!syncManager.status().enabled).catch(() => {}); },
    },
    { type: "separator" },
    { label: english ? "Start with Windows" : "开机启动", type: "checkbox", checked: settings.autoLaunch, click: (item) => updateDesktopSettings({ autoLaunch: item.checked }) },
    { type: "separator" },
    { label: english ? "Quit" : "退出", click: () => requestAppQuit() },
  ]));
}

// 中文：更新期间拒绝用户主动退出，避免下载、同步或备份被桌面进程提前终止；更新自己启动安装器时会先标记 quitting。
// English: Block user-initiated quit while an update is downloading, syncing, or backing up;
// the update's installer hand-off sets quitting first and is therefore allowed to exit.
function requestAppQuit() {
  if (updateRun && !quitting) {
    mainWindow?.show();
    return false;
  }
  quitting = true;
  app.quit();
  return true;
}

function createTray() {
  if (tray) return;
  tray = new Tray(trayImage());
  tray.setToolTip("Cherry AI 连接中心");
  tray.on("click", () => mainWindow?.show());
  tray.on("double-click", () => mainWindow?.show());
  refreshTrayMenu();
}

function updateDesktopSettings(patch) {
  const settings = writeDesktopSettings({ ...readDesktopSettings(), ...patch });
  configureAutoLaunch(settings.autoLaunch);
  refreshTrayMenu();
  return settings;
}

function legacyGatewayMarkers() {
  const desktop = app.getPath("desktop");
  const codex = path.join(desktop, "codex");
  return [
    path.join(codex, "Cherry多线路网关", "gateway.mjs"),
    path.join(codex, "Cherry多线路网关", "启动Cherry多线路网关.cmd"),
    path.join(codex, "Cherry本地中转代理", "cherry-local-proxy.mjs"),
    path.join(codex, "Cherry本地中转代理", "启动Cherry本地中转.cmd"),
  ];
}

async function cleanupLegacyGatewayProcesses() {
  if (process.platform !== "win32") return;
  const markers = legacyGatewayMarkers().map((item) => `'${item.replace(/'/g, "''")}'`).join(",");
  const script = `$markers=@(${markers}); Get-CimInstance Win32_Process | Where-Object { $process=$_; $names=@('node.exe','nodejs.exe','cmd.exe'); if ($names -notcontains $process.Name) { return $false }; $command=[string]$process.CommandLine; @($markers | Where-Object { $command -like "*$($_)*" }).Count -gt 0 } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  try {
    await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { windowsHide: true });
  } catch (error) {
    console.warn(`[兼容清理] 无法检查旧网关进程：${error?.message || error}`);
  }
}

async function startGateway(portOverride) {
  await cleanupLegacyGatewayProcesses();
  const dataDir = gatewayDataRoot;
  process.env.GATEWAY_DATA_DIR = dataDir;
  process.env.GATEWAY_EMBEDDED = "1";
  const gatewayPath = app.isPackaged
    ? path.join(process.resourcesPath, "app.asar", "gateway", "gateway.mjs")
    : path.join(__dirname, "..", "gateway", "gateway.mjs");
  gatewayModule = gatewayModule || await import(pathToFileURL(gatewayPath).href);
  const savedPort = Number(readDesktopSettings().gatewayPort || DEFAULT_GATEWAY_PORT);
  const preferredPort = Number(portOverride || savedPort);
  const selectedPort = await chooseGatewayPort(preferredPort);
  await gatewayModule.startGateway({ port: selectedPort });
  currentGatewayPort = selectedPort;
  if (savedPort !== selectedPort) writeDesktopSettings({ gatewayPort: selectedPort });
}

async function stopGateway() {
  if (!gatewayModule || typeof gatewayModule.stopGateway !== "function") return;
  await gatewayModule.stopGateway();
  gatewayModule = undefined;
}

async function startCodexUsage() {
  if (process.platform !== "win32") return;
  let packagedExecutablePath = "";
  if (app.isPackaged) {
    const archive = path.join(process.resourcesPath, "codex-usage-windows-amd64.exe.tar.xz");
    const targetDirectory = path.join(runtimeDataRoot, "codex-usage");
    packagedExecutablePath = path.join(targetDirectory, CODEX_USAGE_BINARY);
    if (!fs.existsSync(packagedExecutablePath)) {
      try {
        fs.mkdirSync(targetDirectory, { recursive: true });
        await execFileAsync("tar.exe", ["-xJf", archive, "-C", targetDirectory], { windowsHide: true });
      } catch (error) {
        console.warn(`[Codex 官方统计] 无法解压内置辅助程序：${error?.message || error}`);
        packagedExecutablePath = "";
      }
    }
  }
  const executable = resolveExecutable({
    isPackaged: app.isPackaged,
    packagedExecutablePath,
    resourcesPath: process.resourcesPath,
    moduleDirectory: __dirname,
    desktopPath: app.getPath("desktop"),
  });
  if (!executable) {
    console.warn(`[Codex 官方统计] 未找到 ${CODEX_USAGE_BINARY}，保留页面中的明确不可用状态`);
    return;
  }
  try {
    const result = await startCodexUsageService({ executable });
    if (result.process) codexUsageProcess = result.process;
    if (!result.available) console.warn(`[Codex 官方统计] 本机服务未在预期时间内启动：${result.reason}`);
    else console.info(`[Codex 官方统计] 本机服务状态：${result.reason}`);
  } catch (error) {
    console.warn(`[Codex 官方统计] 启动本机服务失败：${error?.message || error}`);
  }
}

function stopCodexUsage() {
  if (codexUsageProcess) {
    stopCodexUsageService(codexUsageProcess);
    codexUsageProcess = undefined;
  }
}

async function resetGateway() {
  if (updateRun) throw new Error("gateway_reset_blocked_during_update");
  if (gatewayResetRun) return gatewayResetRun;
  const run = (async () => {
    const previousPort = currentGatewayPort;
    const nextPort = await chooseGatewayPort(previousPort, { exclude: previousPort, randomize: true });
    if (updateRun) throw new Error("gateway_reset_blocked_during_update");
    await stopGateway();
    await startGateway(nextPort);
    return { ok: true, previousPort, randomized: nextPort !== previousPort, restartedAt: new Date().toISOString(), ...gatewayInfo() };
  })();
  let trackedRun;
  trackedRun = run.finally(() => {
    if (gatewayResetRun === trackedRun) gatewayResetRun = null;
  });
  gatewayResetRun = trackedRun;
  return trackedRun;
}

function createWindow() {
  const settings = readDesktopSettings();
  mainWindowReady = false;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1060,
    minHeight: 700,
    show: !(process.argv.includes("--hidden") || settings.startMinimized),
    backgroundColor: "#0d0d12",
    title: "Cherry AI 连接中心",
    icon: path.join(__dirname, "assets", "app-1.33.ico"),
    autoHideMenuBar: true,
    // 中文：保留 Windows 原生窗口按钮，但让标题栏颜色和应用内容成为一个整体。
    // English: Keep native Windows controls while visually merging the title bar with the app.
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#17171f", symbolColor: "#eadfc7", height: 40 },
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "dist", "index.html"));
  mainWindow.once("ready-to-show", () => {
    mainWindowReady = true;
    const shouldShow = pendingShowWindow || (!process.argv.includes("--hidden") && !settings.startMinimized);
    pendingShowWindow = false;
    if (shouldShow) mainWindow.show();
  });
  mainWindow.on("close", (event) => {
    if (updateRun && !quitting) {
      // 中文：更新期间禁止关闭窗口；页面可以切换，但桌面进程和网关必须继续运行。
      // English: Do not close the window during an update; pages may change, but the desktop
      // process and gateway must remain alive until the update settles.
      event.preventDefault();
      if (!mainWindow.isDestroyed()) mainWindow.show();
      return;
    }
    if (!quitting && readDesktopSettings().closeToTray) {
      event.preventDefault();
      // 中文：关闭到托盘属于重大事件；只在同步已启用且已连接时触发，失败不影响窗口隐藏。
      // English: Close-to-tray is a major event; sync only when enabled/connected and never block hiding.
      const status = syncManager?.status();
      if (status?.enabled && status?.connected) void syncManager.syncNow("window-close").catch(() => {});
      mainWindow.hide();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
    mainWindowReady = false;
  });
}

ipcMain.handle("open-data-folder", () => shell.openPath(gatewayDataRoot));
ipcMain.handle("get-desktop-settings", () => ({ ...readDesktopSettings(), loginItem: app.getLoginItemSettings().openAtLogin }));
ipcMain.handle("set-desktop-settings", (_event, patch) => updateDesktopSettings(patch || {}));
ipcMain.handle("get-gateway-info", () => gatewayInfo());
ipcMain.handle("reset-gateway", async () => resetGateway());
ipcMain.handle("check-for-updates", async () => cacheUpdateRelease(await fetchLatestRelease()));
ipcMain.handle("download-and-install-update", async () => downloadAndInstallLatestUpdate());
// 中文：只返回更新状态快照，不把本机安装器路径或其他无关敏感数据发给渲染层；查询不会启动或取消更新。
// English: Return only the update snapshot without exposing the local installer path or unrelated
// sensitive data; querying never starts or cancels an update.
ipcMain.handle("get-update-progress", () => ({ active: Boolean(updateRun), status: updateStatus, sequence: updateProgressSequence, progress: lastUpdateProgress, release: lastUpdateRelease }));
ipcMain.handle("get-sync-status", async () => (await initializeSyncManager()).status());
ipcMain.handle("github-connect", async (_event, value) => (await initializeSyncManager()).connect({
  token: String(value?.token || ""),
  repository: String(value?.repository || "cherry-ai-connect-sync"),
  password: String(value?.password || ""),
  syncUpstream: value?.syncUpstream === true,
}));
ipcMain.handle("sync-now", async () => (await initializeSyncManager()).syncNow("manual"));
ipcMain.handle("set-sync-enabled", async (_event, enabled) => (await initializeSyncManager()).setEnabled(Boolean(enabled)));
ipcMain.handle("unlock-sync-vault", async (_event, value) => (await initializeSyncManager()).unlockVault({ password: String(value?.password || ""), recoveryCode: String(value?.recoveryCode || "") }));
ipcMain.handle("resolve-sync-conflict", async (_event, value) => (await initializeSyncManager()).resolveConflict({ choice: String(value?.choice || ""), password: String(value?.password || ""), recoveryCode: String(value?.recoveryCode || "") }));
ipcMain.handle("disconnect-github", async () => (await initializeSyncManager()).disconnect());
ipcMain.handle("open-external", (_event, value) => {
  const target = String(value || "");
  if (!target.startsWith("https://github.com/")) throw new Error("只允许打开 GitHub HTTPS 页面");
  return shell.openExternal(target);
});
ipcMain.handle("import-client-key", async (event, value) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error("import_not_available");
  const target = String(value?.target || "");
  if (target !== "ccswitch" && target !== "cherry-studio") throw new Error("unsupported_import_target");
  const keyId = String(value?.keyId || "");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(keyId)) throw new Error("client_key_unavailable");
  if (!gatewayModule || typeof gatewayModule.getClientKeyImportDetails !== "function") throw new Error("gateway_not_ready");
  const clientKey = gatewayModule.getClientKeyImportDetails(keyId);
  const link = buildClientImportDeepLink(target, clientKey, currentGatewayPort);
  try {
    await shell.openExternal(link);
    return { ok: true };
  } catch {
    // Do not return/log the deep link: it contains the local client key.
    throw new Error("external_app_unavailable");
  }
});
ipcMain.on("show-window", () => mainWindow?.show());
ipcMain.on("hide-window", () => mainWindow?.hide());
ipcMain.on("quit-app", () => { requestAppQuit(); });

if (!singleInstance) app.quit();
else {
  app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindowReady) mainWindow.show();
    else pendingShowWindow = true;
  });
  app.whenReady().then(async () => {
    if (!await resolveStartupRecovery()) return;
    migrateLegacyDataOnce();
    const settings = readDesktopSettings();
    configureAutoLaunch(settings.autoLaunch);
    await startCodexUsage();
    await startGateway();
    await initializeSyncManager();
    createTray();
    createWindow();
    void syncManager.startup();
    powerMonitor.on("resume", () => { void syncManager?.resume().catch(() => {}); });
  app.on("activate", () => { if (!mainWindow || mainWindow.isDestroyed()) createWindow(); else mainWindow.show(); });
  }).catch((error) => { console.error(error); app.quit(); });
  app.on("before-quit", (event) => {
    if (updateRun && !quitting) {
      // 中文：窗口关闭按钮绕过托盘菜单时也必须阻止更新被中断。
      // English: The window close button must obey the same update-in-progress guard as the tray.
      event.preventDefault();
      mainWindow?.show();
      return;
    }
    quitting = true;
    if (shutdownComplete) return;
    event.preventDefault();
    if (majorSyncTimer) clearTimeout(majorSyncTimer);
    Promise.resolve(syncManager?.shutdown(5000))
      .catch(() => {})
      .then(() => stopGateway())
      .catch(() => {})
      .finally(() => { stopCodexUsage(); shutdownComplete = true; app.quit(); });
  });
  app.on("window-all-closed", () => { if (process.platform !== "darwin" && (quitting || !readDesktopSettings().closeToTray)) app.quit(); });
}
