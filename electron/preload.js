/**
 * 中文：只向渲染层暴露必要的桌面能力，避免把 Electron 原生对象直接交给界面。
 * English: Expose only the required desktop capabilities instead of leaking raw Electron objects to the renderer.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  openDataFolder: () => ipcRenderer.invoke("open-data-folder"),
  getSettings: () => ipcRenderer.invoke("get-desktop-settings"),
  setSettings: (patch) => ipcRenderer.invoke("set-desktop-settings", patch),
  getGatewayInfo: () => ipcRenderer.invoke("get-gateway-info"),
  resetGateway: () => ipcRenderer.invoke("reset-gateway"),
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  downloadAndInstallUpdate: () => ipcRenderer.invoke("download-and-install-update"),
  onUpdateProgress: (listener) => {
    const handler = (_event, value) => listener(value);
    ipcRenderer.on("update-progress", handler);
    return () => ipcRenderer.removeListener("update-progress", handler);
  },
  getSyncStatus: () => ipcRenderer.invoke("get-sync-status"),
  connectGitHub: (value) => ipcRenderer.invoke("github-connect", value),
  syncNow: () => ipcRenderer.invoke("sync-now"),
  setSyncEnabled: (enabled) => ipcRenderer.invoke("set-sync-enabled", enabled),
  unlockSyncVault: (value) => ipcRenderer.invoke("unlock-sync-vault", value),
  resolveSyncConflict: (value) => ipcRenderer.invoke("resolve-sync-conflict", value),
  disconnectGitHub: () => ipcRenderer.invoke("disconnect-github"),
  onSyncStatus: (listener) => {
    const handler = (_event, value) => listener(value);
    ipcRenderer.on("sync-status", handler);
    return () => ipcRenderer.removeListener("sync-status", handler);
  },
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  importClientKey: (value) => ipcRenderer.invoke("import-client-key", value),
  showWindow: () => ipcRenderer.send("show-window"),
  hideWindow: () => ipcRenderer.send("hide-window"),
  quit: () => ipcRenderer.send("quit-app"),
});
