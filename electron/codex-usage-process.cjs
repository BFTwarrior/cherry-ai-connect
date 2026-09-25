/**
 * 中文：管理随桌面程序启动的正版 Codex 本机统计服务；只连接 loopback，不接触认证文件。
 * English: Manage the bundled official Codex loopback usage service without reading credentials.
 */
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

const CODEX_USAGE_HOST = "127.0.0.1";
const CODEX_USAGE_PORT = 43189;
const CODEX_USAGE_BINARY = "codex-usage-windows-amd64.exe";

function isPortOpen({ host = CODEX_USAGE_HOST, port = CODEX_USAGE_PORT, timeoutMs = 250 } = {}) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function candidatePaths({ isPackaged = false, resourcesPath = "", moduleDirectory = "", desktopPath = "", packagedExecutablePath = "" } = {}) {
  const values = [];
  if (packagedExecutablePath) values.push(packagedExecutablePath);
  if (isPackaged && resourcesPath) values.push(path.join(resourcesPath, CODEX_USAGE_BINARY));
  if (moduleDirectory) values.push(path.join(moduleDirectory, "assets", CODEX_USAGE_BINARY));
  if (desktopPath) values.push(path.join(desktopPath, CODEX_USAGE_BINARY));
  return [...new Set(values)];
}

function resolveExecutable(options = {}, existsSync = require("node:fs").existsSync) {
  return candidatePaths(options).find((item) => existsSync(item)) || "";
}

async function startCodexUsageService({ executable, spawnImpl = spawn, waitMs = 2500, pollMs = 100 } = {}) {
  if (!executable) return { started: false, available: false, reason: "binary_missing", process: null };
  if (await isPortOpen()) return { started: false, available: true, reason: "already_running", process: null };

  const child = spawnImpl(executable, ["serve"], {
    detached: false,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref?.();
  const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
  while (Date.now() < deadline) {
    if (await isPortOpen({ timeoutMs: Math.min(250, Math.max(50, pollMs)) })) {
      return { started: true, available: true, reason: "started", process: child };
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(25, Number(pollMs) || 100)));
  }
  return { started: true, available: false, reason: "startup_timeout", process: child };
}

function stopCodexUsageService(child) {
  if (!child || child.killed || child.exitCode !== null) return false;
  try {
    child.kill();
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  CODEX_USAGE_BINARY,
  CODEX_USAGE_HOST,
  CODEX_USAGE_PORT,
  candidatePaths,
  isPortOpen,
  resolveExecutable,
  startCodexUsageService,
  stopCodexUsageService,
};
