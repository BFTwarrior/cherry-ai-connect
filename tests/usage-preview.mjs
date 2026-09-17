/**
 * 中文：只用于开发视觉验收，创建临时假数据并展示已构建界面；不会读取正式配置。
 * English: Visual-QA harness with temporary fake data; it never reads production configuration.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryData = fs.mkdtempSync(path.join(os.tmpdir(), "cherry-usage-preview-"));
process.env.GATEWAY_DATA_DIR = temporaryData;
process.env.GATEWAY_EMBEDDED = "1";

let requestNumber = 0;
const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    if (req.method === "GET" && /\/models(?:\?|$)/.test(req.url || "")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [
        { id: "gpt-5.6-luna", object: "model" },
        { id: "gpt-5.6-sol", object: "model" },
        { id: "gpt-5.5", object: "model" },
      ] }));
      return;
    }
    requestNumber += 1;
    const input = 500 + (requestNumber * 811) % 12500;
    const output = 80 + (requestNumber * 157) % 2100;
    const cached = requestNumber % 3 ? Math.round(input * .42) : 0;
    res.writeHead(requestNumber % 13 ? 200 : 429, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "preview" } }], usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output, prompt_tokens_details: { cached_tokens: cached } } }));
  });
});

await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamPort = upstream.address().port;
async function availablePort() {
  const probe = http.createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}
const gatewayPort = await availablePort();
const gateway = await import(`../gateway/gateway.mjs?preview=${Date.now()}`);
await gateway.startGateway({ port: gatewayPort });
const origin = `http://127.0.0.1:${gatewayPort}`;
const request = async (url, options = {}) => (await fetch(`${origin}${url}`, options)).json();
await request("/admin/api/providers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "preview-purple", name: "Luna 高速线路", baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: "preview-upstream-placeholder" }) });
await request("/admin/api/providers/preview-purple/test", { method: "POST" });
const created = await request("/admin/api/client-keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ providerId: "preview-purple", reasoningLevel: "high", nameCustomized: false }) });
for (let index = 0; index < 36; index += 1) {
  await fetch(`${origin}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${created.key}` }, body: JSON.stringify({ model: index % 2 ? "gpt-5.6-luna" : "gpt-5.5", messages: [{ role: "user", content: "visual preview" }] }) });
}

const distRoot = path.join(projectRoot, "renderer", "dist");
const contentTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
const previewDesktopScript = `<script>
(() => {
  const listeners = new Set();
  const now = () => new Date().toISOString();
  const next = () => new Date(Date.now() + 30 * 60 * 1000).toISOString();
  let settings = { language: "zh", autoLaunch: false, startMinimized: false, closeToTray: true, setupCompleted: false };
  let sync = {
    enabled: false, connected: false, provider: "github", owner: "", repository: "cherry-ai-connect-sync",
    repositoryPrivate: false, account: null, state: "DISABLED", datasetId: "", generation: 0,
    pendingCount: 37, lastSyncAt: "", lastAttemptAt: "", nextSyncAt: "", errorCode: "", error: "",
    warning: "", intervalMinutes: 30, vault: { initialized: false, unlocked: false }
  };
  const publish = () => listeners.forEach((listener) => listener({ ...sync }));
  window.__previewSetSyncConflict = () => {
    sync = { ...sync, enabled: true, connected: true, owner: "preview-user", repositoryPrivate: true,
      account: { login: "preview-user", avatarUrl: "" }, state: "CONFLICT", errorCode: "sync_config_conflict",
      error: "sync_config_conflict", datasetId: "preview-dataset-7fb9a4c281", vault: { initialized: true, unlocked: false } };
    publish();
  };
  const completeSync = () => {
    sync = { ...sync, state: sync.enabled ? "IDLE" : "DISABLED", pendingCount: 0, generation: sync.generation + 1, lastSyncAt: now(), lastAttemptAt: now(), nextSyncAt: sync.enabled ? next() : "" };
    publish();
    return { ...sync };
  };
  window.desktop = {
    getGatewayInfo: async () => ({ ok: true, port: ${gatewayPort}, origin: "${origin}", apiBase: "${origin}/v1", adminUrl: "${origin}/admin" }),
    resetGateway: async () => ({ ok: true, port: ${gatewayPort}, origin: "${origin}", apiBase: "${origin}/v1", adminUrl: "${origin}/admin" }),
    getSettings: async () => ({ ...settings }),
    setSettings: async (patch) => (settings = { ...settings, ...patch }),
    openDataFolder: async () => true,
    openExternal: async () => true,
    getSyncStatus: async () => ({ ...sync }),
    onSyncStatus: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    connectGitHub: async ({ repository }) => {
      sync = { ...sync, enabled: true, connected: true, owner: "preview-user", repository, repositoryPrivate: true,
        account: { login: "preview-user", avatarUrl: "" }, state: "SYNCING", datasetId: "preview-dataset-7fb9a4c281", vault: { initialized: true, unlocked: true } };
      publish();
      await new Promise((resolve) => setTimeout(resolve, 250));
      return { status: completeSync(), recoveryCode: "CGRC-PREVIEW-ONLY-7F2A-91CD-44B8" };
    },
    syncNow: async () => {
      sync = { ...sync, state: "SYNCING", lastAttemptAt: now() };
      publish();
      await new Promise((resolve) => setTimeout(resolve, 250));
      return completeSync();
    },
    setSyncEnabled: async (enabled) => {
      sync = { ...sync, enabled, state: enabled ? "IDLE" : "DISABLED", nextSyncAt: enabled ? next() : "", warning: !enabled && sync.pendingCount ? "sync_disabled_with_pending_data" : "" };
      publish();
      return { ...sync };
    },
    resolveSyncConflict: async () => {
      sync = { ...sync, state: "IDLE", error: "", errorCode: "" };
      publish();
      return { ok: true, recoveryCode: "", status: { ...sync } };
    },
    disconnectGitHub: async () => {
      sync = { ...sync, enabled: false, connected: false, owner: "", repositoryPrivate: false, account: null, state: "DISABLED", nextSyncAt: "", vault: { initialized: true, unlocked: true } };
      publish();
      return { ...sync };
    },
    checkForUpdates: async () => ({ currentVersion: "1.2", latestVersion: "1.2", updateAvailable: false, releaseUrl: "https://github.com/BFTwarrior/cherry-ai-connect/releases", checkedAt: now(), asset: null }),
    downloadAndInstallUpdate: async () => ({ ok: true, updateAvailable: false }),
    onUpdateProgress: () => () => {}
  };
})();
</script>`;
const preview = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url || "/", "http://preview.local").pathname);
  let file = path.join(distRoot, pathname === "/" ? "index.html" : pathname.replace(/^\/+/, ""));
  if (!file.startsWith(distRoot) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(distRoot, "index.html");
  let body = fs.readFileSync(file);
  if (path.extname(file) === ".html") body = Buffer.from(body.toString("utf8").replace("</head>", `${previewDesktopScript}</head>`));
  res.writeHead(200, { "content-type": contentTypes[path.extname(file)] || "application/octet-stream", "content-length": body.length, "cache-control": "no-store" });
  res.end(body);
});
await new Promise((resolve) => preview.listen(4173, "127.0.0.1", resolve));
console.log("视觉验收页面：http://127.0.0.1:4173");

const shutdown = async () => {
  preview.close();
  upstream.close();
  await gateway.stopGateway();
  fs.rmSync(temporaryData, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
