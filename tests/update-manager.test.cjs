/**
 * 中文：验证一键更新在覆盖安装前备份数据，并能在安装目录数据缺失时完整恢复。
 * English: Verify one-click update backup and recovery before an overwrite installation.
 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  createUpdateBackup,
  normalizeSha256,
  restoreUpdateBackupIfNeeded,
  safeVersion,
  sha256File,
} = require("../electron/update-manager");

function seedRuntime(root) {
  const runtimeDataRoot = path.join(root, "install", "data");
  const gateway = path.join(runtimeDataRoot, "gateway-data");
  fs.mkdirSync(gateway, { recursive: true });
  fs.writeFileSync(path.join(gateway, "config.json"), JSON.stringify({ clientKeys: [{ id: "same-device-key" }] }), "utf8");
  fs.writeFileSync(path.join(gateway, ".gateway-secret"), "local-secret", "utf8");
  fs.writeFileSync(path.join(gateway, "device.json"), JSON.stringify({ deviceId: "device-local" }), "utf8");
  fs.writeFileSync(path.join(runtimeDataRoot, "desktop-settings.json"), JSON.stringify({ setupCompleted: true }), "utf8");
  return runtimeDataRoot;
}

test("update backup restores data and completed onboarding after an overwrite", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cherry-update-test-"));
  const runtimeDataRoot = seedRuntime(root);
  const updateRecoveryRoot = path.join(root, "recovery");
  const legacyUserDataRoot = path.join(root, "pointer");
  try {
    const backup = createUpdateBackup({ runtimeDataRoot, updateRecoveryRoot, legacyUserDataRoot, targetVersion: "1.2" });
    assert.ok(fs.existsSync(path.join(backup.backupRoot, "gateway-data", ".gateway-secret")));
    fs.rmSync(runtimeDataRoot, { recursive: true, force: true });
    const restored = restoreUpdateBackupIfNeeded({ runtimeDataRoot, legacyUserDataRoot });
    assert.equal(restored.restored, true);
    assert.equal(fs.readFileSync(path.join(runtimeDataRoot, "gateway-data", ".gateway-secret"), "utf8"), "local-secret");
    assert.equal(JSON.parse(fs.readFileSync(path.join(runtimeDataRoot, "desktop-settings.json"), "utf8")).setupCompleted, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("update helpers reject unsafe versions and normalize trusted checksums", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cherry-update-hash-"));
  const file = path.join(root, "installer.exe");
  try {
    fs.writeFileSync(file, "verified-installer", "utf8");
    const expected = crypto.createHash("sha256").update("verified-installer").digest("hex");
    assert.equal(sha256File(file), expected);
    assert.equal(normalizeSha256(`sha256:${expected.toUpperCase()}`), expected);
    assert.equal(normalizeSha256("not-a-hash"), "");
    assert.equal(safeVersion("v1.2.0"), "1.2.0");
    assert.throws(() => safeVersion("1.2/../../bad"), /update_invalid_version/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
