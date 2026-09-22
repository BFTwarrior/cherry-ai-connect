/**
 * 中文：同步加密模块的格式不变量测试。
 * English: Format-invariant tests for the dedicated sync cryptography module.
 *
 * 中文：这些测试关注“拆模块不能改变同步协议”这一边界，而不是测试 UI。它们会验证
 * DEK、AAD、修订号和两个凭证 wrapper 仍然按同一份 envelope 合作。
 * English: These tests protect the "module extraction must not change the sync protocol" boundary,
 * not the UI. They verify that the DEK, AAD, revisions, and both credential wrappers still work
 * together through the same persisted envelope.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  createVault,
  openVaultWithDek,
  unlockVault,
  updateVault,
  validateVaultEnvelope,
} from "../sync/sync-crypto.mjs";

const datasetId = "ds_01995f2c-7f5a-7b21-a8d2-6dfc50f4a901";
const fastKdf = { t: 1, m: 1024, p: 1 };

test("dedicated crypto module preserves the persisted vault contract", async () => {
  const secrets = { providers: [{ id: "route-a", apiKey: "sk-secret" }] };
  const created = await createVault({ datasetId, secrets, password: "correct horse battery staple", kdfOptions: fastKdf });

  // 中文：协议字段必须继续存在；重构只能移动代码，不能改变远端资产格式。
  // English: Protocol fields must remain present; the refactor may move code but cannot change
  // the persisted remote asset format.
  assert.equal(created.envelope.format, "cherry-ai-connect-sync");
  assert.equal(created.envelope.schemaVersion, 1);
  assert.equal(created.envelope.objectType, "vault");
  assert.equal(created.envelope.vault.compression, "gzip");
  assert.equal(created.envelope.vault.contentType, "application/json");
  assert.equal(created.envelope.passwordWrap.kdf.m, 1024);
  assert.equal(created.envelope.recoveryWrap.kdf.m, 1024);
  validateVaultEnvelope(created.envelope, datasetId);

  const unlocked = await unlockVault(created.envelope, { password: "correct horse battery staple" });
  assert.deepEqual(unlocked.secrets, secrets);
  unlocked.dek.fill(0);

  const updated = updateVault(created.envelope, { providers: [] }, created.dek);
  assert.equal(updated.vaultRevision, 2);
  assert.deepEqual(openVaultWithDek(updated, created.dek), { providers: [] });
  created.dek.fill(0);
});

test("AAD prevents dataset, revision, and wrapper mix-ups", async () => {
  const created = await createVault({
    datasetId,
    secrets: { providers: [{ id: "route-a", apiKey: "sk-secret" }] },
    password: "correct horse battery staple",
    kdfOptions: fastKdf,
  });

  const wrongDataset = structuredClone(created.envelope);
  wrongDataset.datasetId = "ds_01995f2c-7f5a-7b21-b8d2-6dfc50f4a901";
  assert.throws(() => openVaultWithDek(wrongDataset, created.dek), /vault_authentication_failed/);

  const wrongRevision = structuredClone(created.envelope);
  wrongRevision.vaultRevision += 1;
  assert.throws(() => openVaultWithDek(wrongRevision, created.dek), /vault_authentication_failed/);

  const swapped = structuredClone(created.envelope);
  [swapped.passwordWrap, swapped.recoveryWrap] = [swapped.recoveryWrap, swapped.passwordWrap];
  await assert.rejects(() => unlockVault(swapped, { password: "correct horse battery staple" }), /vault_wrong_credential/);

  created.dek.fill(0);
});
