# Cherry AI Connect 1.1 Sync Protocol

> 中文：本文是 1.1 云同步实现的固定协议。
> English: This document is the fixed cloud-sync contract for version 1.1.

## 1. Safety boundary / 安全边界

- The local connection service remains usable when GitHub, authentication, or sync is unavailable.
- 本地请求先写入 SQLite；云端失败只保留待同步队列，不能阻塞本地转发。
- Prompt, response, message body, Authorization, cookies, full client keys, passwords, recovery codes, and OAuth/PAT tokens are never cloud objects.
- 上游 API Key、Base URL、认证方式、代理和 TLS 设置只能进入加密 vault。
- Every download is size-limited, hashed, parsed in a staging area, and merged only after validation.

## 2. Identifiers / 编号

| Field | Meaning |
| --- | --- |
| `datasetId` | One cloud data universe, formatted as `ds_<uuid>` |
| `deviceId` | Random installation identity, formatted as `dev_<uuid>` |
| `deviceEpoch` | Incremented when a cloned/rolled-back device identity is detected |
| `eventId` | Globally unique request event ID |
| `sequence` | Monotonic counter inside one `deviceId + deviceEpoch` |
| `syncId` | Unique ID for one sync attempt, formatted as `sync_<uuid>` |
| `generation` | Monotonic committed cloud generation |

All stored protocol timestamps use UTC ISO-8601. The interface displays UTC+8 or the user's chosen display zone. Time is never the sole conflict-resolution key.

## 3. GitHub layout / GitHub 布局

- One private repository per user-selected sync dataset.
- One fixed Release tagged `cherry-sync`.
- High-frequency data is stored as Release assets, not Git commits.
- Asset names are ASCII and immutable.

```text
manifest-20260917-183025-123-ssync_<uuid>.json
summary-20260917-183025-123-ssync_<uuid>.json.gz
config-20260917-183025-123-ssync_<uuid>.json.gz
vault-20260917-183025-123-ssync_<uuid>.enc
usage-<deviceId>-e<epoch>-<yyyymm>-s<first>-e<last>-20260917-183025-123-ssync_<uuid>.jsonl.gz
```

The date-time segment is generated in UTC+8 as `YYYYMMDD-HHmmss-SSS`. Readers still accept legacy `*-g000042-*` objects, while version 1.1 writes only the readable date-time form. The manifest's internal `generation` remains the authoritative order; filenames are never used to resolve conflicts.

日期时间段固定按 UTC+8 生成，格式为 `YYYYMMDD-HHmmss-SSS`。1.1 仍能读取旧的 `*-g000042-*` 文件，但新写入只使用日期时间名称。真正的版本顺序仍以 manifest 内部的 `generation` 为准，不能只看文件名判断冲突。

## 4. Manifest / 提交清单

```json
{
  "format": "cherry-ai-connect-sync",
  "schemaVersion": 1,
  "minReaderVersion": "1.1",
  "minWriterVersion": "1.1",
  "datasetId": "ds_...",
  "syncId": "sync_...",
  "generation": 42,
  "parentGeneration": 41,
  "parentManifestSha256": "hex-or-empty",
  "writerDeviceId": "dev_...",
  "writerDeviceEpoch": 1,
  "createdAtUtc": "2026-09-16T10:30:00.000Z",
  "displayTimezone": "Asia/Shanghai",
  "state": "committed",
  "configRevision": { "counter": 18, "deviceId": "dev_..." },
  "keyEpoch": 1,
  "vaultRevision": 3,
  "files": [],
  "tombstones": [],
  "retention": {
    "localDetailCacheBytes": 52428800,
    "localDetailTargetBytes": 47185920,
    "prunedBeforeUtc": null
  }
}
```

Only a `state: committed` manifest whose schema, dataset, parent, sizes, and SHA-256 values validate may be read. Unknown required versions make the client read-only.

## 5. Commit order / 提交顺序

1. Read and validate the latest committed manifest.
2. Export pending local events, per-device G-Counters, tombstones, public configuration, and encrypted vault.
3. Validate and gzip JSON/JSONL. Encrypt the compressed vault with AES-256-GCM.
4. Compute SHA-256 and size for every immutable data asset.
5. Re-read the latest manifest. If the parent changed, abandon the candidate and merge/retry.
6. Upload data assets.
7. Download every uploaded asset and verify exact size and SHA-256.
8. Upload the committed manifest last.
9. Download and verify the manifest and all references.
10. Only then mark local outbox events as synced.
11. Garbage collection is best effort and never changes commit success.

An interrupted candidate without a committed manifest is an orphan and is never treated as current data.

## 6. Merge rules / 合并规则

- Usage events merge by `eventId`; duplicates are ignored.
- Each `deviceId + deviceEpoch` counter merges by field-wise maximum. Global lifetime usage is the sum of all device counters.
- A counter must never decrease.
- Tombstones win over an older object revision and prevent deleted routes/client metadata from silently reappearing.
- Public configuration uses `{counter, deviceId}` revisions. Different-device edits to the same field create a conflict preview; they are not silently overwritten.
- Client-key secret values are local-only and are never restored from GitHub.
- Vault changes require a valid password/recovery key, matching `datasetId`, valid AAD, and a non-decreasing `keyEpoch`.

## 7. Vault format / 加密仓库

- A random 256-bit DEK encrypts gzip-compressed secure connection settings.
- Password and one-time recovery code independently derive KEKs using Argon2id.
- Each KEK wraps the same DEK with a fresh AES-256-GCM nonce.
- Vault ciphertext also uses a fresh AES-256-GCM nonce.
- AAD includes format, schema version, dataset ID, object type, key epoch, and vault revision.
- Password, recovery code, plaintext DEK, GitHub token, and client-key secrets are never uploaded.
- The local DEK and GitHub token are protected with Electron `safeStorage` (Windows DPAPI) before being written locally.

## 8. Compression and limits / 压缩与限额

- JSON and JSONL are UTF-8 and gzip compressed before upload.
- Target compressed usage segment: at most 20 MiB; hard limit: 24 MiB.
- Downloaded assets are rejected before decompression if they exceed their declared limit.
- Decompressed output is bounded; malformed gzip/JSON/JSONL is rejected.
- Local request details use a size-based cache: pruning starts only above 50 MiB and removes the oldest details until the database is near 45 MiB. There is no row-count or age-based deletion rule.
- 本机请求明细只按容量清理：超过 50 MiB 后删除最早明细，回落到约 45 MiB；不再按 200 条、50,000 条或半年期限删除。
- Lifetime G-Counters, request totals, and token totals have no time limit and are never reduced by detail-cache pruning.
- At 800 Release assets the UI warns; at 900 assets new no-op generations stop until safe mark-and-sweep succeeds.

## 9. Sync state machine / 同步状态机

```text
DISABLED
IDLE
DIRTY
SYNCING
PENDING_NETWORK
AUTH_REQUIRED
CONFLICT
ERROR_RECOVERABLE
ERROR_FATAL
```

Automatic sync checks every 30 minutes. Enabling sync, disabling sync, application startup, normal exit, clicking the window close button (including close-to-tray), manual sync, account/repository changes, restore, vault changes, and secure route changes trigger an additional sync attempt. The settings page shows the next planned sync time in UTC+8. A sync failure never stops the local service.

## 10. GitHub errors / GitHub 错误

- `401`: authentication required.
- `403`: inspect permissions, repository visibility, and rate-limit headers.
- `404`: repository, Release, or asset recovery flow.
- `409` / `412`: re-read the parent manifest and merge/retry.
- `422`: invalid immutable object or API input; do not loop.
- `429`: honor `Retry-After` and rate-limit headers.
- `5xx`, timeout, reset, and offline: bounded exponential backoff with jitter.

Retries have a maximum count. Exit sync has a short deadline and leaves durable outbox data for the next start.

## 11. Compatibility / 兼容性

- `schemaVersion = 1` remains the data schema; version 1.1 changes only asset naming and minimum compatible application version.
- Readers reject a manifest with a higher `minReaderVersion`.
- Writers refuse to overwrite a manifest with a higher `minWriterVersion`.
- Future optional fields must have safe defaults.
- Any core schema change requires a migration and rollback point.

## 12. Release gate / 发布门槛

The implementation is not release-ready until fake-provider interruption tests, multi-device merge tests, vault tamper/password tests, local crash recovery, packaged tray behavior, migration, reinstall, and a small real private GitHub repository test have recorded evidence.
