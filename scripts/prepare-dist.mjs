/**
 * 中文：打包前删除项目内的 dist 生成目录，防止上一次解包运行产生的 data、缓存或
 * 测试配置被误装进下一份安装包。安全检查要求目标必须是当前项目直属的 dist。
 * English: Remove only this project's generated dist directory before packaging so runtime
 * data, caches, or test configuration from an unpacked smoke run cannot enter the next installer.
 */
import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(process.cwd());
const distRoot = path.resolve(projectRoot, "dist");

if (path.basename(distRoot).toLowerCase() !== "dist" || path.dirname(distRoot) !== projectRoot) {
  throw new Error("refusing_to_clean_unexpected_dist_path");
}

fs.rmSync(distRoot, { recursive: true, force: true });
console.log(`Prepared clean build output: ${distRoot}`);
