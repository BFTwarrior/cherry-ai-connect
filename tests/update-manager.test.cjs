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
  canRepairConsumedRecovery,
  normalizeSha256,
  restoreUpdateBackupIfNeeded,
  safeVersion,
  sha256File,
} = require("../electron/update-manager");

function seedRuntime(root) {
  const runtimeDataRoot = path.join(root, "install", "data");
  const gateway = path.join(runtimeDataRoot, "gateway-data");
  fs.mkdirSync(gateway, { recursive: true });
  fs.writeFileSync(path.join(gateway, "config.json"), JSON.stringify({ forcedLevel: "high", clientKeys: [{ id: "same-device-key" }] }), "utf8");
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
    const restored = restoreUpdateBackupIfNeeded({ runtimeDataRoot, legacyUserDataRoot, currentVersion: "1.2.0" });
    assert.equal(restored.restored, true);
    assert.equal(fs.readFileSync(path.join(runtimeDataRoot, "gateway-data", ".gateway-secret"), "utf8"), "local-secret");
    assert.equal(JSON.parse(fs.readFileSync(path.join(runtimeDataRoot, "desktop-settings.json"), "utf8")).setupCompleted, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("update recovery preserves desktop settings changed after backup", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cherry-update-settings-test-"));
  const runtimeDataRoot = seedRuntime(root);
  const updateRecoveryRoot = path.join(root, "recovery");
  const legacyUserDataRoot = path.join(root, "pointer");
  try {
    createUpdateBackup({ runtimeDataRoot, updateRecoveryRoot, legacyUserDataRoot, targetVersion: "1.23" });
    fs.writeFileSync(path.join(runtimeDataRoot, "desktop-settings.json"), JSON.stringify({ autoLaunch: false, startHidden: false }), "utf8");
    const restored = restoreUpdateBackupIfNeeded({ runtimeDataRoot, legacyUserDataRoot, currentVersion: "1.23.0" });
    assert.equal(restored.restored, false);
    assert.equal(restored.reason, "current-data-preserved");
    assert.equal(JSON.parse(fs.readFileSync(path.join(runtimeDataRoot, "desktop-settings.json"), "utf8")).autoLaunch, false);
    const pointer = JSON.parse(fs.readFileSync(path.join(legacyUserDataRoot, "cherry-ai-connect-update-recovery.json"), "utf8"));
    assert.ok(pointer.restoredAt);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("update recovery restores a missing desktop settings file but preserves saved reasoning", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cherry-update-missing-settings-"));
  const runtimeDataRoot = seedRuntime(root);
  try {
    createUpdateBackup({ runtimeDataRoot, updateRecoveryRoot: path.join(root, "recovery"), legacyUserDataRoot: path.join(root, "pointer"), targetVersion: "1.33" });
    fs.rmSync(path.join(runtimeDataRoot, "desktop-settings.json"));
    const restored = restoreUpdateBackupIfNeeded({ runtimeDataRoot, legacyUserDataRoot: path.join(root, "pointer"), currentVersion: "1.33" });
    assert.equal(restored.reason, "desktop-settings-restored");
    assert.equal(JSON.parse(fs.readFileSync(path.join(runtimeDataRoot, "desktop-settings.json"), "utf8")).setupCompleted, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(runtimeDataRoot, "gateway-data", "config.json"), "utf8")).forcedLevel, "high");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("update recovery restores a missing protected GitHub token without replacing current settings", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cherry-update-token-"));
  const runtimeDataRoot = seedRuntime(root);
  const gateway = path.join(runtimeDataRoot, "gateway-data");
  try {
    fs.writeFileSync(path.join(gateway, "sync-state.json"), JSON.stringify({ enabled: true, owner: "sample" }));
    fs.writeFileSync(path.join(gateway, ".github-token"), "protected-credential");
    createUpdateBackup({ runtimeDataRoot, updateRecoveryRoot: path.join(root, "recovery"), legacyUserDataRoot: path.join(root, "pointer"), targetVersion: "1.33" });
    fs.rmSync(path.join(gateway, ".github-token"));
    const restored = restoreUpdateBackupIfNeeded({ runtimeDataRoot, legacyUserDataRoot: path.join(root, "pointer"), currentVersion: "1.33" });
    assert.equal(restored.reason, "sync-credential-restored");
    assert.equal(fs.readFileSync(path.join(gateway, ".github-token"), "utf8"), "protected-credential");
    assert.equal(JSON.parse(fs.readFileSync(path.join(gateway, "config.json"), "utf8")).forcedLevel, "high");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("update recovery honors a deliberate cloud-sync disconnect", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cherry-update-disconnect-"));
  const runtimeDataRoot = seedRuntime(root);
  const gateway = path.join(runtimeDataRoot, "gateway-data");
  try {
    fs.writeFileSync(path.join(gateway, "sync-state.json"), JSON.stringify({ enabled: true }));
    fs.writeFileSync(path.join(gateway, ".github-token"), "protected-credential");
    createUpdateBackup({ runtimeDataRoot, updateRecoveryRoot: path.join(root, "recovery"), legacyUserDataRoot: path.join(root, "pointer"), targetVersion: "1.33" });
    fs.rmSync(path.join(gateway, ".github-token"));
    fs.writeFileSync(path.join(gateway, "sync-state.json"), JSON.stringify({ enabled: false }));
    const restored = restoreUpdateBackupIfNeeded({ runtimeDataRoot, legacyUserDataRoot: path.join(root, "pointer"), currentVersion: "1.33" });
    assert.equal(restored.restored, false);
    assert.equal(fs.existsSync(path.join(gateway, ".github-token")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("stale recovery backups never replace a newer empty runtime", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cherry-update-stale-test-"));
  const runtimeDataRoot = seedRuntime(root);
  const updateRecoveryRoot = path.join(root, "recovery");
  const legacyUserDataRoot = path.join(root, "pointer");
  try {
    createUpdateBackup({ runtimeDataRoot, updateRecoveryRoot, legacyUserDataRoot, targetVersion: "1.21" });
    fs.rmSync(runtimeDataRoot, { recursive: true, force: true });
    assert.throws(
      () => restoreUpdateBackupIfNeeded({ runtimeDataRoot, legacyUserDataRoot, currentVersion: "1.31.0" }),
      /update_recovery_version_mismatch/,
    );
    assert.equal(fs.existsSync(path.join(runtimeDataRoot, "gateway-data", ".gateway-secret")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("consumed recovery pointers are one-shot", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cherry-update-once-test-"));
  const runtimeDataRoot = seedRuntime(root);
  const updateRecoveryRoot = path.join(root, "recovery");
  const legacyUserDataRoot = path.join(root, "pointer");
  try {
    createUpdateBackup({ runtimeDataRoot, updateRecoveryRoot, legacyUserDataRoot, targetVersion: "1.31" });
    fs.rmSync(runtimeDataRoot, { recursive: true, force: true });
    const first = restoreUpdateBackupIfNeeded({ runtimeDataRoot, legacyUserDataRoot, currentVersion: "1.31" });
    assert.equal(first.restored, true);
    fs.rmSync(runtimeDataRoot, { recursive: true, force: true });
    const repaired = restoreUpdateBackupIfNeeded({ runtimeDataRoot, legacyUserDataRoot, currentVersion: "1.31" });
    assert.equal(repaired.reason, "gateway-data-repaired-after-consumption");
    fs.rmSync(runtimeDataRoot, { recursive: true, force: true });
    assert.throws(
      () => restoreUpdateBackupIfNeeded({ runtimeDataRoot, legacyUserDataRoot, currentVersion: "1.31" }),
      /update_recovery_data_missing_after_consumption/,
    );
    assert.equal(fs.existsSync(path.join(runtimeDataRoot, "gateway-data", ".gateway-secret")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("consumed recovery pointer can repair the immediate next version once", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cherry-update-repair-test-"));
  const runtimeDataRoot = seedRuntime(root);
  const updateRecoveryRoot = path.join(root, "recovery");
  const legacyUserDataRoot = path.join(root, "pointer");
  try {
    createUpdateBackup({ runtimeDataRoot, updateRecoveryRoot, legacyUserDataRoot, targetVersion: "1.31" });
    fs.rmSync(runtimeDataRoot, { recursive: true, force: true });
    const pointerFile = path.join(legacyUserDataRoot, "cherry-ai-connect-update-recovery.json");
    const pointer = JSON.parse(fs.readFileSync(pointerFile, "utf8"));
    fs.writeFileSync(pointerFile, JSON.stringify({ ...pointer, restoredAt: new Date().toISOString() }), "utf8");
    const repaired = restoreUpdateBackupIfNeeded({ runtimeDataRoot, legacyUserDataRoot, currentVersion: "1.32" });
    assert.equal(repaired.reason, "gateway-data-repaired-after-consumption");
    assert.equal(fs.readFileSync(path.join(runtimeDataRoot, "gateway-data", ".gateway-secret"), "utf8"), "local-secret");
    assert.throws(() => {
      fs.rmSync(path.join(runtimeDataRoot, "gateway-data"), { recursive: true, force: true });
      restoreUpdateBackupIfNeeded({ runtimeDataRoot, legacyUserDataRoot, currentVersion: "1.32" });
    }, /update_recovery_data_missing_after_consumption/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("recovery repair is limited to the same or immediate next minor version", () => {
  assert.equal(canRepairConsumedRecovery("1.31", "1.31"), true);
  assert.equal(canRepairConsumedRecovery("1.31", "1.32"), true);
  assert.equal(canRepairConsumedRecovery("1.21", "1.32"), false);
  assert.equal(canRepairConsumedRecovery("2.31", "1.32"), false);
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
