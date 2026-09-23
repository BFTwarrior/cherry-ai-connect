/**
 * 中文：Electron 主进程负责创建桌面窗口、托盘、开机启动和本地网关生命周期。
 * English: The Electron main process owns the desktop window, tray, auto-start, and local gateway lifecycle.
 */
const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, shell, clipboard, safeStorage, powerMonitor } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const { pathToFileURL } = require("node:url");
const { chooseGatewayPort } = require("./port-selector");
const { resolveRuntimePaths } = require("./runtime-paths");
const { createUpdateBackup, downloadVerifiedInstaller, restoreUpdateBackupIfNeeded } = require("./update-manager");
const { expandedReleaseAsset, releaseBodySha256, releasePageMetadata } = require("./release-metadata");

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
let updateRun;

// 中文：正式版把运行数据放在安装目录旁，用户选择 D 盘后不会把主要缓存留在 C 盘。
// English: Packaged builds keep runtime data beside the installation so a D-drive install stays on D.
const legacyUserDataRoot = app.getPath("userData");
const { runtimeDataRoot, browserCacheRoot, gatewayDataRoot, updateRecoveryRoot } = resolveRuntimePaths({
  isPackaged: app.isPackaged,
  executablePath: process.execPath,
  moduleDirectory: __dirname,
});
// 中文：在网关读取配置前恢复更新备份；同机升级不能因空目录而刷新客户端 Key。
// English: Restore update data before the gateway reads configuration so an empty post-update folder
// never rotates client keys on the same device.
const updateRestoreResult = restoreUpdateBackupIfNeeded({ runtimeDataRoot, legacyUserDataRoot, currentVersion: app.getVersion() });
if (updateRestoreResult.restored) console.info(`已恢复更新前数据：${updateRestoreResult.backupRoot}`);
fs.mkdirSync(runtimeDataRoot, { recursive: true });
app.setPath("userData", runtimeDataRoot);
app.setPath("sessionData", browserCacheRoot);

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

migrateLegacyDataOnce();
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
    if (!syncManager?.status().enabled) return;
    if (majorSyncTimer) clearTimeout(majorSyncTimer);
    majorSyncTimer = setTimeout(() => { void syncManager.syncNow(reason).catch(() => {}); }, 1500);
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
  mainWindow?.webContents.send("update-progress", { at: new Date().toISOString(), ...value });
}

// 中文：一键更新的顺序固定为下载校验、云同步、停止网关、离线备份、启动安装器。
// 任一步失败都停止安装并保留当前版本，避免用“重新同步”掩盖本地数据丢失。
// English: One-click update always verifies, syncs, stops the gateway, creates an offline backup,
// and only then launches the installer. Any failure keeps the current version running.
async function downloadAndInstallLatestUpdate() {
  if (updateRun) return updateRun;
  updateRun = (async () => {
    emitUpdateProgress({ stage: "checking", percent: 0 });
    let release;
    try {
      release = await fetchLatestRelease();
    } catch (error) {
      const raw = String(error?.message || error || "");
      if (/(ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|EAI_AGAIN|GitHub request timed out|connect timed out)/i.test(raw)) {
        throw new Error("update_github_network_timeout");
      }
      throw error;
    }
    if (!release.updateAvailable) return { ok: true, updateAvailable: false, release };
    if (!release.asset?.url || !release.asset?.name) throw new Error("update_installer_missing");
    const installerDir = path.join(updateRecoveryRoot, "installers");
    const installerPath = path.join(installerDir, `${Date.now()}-${release.asset.name}`);
    emitUpdateProgress({ stage: "downloading", percent: 0, received: 0, total: release.asset.size || 0 });
    const downloaded = await downloadVerifiedInstaller({
      asset: release.asset,
      destination: installerPath,
      onProgress: (progress) => emitUpdateProgress({ stage: "downloading", ...progress }),
    });
    emitUpdateProgress({ stage: "syncing", percent: 100, installerPath });
    const syncStatus = syncManager?.status();
    if (syncStatus?.enabled && syncStatus?.connected) await syncManager.syncNow("before-update");
    emitUpdateProgress({ stage: "backing-up", percent: 100 });
    await stopGateway();
    let backup;
    try {
      backup = createUpdateBackup({ runtimeDataRoot, updateRecoveryRoot, legacyUserDataRoot, targetVersion: release.latestVersion });
    } catch (error) {
      await startGateway().catch(() => {});
      throw error;
    }
    emitUpdateProgress({ stage: "installing", percent: 100, backupRoot: backup.backupRoot });
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
      await startGateway().catch(() => {});
      throw error;
    }
    child.unref();
    quitting = true;
    shutdownComplete = true;
    setTimeout(() => app.quit(), 250);
    return { ok: true, updateAvailable: true, launched: true, version: release.latestVersion, backupRoot: backup.backupRoot };
  })().catch((error) => {
    emitUpdateProgress({ stage: "error", percent: 0, error: String(error?.message || error) });
    throw error;
  }).finally(() => { updateRun = null; });
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
    { label: english ? "Quit" : "退出", click: () => { quitting = true; app.quit(); } },
  ]));
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

async function resetGateway() {
  const previousPort = currentGatewayPort;
  const nextPort = await chooseGatewayPort(previousPort, { exclude: previousPort, randomize: true });
  await stopGateway();
  await startGateway(nextPort);
  return { ok: true, previousPort, randomized: nextPort !== previousPort, restartedAt: new Date().toISOString(), ...gatewayInfo() };
}

function createWindow() {
  const settings = readDesktopSettings();
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
  mainWindow.once("ready-to-show", () => { if (!process.argv.includes("--hidden") && !settings.startMinimized) mainWindow.show(); });
  mainWindow.on("close", (event) => {
    if (!quitting && readDesktopSettings().closeToTray) {
      event.preventDefault();
      // 中文：关闭到托盘属于重大事件；只在同步已启用且已连接时触发，失败不影响窗口隐藏。
      // English: Close-to-tray is a major event; sync only when enabled/connected and never block hiding.
      const status = syncManager?.status();
      if (status?.enabled && status?.connected) void syncManager.syncNow("window-close").catch(() => {});
      mainWindow.hide();
    }
  });
}

ipcMain.handle("open-data-folder", () => shell.openPath(gatewayDataRoot));
ipcMain.handle("get-desktop-settings", () => ({ ...readDesktopSettings(), loginItem: app.getLoginItemSettings().openAtLogin }));
ipcMain.handle("set-desktop-settings", (_event, patch) => updateDesktopSettings(patch || {}));
ipcMain.handle("get-gateway-info", () => gatewayInfo());
ipcMain.handle("reset-gateway", async () => resetGateway());
ipcMain.handle("check-for-updates", async () => fetchLatestRelease());
ipcMain.handle("download-and-install-update", async () => downloadAndInstallLatestUpdate());
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
ipcMain.on("show-window", () => mainWindow?.show());
ipcMain.on("hide-window", () => mainWindow?.hide());
ipcMain.on("quit-app", () => { quitting = true; app.quit(); });

if (!singleInstance) app.quit();
else {
  app.on("second-instance", () => mainWindow?.show());
  app.whenReady().then(async () => {
    const settings = readDesktopSettings();
    configureAutoLaunch(settings.autoLaunch);
    await startGateway();
    await initializeSyncManager();
    createTray();
    createWindow();
    void syncManager.startup();
    powerMonitor.on("resume", () => { void syncManager?.resume().catch(() => {}); });
    app.on("activate", () => { if (!mainWindow) createWindow(); else mainWindow.show(); });
  }).catch((error) => { console.error(error); app.quit(); });
  app.on("before-quit", (event) => {
    quitting = true;
    if (shutdownComplete) return;
    event.preventDefault();
    if (majorSyncTimer) clearTimeout(majorSyncTimer);
    Promise.resolve(syncManager?.shutdown(5000))
      .catch(() => {})
      .then(() => stopGateway())
      .catch(() => {})
      .finally(() => { shutdownComplete = true; app.quit(); });
  });
  app.on("window-all-closed", () => { if (process.platform !== "darwin" && (quitting || !readDesktopSettings().closeToTray)) app.quit(); });
}
