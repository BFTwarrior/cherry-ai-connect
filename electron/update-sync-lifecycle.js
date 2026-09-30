/**
 * Keep the update pause owned by one lifecycle. Every failure/cancellation releases it;
 * a successful installer handoff keeps it until the old process exits.
 */
async function runWithUpdateSyncPaused({ manager, run, signal, shouldResume = () => true }) {
  try {
    if (manager) await manager.pauseForUpdate({ signal });
    signal?.throwIfAborted();
    return await run();
  } finally {
    if (manager && shouldResume()) manager.resumeAfterUpdate();
  }
}

module.exports = { runWithUpdateSyncPaused };
