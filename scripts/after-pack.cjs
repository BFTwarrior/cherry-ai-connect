/**
 * 中文：移除 Electron 在本产品当前 CSS/DOM 渲染路径中不会使用的 DirectX Shader Compiler
 * 运行时文件；保留 Chromium 的 D3D/Vulkan 回退组件，不改变普通硬件加速和粒子效果路径。
 * English: Remove DirectX Shader Compiler runtime files unused by this product's current
 * CSS/DOM rendering path. Chromium's D3D/Vulkan fallback components remain available.
 */
const fs = require("node:fs");
const path = require("node:path");

const OPTIONAL_RUNTIME_FILES = ["dxcompiler.dll", "dxil.dll"];

exports.default = async function afterPack(context) {
  const appOutDir = path.resolve(String(context?.appOutDir || ""));
  if (!appOutDir || path.basename(appOutDir).toLowerCase() !== "win-unpacked") throw new Error("unexpected_after_pack_directory");
  for (const name of OPTIONAL_RUNTIME_FILES) {
    const target = path.resolve(appOutDir, name);
    if (path.dirname(target) !== appOutDir || path.basename(target) !== name) throw new Error("unsafe_after_pack_target");
    fs.rmSync(target, { force: true });
  }
};
