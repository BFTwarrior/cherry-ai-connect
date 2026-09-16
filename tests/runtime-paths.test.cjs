/** 中文：验证正式版与开发版的数据目录边界。 English: Runtime-path placement tests. */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { resolveRuntimePaths } = require("../electron/runtime-paths");

test("packaged runtime data follows the selected installation drive", () => {
  const paths = resolveRuntimePaths({
    isPackaged: true,
    executablePath: "D:\\Cherry AI Connect\\Cherry AI 连接中心.exe",
    moduleDirectory: "C:\\ignored\\electron",
  });
  assert.equal(paths.runtimeDataRoot, path.resolve("D:\\Cherry AI Connect\\data"));
  assert.equal(paths.browserCacheRoot, path.resolve("D:\\Cherry AI Connect\\data\\browser-cache"));
  assert.equal(paths.gatewayDataRoot, path.resolve("D:\\Cherry AI Connect\\data\\gateway-data"));
});

test("development runtime data stays inside the project", () => {
  const paths = resolveRuntimePaths({
    isPackaged: false,
    executablePath: "C:\\Program Files\\nodejs\\node.exe",
    moduleDirectory: "D:\\Project\\electron",
  });
  assert.equal(paths.runtimeDataRoot, path.resolve("D:\\Project\\.runtime-data"));
  assert.equal(paths.browserCacheRoot, path.resolve("D:\\Project\\.runtime-data\\browser-cache"));
});
