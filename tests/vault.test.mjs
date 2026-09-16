/** 中文：验证密码/恢复码、篡改保护和错误凭证不污染 vault。 English: Vault security tests. */
import assert from "node:assert/strict";
import test from "node:test";
import { createVault, openVaultWithDek, unlockVault, updateVault } from "../sync/vault.mjs";

const datasetId = "ds_01995f2c-7f5a-7b21-a8d2-6dfc50f4a901";
const fastKdf = { t: 1, m: 1024, p: 1 };

test("vault decrypts with password and recovery code and rejects tampering", async () => {
  const secrets = { providers: [{ id: "route-a", baseUrl: "https://example.invalid", apiKey: "sk-secret" }] };
  const created = await createVault({ datasetId, secrets, password: "correct horse battery staple", kdfOptions: fastKdf });
  const byPassword = await unlockVault(created.envelope, { password: "correct horse battery staple" });
  assert.deepEqual(byPassword.secrets, secrets);
  byPassword.dek.fill(0);
  const byRecovery = await unlockVault(created.envelope, { recoveryCode: created.recoveryCode });
  assert.deepEqual(byRecovery.secrets, secrets);
  byRecovery.dek.fill(0);
  await assert.rejects(() => unlockVault(created.envelope, { password: "definitely wrong password" }), /vault_wrong_credential/);

  const tampered = structuredClone(created.envelope);
  tampered.vault.ciphertext = `${tampered.vault.ciphertext.slice(0, -2)}AA`;
  assert.throws(() => openVaultWithDek(tampered, created.dek), /vault_authentication_failed/);

  const updated = updateVault(created.envelope, { providers: [] }, created.dek);
  assert.equal(updated.vaultRevision, 2);
  assert.deepEqual(openVaultWithDek(updated, created.dek), { providers: [] });
  created.dek.fill(0);
});
