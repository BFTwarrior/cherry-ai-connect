/**
 * 中文：集中计算运行数据路径，确保正式版数据跟随安装位置而不是固定写入 C 盘。
 * English: Resolve runtime data paths beside the packaged app instead of pinning them to drive C.
 */
const path = require("node:path");

function resolveRuntimePaths({ isPackaged, executablePath, moduleDirectory }) {
  const applicationRoot = isPackaged
    ? path.dirname(path.resolve(executablePath))
    : path.resolve(moduleDirectory, "..");
  // The NSIS installer replaces the application directory. Keep user data beside that directory.
  const legacyInstallDataRoot = path.join(applicationRoot, "data");
  const runtimeDataRoot = isPackaged
    ? path.join(path.dirname(applicationRoot), `${path.basename(applicationRoot)}-data`)
    : path.join(applicationRoot, ".runtime-data");
  return {
    applicationRoot,
    legacyInstallDataRoot,
    runtimeDataRoot,
    browserCacheRoot: path.join(runtimeDataRoot, "browser-cache"),
    gatewayDataRoot: path.join(runtimeDataRoot, "gateway-data"),
    // 中文：更新备份放在安装目录旁而不是安装目录内，避免覆盖安装清理应用目录时一起删除。
    // English: Keep update recovery beside the install folder so an overwrite cannot remove both app and backup.
    updateRecoveryRoot: path.join(path.dirname(applicationRoot), ".cherry-ai-connect-recovery"),
  };
}

module.exports = { resolveRuntimePaths };
