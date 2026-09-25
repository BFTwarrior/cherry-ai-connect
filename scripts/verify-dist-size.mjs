/** 中文：V1.40 安装包使用严格十进制 100MB 门槛。 English: Enforce the strict decimal 100MB installer gate. */
import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(process.cwd());
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
const artifact = path.resolve(projectRoot, "dist", "current-build", `Cherry-AI-Connect-Setup-${packageJson.version}.exe`);
const maxBytes = 100_000_000;
if (path.dirname(artifact) !== path.resolve(projectRoot, "dist", "current-build")) throw new Error("unsafe_installer_path");
if (!fs.existsSync(artifact)) throw new Error(`installer_missing:${artifact}`);
const size = fs.statSync(artifact).size;
if (size > maxBytes) throw new Error(`installer_size_limit_exceeded:${size}>${maxBytes}`);
console.log(`Verified installer size: ${size} bytes <= ${maxBytes} bytes (${artifact})`);
