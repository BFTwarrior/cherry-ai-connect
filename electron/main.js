/**
 * 中文：Electron 主进程负责创建桌面窗口、托盘、开机启动和本地网关生命周期。
 * English: The Electron main process owns the desktop window, tray, auto-start, and local gateway lifecycle.
 */
const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { pathToFileURL } = require("node:url");

const execFileAsync = promisify(execFile);
const DEFAULT_GATEWAY_PORT = 27891;
const RANDOM_PORT_MIN = 27891;
const RANDOM_PORT_MAX = 27991;

let gatewayModule;
let mainWindow;
let tray;
let quitting = false;
let currentGatewayPort = DEFAULT_GATEWAY_PORT;
const singleInstance = app.requestSingleInstanceLock();

app.setAppUserModelId("com.bftwarrior.cherry-gateway");

const defaultDesktopSettings = { language: "zh", autoLaunch: false, startMinimized: false, closeToTray: true, gatewayPort: DEFAULT_GATEWAY_PORT };
function settingsFile() { return path.join(app.getPath("userData"), "desktop-settings.json"); }
function readDesktopSettings() {
  try { return { ...defaultDesktopSettings, ...JSON.parse(fs.readFileSync(settingsFile(), "utf8")) }; }
  catch { return { ...defaultDesktopSettings }; }
}
function writeDesktopSettings(value) {
  const next = { ...defaultDesktopSettings, ...value };
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2), "utf8");
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

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    const finish = (available) => {
      probe.removeAllListeners();
      try { probe.close(); } catch { /* probe was never listening */ }
      resolve(available);
    };
    probe.once("error", () => finish(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

function shuffledPorts(preferred, exclude) {
  const values = [];
  const safePreferred = Number(preferred);
  if (Number.isInteger(safePreferred) && safePreferred >= RANDOM_PORT_MIN && safePreferred <= RANDOM_PORT_MAX && safePreferred !== exclude) values.push(safePreferred);
  for (let port = RANDOM_PORT_MIN; port <= RANDOM_PORT_MAX; port += 1) {
    if (port !== safePreferred && port !== exclude) values.push(port);
  }
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [values[index], values[swap]] = [values[swap], values[index]];
  }
  return values;
}

async function chooseGatewayPort(preferred, { exclude, randomize = false } = {}) {
  const candidates = shuffledPorts(preferred, exclude);
  if (!randomize && candidates.length && candidates[0] !== preferred) candidates.unshift(Number(preferred));
  for (const port of candidates) {
    if (port === exclude) continue;
    if (await isPortAvailable(port)) return port;
  }
  throw new Error("没有找到可用的本地网关端口（27891-27991）");
}

function trayImage() {
  const fileIcon = nativeImage.createFromPath(path.join(__dirname, "assets", "tray.png"));
  if (!fileIcon.isEmpty()) return fileIcon.resize({ width: 16, height: 16 });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32"><rect x="1" y="1" width="30" height="30" rx="9" fill="#7c4dff" stroke="#c7a7ff" stroke-width="1"/><path d="M16 5.5l2.3 8.2L26.5 16l-8.2 2.3L16 26.5l-2.3-8.2L5.5 16l8.2-2.3z" fill="none" stroke="#fff" stroke-width="2.1" stroke-linejoin="round"/></svg>`;
  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const image = nativeImage.createFromDataURL(dataUrl);
  if (image.isEmpty()) return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
  return image.resize({ width: 16, height: 16 });
}

function refreshTrayMenu() {
  if (!tray) return;
  const settings = readDesktopSettings();
  const english = settings.language === "en";
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: english ? "Show Cherry Gateway" : "显示 Cherry 网关", click: () => mainWindow?.show() },
    { label: english ? "Hide to tray" : "隐藏到托盘", click: () => mainWindow?.hide() },
    { type: "separator" },
    { label: english ? "Start with Windows" : "开机启动", type: "checkbox", checked: settings.autoLaunch, click: (item) => updateDesktopSettings({ autoLaunch: item.checked }) },
    { type: "separator" },
    { label: english ? "Quit" : "退出", click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray() {
  if (tray) return;
  tray = new Tray(trayImage());
  tray.setToolTip("Cherry 多线路网关");
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
  const dataDir = path.join(app.getPath("userData"), "gateway-data");
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
    title: "Cherry 多线路网关",
    icon: path.join(__dirname, "assets", "app.ico"),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "dist", "index.html"));
  mainWindow.once("ready-to-show", () => { if (!process.argv.includes("--hidden") && !settings.startMinimized) mainWindow.show(); });
  mainWindow.on("close", (event) => {
    if (!quitting && readDesktopSettings().closeToTray) { event.preventDefault(); mainWindow.hide(); }
  });
}

ipcMain.handle("open-data-folder", () => shell.openPath(path.join(app.getPath("userData"), "gateway-data")));
ipcMain.handle("get-desktop-settings", () => ({ ...readDesktopSettings(), loginItem: app.getLoginItemSettings().openAtLogin }));
ipcMain.handle("set-desktop-settings", (_event, patch) => updateDesktopSettings(patch || {}));
ipcMain.handle("get-gateway-info", () => gatewayInfo());
ipcMain.handle("reset-gateway", async () => resetGateway());
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
    createTray();
    createWindow();
    app.on("activate", () => { if (!mainWindow) createWindow(); else mainWindow.show(); });
  }).catch((error) => { console.error(error); app.quit(); });
  app.on("before-quit", () => { quitting = true; void stopGateway(); });
  app.on("window-all-closed", () => { if (process.platform !== "darwin" && (quitting || !readDesktopSettings().closeToTray)) app.quit(); });
}
