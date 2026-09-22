/** 中文：验证本地 vault 原子更新与受保护 DEK 恢复。 English: Local vault-store tests. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalVaultStore } from "../sync/local-vault-store.mjs";

const datasetId = "ds_01995f2c-7f5a-7b21-a8d2-6dfc50f4a901";
const protect = (value) => Buffer.from(`protected:${value}`, "utf8");
const unprotect = (value) => Buffer.from(value).toString("utf8").replace(/^protected:/, "");

test("local vault store updates secure settings without retaining the password", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cherry-vault-store-"));
  try {
    const store = new LocalVaultStore({ dataDir, protect, unprotect });
    const first = await store.initialize({ datasetId, secrets: { providers: [] }, password: "correct horse battery staple", kdfOptions: { t: 1, m: 1024, p: 1 } });
    assert.match(first.recoveryCode, /^CGRC-/);
    assert.equal(store.status().unlocked, true);
    const updated = await store.getEnvelope({ providers: [{ id: "route-a", apiKey: "sk-secret" }] }, datasetId);
    assert.equal(updated.vaultRevision, 2);
    const text = fs.readFileSync(path.join(dataDir, "vault.enc"), "utf8");
    assert.equal(text.includes("sk-secret"), false);
    assert.equal(text.includes("correct horse"), false);
    assert.ok(fs.readdirSync(path.join(dataDir, "backups")).length >= 1);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("local vault status detects an unreadable protected key", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cherry-vault-status-"));
  try {
    const store = new LocalVaultStore({ dataDir, protect, unprotect });
    await store.initialize({ datasetId, secrets: { providers: [] }, password: "correct horse battery staple", kdfOptions: { t: 1, m: 1024, p: 1 } });
    const unreadable = new LocalVaultStore({ dataDir, protect, unprotect: () => { throw new Error("dpapi_unavailable"); } });
    const status = unreadable.status();
    assert.equal(status.initialized, true);
    assert.equal(status.unlocked, false);
    assert.equal(status.error, "vault_local_key_unavailable");
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});
