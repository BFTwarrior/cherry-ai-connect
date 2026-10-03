/**
 * Keep the update pause owned by one lifecycle. Every failure/cancellation releases it;
 * a successful installer handoff keeps it until the old process exits.
 */
async function runWithUpdateSyncPaused({ manager, run, signal, shouldResume = () => true }) {
  try {
    if (manager) await manager.pauseForUpdate({ signal, tolerateSyncError: isTransientSyncFailure });
    signal?.throwIfAborted();
    return await run();
  } finally {
    if (manager && shouldResume()) manager.resumeAfterUpdate();
  }
}

function isTransientSyncFailure(error) {
  const code = String(error?.code || "");
  if (["github_rate_limit", "github_sync_backoff", "github_timeout", "github_network_error", "github_server_error"].includes(code)) return true;
  return code === "github_permission_or_rate_limit" && (
    error.rateRemaining === "0" || Boolean(error.retryAfter) || /(?:API rate limit exceeded|secondary rate limit)/i.test(String(error.message))
  );
}

// The caller must still stop the gateway and create/verify the complete local backup
// before installer handoff. This does not mark any outbox item as synchronized.
async function syncWithLocalBackupFallback({ manager, run, signal }) {
  try { await run(); return false; }
  catch (error) {
    signal?.throwIfAborted();
    if (!isTransientSyncFailure(error)) throw error;
    await manager.pauseForUpdate({ signal, tolerateSyncError: isTransientSyncFailure });
    return true;
  }
}

module.exports = { runWithUpdateSyncPaused, isTransientSyncFailure, syncWithLocalBackupFallback };
