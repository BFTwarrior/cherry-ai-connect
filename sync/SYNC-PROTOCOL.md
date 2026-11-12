# Cherry AI Connect Cloud Sync Protocol — Schema 2

Current for product v1.41.0, updated 2026-11-12. The committed manifest uses schema 2 with minimum reader and writer version `2.0`. Product versions, manifest schema, and embedded configuration schema are separate identifiers.

本文对应v1.41.0正式版。上一份schema 1完整协议保存在[历史目录](../产品文档/历史/文档/2026-11-12-主页文档更新/SYNC-PROTOCOL-schema1.md)。共享对象与加密约定沿用原实现，下面记录v2布局、迁移和当前合并规则。

## Repository layout

| Area | Release tag | Role |
| --- | --- | --- |
| Legacy | `cherry-sync` | Retains schema 1 commits and supplies explicitly reviewed legacy imports |
| Current | `cherry-sync-v2` | Stores schema 2 commits after migration |

Use the user's selected private repository. Assets are immutable, hashed Release objects. Data uploads precede the committed manifest. A manifest is accepted only after dataset, schema, object-size, and SHA-256 validation. Filenames and wall-clock time do not decide conflicts.

The v2 namespace and cleanup operate independently from legacy assets. When a v2 dataset exists, upgraded devices join it. The client does not fall back to writing legacy format after a migration failure.

## Migration transaction

1. Inspect both Release areas and identify the existing dataset.
2. Preview legacy data and required vault authentication. Require confirmation that participating devices have upgraded.
3. Create a recoverable local backup, including configuration, local secret material, device identity and SQLite snapshot, with the existing desktop/vault recovery coverage.
4. Recheck the preview's local state and legacy manifest asset IDs and hashes. Changed inputs require a fresh preview.
5. Seed v2 with supported legacy objects, including historical usage beyond the local detail-cache window. Preserve the dataset and history.
6. Upload and verify the v2 commit. Record processed legacy fingerprints only after the v2 commit succeeds.

Authentication failures and missing keys retain the pending state. A failed attempt must not replace secrets with empty values or claim complete synchronization.

## Manifest and object contracts

The manifest envelope contains the following fields. The example omits asset descriptors and counters for brevity.

```json
{
  "format": "cherry-ai-connect-sync",
  "schemaVersion": 2,
  "minReaderVersion": "2.0",
  "minWriterVersion": "2.0",
  "datasetId": "ds_...",
  "syncId": "sync_...",
  "generation": 42,
  "parentGeneration": 41,
  "parentManifestSha256": "...",
  "state": "committed",
  "files": [],
  "tombstones": []
}
```

Embedded public configuration remains `schemaVersion: 1`. This value does not downgrade the enclosing schema 2 manifest. Encrypted secure configuration likewise has its own schema and dataset validation.

| Object | Current behavior |
| --- | --- |
| Usage events and cumulative counters | Merge by stable event/device identities, retain lifetime counts, acknowledge only the committed outbox snapshot |
| Provider references and client-key metadata | Merge explicit per-item revisions and tombstones, preserve locally unique entries when the remote omits them |
| Client-key order | Merge its independent revision while retaining local key secrets |
| Settings | Apply their revision independently from item edits |
| Encrypted vault | Authenticate before applying upstream secrets and URLs, retain ciphertext on failed authentication |
| Catalog metadata | Merge independent category, model-category and route-protocol records by exact ID and revision |

Public catalog metadata uses `id`, `kind`, `providerId`, `model`, `value`, `deleted`, and `revision { counter, deviceId }`. Model IDs retain exact spelling and case. Refreshing a directory preserves stored classification metadata. Route tags derive from the union of model categories.

Public configuration exports catalog metadata in both full-config and metadata-only sync paths. Upstream URLs and keys remain in the encrypted vault. Full client-key secrets stay local to each device. Existing local keys survive merge and update.

## Retired model-protocol records

v1.41.0 configures the upstream protocol at route level. New `model-protocol` mutations are rejected. Legacy candidate records remain readable for migration.

Before startup migration, remote merge, metadata-only merge, or explicit replacement persists an active retired record, the gateway saves a recoverable local snapshot and creates a tombstone with a revision counter greater than the observed catalog clock. Existing tombstones are not incremented again. A late active record with a higher revision is retired again before persistence.

Validation-only operations do not write migration backups. The runtime protocol resolver uses only the route setting, so an old model override cannot change request routing. Old offline development candidates retain their own old behavior until upgraded.

## Late legacy commits

Each round checks valid committed legacy manifests by asset ID and checksum. New legacy data produces a pending-merge state and an explicit preview. The merge includes supported usage events, counters, deletion markers, provider configuration, encrypted vault, client metadata, settings and order.

Changes between preview and confirmation invalidate the preview. Authentication failures remain pending. Old data missing new category or protocol fields does not clear those fields. Re-importing a processed legacy commit is idempotent. Its fingerprint is acknowledged only after a verified v2 commit.

## Security and failure handling

- Local forwarding continues while cloud sync is unavailable. Requests first enter the local SQLite ledger and remain pending until acknowledged.
- Prompts, responses, authorization headers, cookies, full client keys, passwords, recovery codes, and GitHub credentials are not cloud objects.
- Upstream secrets and URLs enter the authenticated encrypted vault. Usage metadata is stored as compressed objects, so the repository must remain private.
- Downloads are size-limited, hashed and staged before merge. Unknown required schema versions reject incompatible operations.
- Concurrent parent changes require fresh metadata and merge. Never acknowledge newly arrived outbox records through an older snapshot.
- Failed persistence restores the last durable local state. Retain backups and old assets until their existing retention and verification rules permit cleanup.

## Verification

The v1.41.0 regression suite covers two-device convergence, omissions and tombstones, concurrent and late branches, vault authentication failures, migration preview changes, v2 namespace isolation, history seeding, replay protection, backup recovery and retirement of late model-protocol records.

The full Node suite passed 256 tests. Real user-repository migration and affected-device update remain field-acceptance work. See the [current acceptance checklist](../产品文档/文档/流程与规范/05-待验收与后续计划.txt).
