/**
 * 中文：把 Vite 静态构建封装成可转发给其他人的演示网页压缩包。
 * English: Package the Vite static build into a shareable browser-demo archive.
 *
 * 中文：演示页必须带 ?demo=1；该标记让 React 使用固定假数据，并绕过桌面桥、本地网关、真实同步和真实加密写入。
 * English: The demo must be opened with ?demo=1; that flag selects deterministic fixtures and bypasses the desktop bridge,
 * the local gateway, real sync, and real encryption writes.
 */
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(projectRoot, "renderer", "dist");
const target = resolve(projectRoot, "dist-web-demo");
const archiveDirectory = resolve(projectRoot, "dist");
const archive = resolve(archiveDirectory, "Cherry-AI-Connect-Web-Demo-1.33.zip");

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
writeFileSync(resolve(target, "README.txt"), `Cherry AI Connect web demo 1.33\n\nOpen this build with the query string: ?demo=1\n\nRecommended local preview:\n  python -m http.server 4174\nThen visit:\n  http://127.0.0.1:4174/?demo=1\n\nThis page uses fictional data for visual and interaction review. It does not call the local gateway, desktop bridge, GitHub sync, or encryption storage.\n\nFor public hosting, upload the contents of this folder to any static hosting service and share the resulting URL with ?demo=1 appended.\n`, "utf8");

mkdirSync(archiveDirectory, { recursive: true });
execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Compress-Archive -Path '${target}\\*' -DestinationPath '${archive}' -Force`], { stdio: "inherit" });
console.log(`Web demo folder: ${target}`);
console.log(`Web demo archive: ${archive}`);
