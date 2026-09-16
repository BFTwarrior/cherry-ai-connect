/**
 * 中文：打包前只删除 dist 内的临时解包目录和构建残留，保留历代正式安装包。
 * 这样既能阻止上一次测试产生的 data/缓存进入新包，也不会误删旧版本交付物。
 * English: Before packaging, remove temporary unpacked output and build leftovers only, while
 * preserving released installers. This prevents test data from leaking without erasing history.
 */
import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(process.cwd());
const distRoot = path.resolve(projectRoot, "dist");

if (path.basename(distRoot).toLowerCase() !== "dist" || path.dirname(distRoot) !== projectRoot) {
  throw new Error("refusing_to_clean_unexpected_dist_path");
}

fs.mkdirSync(distRoot, { recursive: true });
for (const entry of fs.readdirSync(distRoot, { withFileTypes: true })) {
  const target = path.resolve(distRoot, entry.name);
  if (path.dirname(target) !== distRoot) throw new Error("refusing_to_clean_unexpected_dist_entry");
  const keepReleasedInstaller = entry.isFile() && /^Cherry-AI-Connect-Setup-[0-9.]+\.exe$/i.test(entry.name);
  if (!keepReleasedInstaller) fs.rmSync(target, { recursive: true, force: true });
}
console.log(`Prepared build output and preserved released installers: ${distRoot}`);
