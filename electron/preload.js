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
  showWindow: () => ipcRenderer.send("show-window"),
  hideWindow: () => ipcRenderer.send("hide-window"),
  quit: () => ipcRenderer.send("quit-app"),
});
