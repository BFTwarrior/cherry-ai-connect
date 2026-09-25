/**
 * 中文：只重建 dist/current-build 这个专用构建输出目录；dist 根目录中的既有安装包和演示包均保留。
 * electron-builder 只向隔离目录输出，避免旧版本产物混入本次构建结果。
 * English: Recreate only the dedicated dist/current-build output directory. Existing installers
 * and demo archives in dist remain untouched; electron-builder writes to the isolated directory.
 */
import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(process.cwd());
const distRoot = path.resolve(projectRoot, "dist");
const buildRoot = path.resolve(distRoot, "current-build");

if (path.basename(distRoot).toLowerCase() !== "dist" || path.dirname(distRoot) !== projectRoot) {
  throw new Error("refusing_to_clean_unexpected_dist_path");
}
if (path.dirname(buildRoot) !== distRoot || path.basename(buildRoot) !== "current-build") {
  throw new Error("refusing_to_clean_unexpected_build_path");
}

fs.mkdirSync(distRoot, { recursive: true });
fs.rmSync(buildRoot, { recursive: true, force: true });
fs.mkdirSync(buildRoot, { recursive: true });
console.log(`Prepared isolated build output: ${buildRoot}`);
