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
  expandedReleaseAsset,
  releaseBodySha256,
  releasePageMetadata,
} = require("../electron/release-metadata");
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

test("release metadata keeps the installer verifiable when GitHub API digest is absent", () => {
  const hash = "d6c6fbce9dc4801745f96c6e510daad68b52b56ce58829a10287119b44c6e261";
  const releasePage = `<li>SHA-256: ${hash}</li><relative-time datetime="2026-09-17T19:56:23Z"></relative-time><include-fragment src="https://github.com/BFTwarrior/cherry-ai-connect/releases/expanded_assets/v1.21"></include-fragment>`;
  const metadata = releasePageMetadata(releasePage);
  assert.equal(metadata.sha256, hash);
  assert.equal(metadata.publishedAt, "2026-09-17T19:56:23Z");
  assert.equal(metadata.expandedAssetsUrl, "https://github.com/BFTwarrior/cherry-ai-connect/releases/expanded_assets/v1.21");
  assert.equal(releaseBodySha256("SHA256: `" + hash + "`"), hash);

  const asset = expandedReleaseAsset(`<a href="/BFTwarrior/cherry-ai-connect/releases/download/v1.21/Cherry-AI-Connect-Setup-1.21.exe"><span>Cherry-AI-Connect-Setup-1.21.exe</span></a><span>sha256:${hash}</span>`);
  assert.deepEqual(asset, {
    name: "Cherry-AI-Connect-Setup-1.21.exe",
    url: "https://github.com/BFTwarrior/cherry-ai-connect/releases/download/v1.21/Cherry-AI-Connect-Setup-1.21.exe",
    size: 0,
    sha256: hash,
  });
});
