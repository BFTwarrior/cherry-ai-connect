const assert = require("node:assert/strict");
const test = require("node:test");
const {
  CODEX_USAGE_BINARY,
  candidatePaths,
  resolveExecutable,
} = require("../electron/codex-usage-process.cjs");

test("Codex usage helper resolution prefers packaged resources and keeps a desktop fallback", () => {
  const paths = candidatePaths({
    isPackaged: true,
    resourcesPath: "C:\\Program Files\\Dingji",
    moduleDirectory: "C:\\Program Files\\Dingji\\resources\\app.asar\\electron",
    desktopPath: "C:\\Users\\tester\\Desktop",
  });
  assert.equal(paths[0], `C:\\Program Files\\Dingji\\${CODEX_USAGE_BINARY}`);
  assert.ok(paths.includes(`C:\\Users\\tester\\Desktop\\${CODEX_USAGE_BINARY}`));
  assert.equal(resolveExecutable({ moduleDirectory: "C:\\missing" }, () => false), "");
});

test("Codex usage helper resolves an existing packaged binary", () => {
  const expected = "C:\\Program Files\\Dingji\\resources\\codex-usage-windows-amd64.exe";
  const value = resolveExecutable({ isPackaged: true, resourcesPath: "C:\\Program Files\\Dingji\\resources" }, (file) => file === expected);
  assert.equal(value, expected);
});
