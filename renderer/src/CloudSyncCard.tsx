/**
 * 中文：GitHub 私有 Release 云同步控制卡。密码只用于解锁加密 vault，绝不保存或上传。
 * English: GitHub private-Release sync card. The vault password is never stored or uploaded.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

type Language = "zh" | "en";
type ConfirmRequest = (options: { title: string; message: string; confirmLabel: string; cancelLabel: string; tone?: "primary" | "warning" | "danger"; icon?: string }) => Promise<boolean>;

const emptyStatus: CloudSyncStatus = {
  enabled: false, syncUpstream: false, connected: false, provider: "github", owner: "", repository: "cherry-ai-connect-sync", repositoryPrivate: false,
  account: null, state: "DISABLED", datasetId: "", generation: 0, pendingCount: 0, lastSyncAt: "", lastAttemptAt: "", nextSyncAt: "",
  errorCode: "", error: "", warning: "", intervalMinutes: 1, vault: { initialized: false, unlocked: false },
};

// 中文：演示页面使用一个看起来完整但完全虚构的云同步状态；任何按钮都只修改 React 内存状态。
// English: The demo page uses a complete but fictional cloud-sync state; its buttons only mutate React memory.
const demoStatus: CloudSyncStatus = {
  enabled: true, syncUpstream: true, connected: true, provider: "github", owner: "demo-user", repository: "cherry-ai-connect-demo", repositoryPrivate: true,
  account: { id: "demo-account", login: "demo-user" }, state: "IDLE", datasetId: "demo-dataset-2026", generation: 12, pendingCount: 0,
  lastSyncAt: "2026-09-19T02:05:00.000Z", lastAttemptAt: "2026-09-19T02:05:00.000Z", nextSyncAt: "2026-09-19T02:06:00.000Z",
  errorCode: "", error: "", warning: "", intervalMinutes: 1, vault: { initialized: true, unlocked: true, datasetId: "demo-dataset-2026", keyEpoch: 1, vaultRevision: 4 },
};

function SyncIcon({ name }: { name: "cloud" | "github" | "refresh" | "pause" | "shield" | "copy" | "external" | "user" }) {
  const paths = {
    cloud: <><path d="M7 18h10a4 4 0 0 0 .7-7.9A6 6 0 0 0 6.2 8.7 4.7 4.7 0 0 0 7 18Z" /><path d="m9 14 3-3 3 3M12 11v8" /></>,
    github: <><path d="M15 21v-3.9c0-1 .1-1.5-.5-2 2.7-.3 5.5-1.3 5.5-6A4.7 4.7 0 0 0 18.8 6 4.4 4.4 0 0 0 18.7 3S17.7 2.7 15 4a11 11 0 0 0-6 0C6.3 2.7 5.3 3 5.3 3A4.4 4.4 0 0 0 5.2 6 4.7 4.7 0 0 0 4 9.2c0 4.6 2.8 5.6 5.5 5.9-.4.4-.6.9-.6 1.8V21" /><path d="M9 19c-2.5.8-4-1-4-1.8" /></>,
    refresh: <><path d="M20 11a8 8 0 0 0-14.7-4L3 10M3 5v5h5M4 13a8 8 0 0 0 14.7 4L21 14M21 19v-5h-5" /></>,
    pause: <><path d="M9 5v14M15 5v14" /></>,
    shield: <><path d="M12 3 20 6v5c0 5.2-3.4 8.5-8 10-4.6-1.5-8-4.8-8-10V6z" /><path d="m8.5 12 2.3 2.3 4.8-5" /></>,
    copy: <><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
    external: <><path d="M14 5h5v5m0-5-8 8" /><path d="M18 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></>,
    user: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

function displayTime(value: string, language: Language) {
  if (!value) return language === "zh" ? "尚无记录" : "Not yet";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return date.toLocaleString(language === "zh" ? "zh-CN" : "en-US", { timeZone: "Asia/Shanghai", hour12: false });
}

function displayBackupVersion(value: string, generation: number, language: Language) {
  if (!value) return language === "zh" ? "尚未生成" : "Not created";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  const stamp = date.toLocaleString(language === "zh" ? "zh-CN" : "en-GB", {
    timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  return generation > 0 ? `${stamp} · #${generation}` : stamp;
}

function readableSyncError(value: string, language: Language) {
  if (value.includes("sync_paused_for_update")) return language === "zh"
    ? "软件更新期间云同步暂时暂停；可在设置中查看或取消更新。更新停止后会自动恢复同步。"
    : "Cloud sync is paused while the app updates. View or cancel the update in Settings; sync resumes when it stops.";
  if (/(fetch failed|github_network_error|github_timeout)/i.test(value)) return language === "zh"
    ? "暂时无法连接 GitHub；请检查网络或代理，网络恢复后会重新同步。"
    : "GitHub is temporarily unreachable. Check the network or proxy; sync will retry when connectivity returns.";
  return value;
}

export function CloudSyncCard({ language, requestConfirmation, demo = false, demoConflict = false, demoPausedForUpdate = false }: { language: Language; requestConfirmation: ConfirmRequest; demo?: boolean; demoConflict?: boolean; demoPausedForUpdate?: boolean }) {
  const tr = useCallback((zh: string, en: string) => language === "zh" ? zh : en, [language]);
  const [status, setStatus] = useState<CloudSyncStatus>(emptyStatus);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [vaultCredential, setVaultCredential] = useState("");
  const [syncUpstream, setSyncUpstream] = useState(false);

  useEffect(() => {
    if (demo) {
      const fixture = demoConflict
        ? { ...demoStatus, state: "ERROR_RECOVERABLE", warning: "sync_vault_unavailable_usage_only", errorCode: "vault_unlock_required", pendingCount: 1, vault: { ...demoStatus.vault, unlocked: false } }
        : demoStatus;
      setStatus({ ...fixture, state: fixture.state as CloudSyncStatus["state"], pausedForUpdate: demoPausedForUpdate, nextSyncAt: demoPausedForUpdate ? "" : fixture.nextSyncAt });
      setLoading(false);
      return;
    }
    let active = true;
    const applyStatus = (value: CloudSyncStatus) => {
      if (!active) return;
      setStatus(value);
      if (!value.pausedForUpdate) setError((current) => current.includes("sync_paused_for_update") ? "" : current);
    };
    void window.desktop?.getSyncStatus?.().then(applyStatus).catch((reason) => { if (active) setError(String(reason?.message || reason)); }).finally(() => { if (active) setLoading(false); });
    const remove = window.desktop?.onSyncStatus?.(applyStatus);
    return () => { active = false; remove?.(); };
  }, [demo, demoConflict, demoPausedForUpdate]);

  const stateLabel = useMemo(() => status.pausedForUpdate ? tr("更新期间暂停", "Paused for update") : ({
    DISABLED: tr("自动同步已关闭", "Automatic sync off"), IDLE: tr("云端与本机已同步", "Cloud and local are synced"), DIRTY: tr("有数据等待同步", "Changes waiting to sync"),
    SYNCING: tr("正在安全同步", "Secure sync in progress"), PENDING_NETWORK: tr("网络恢复后重试", "Waiting for network"), AUTH_REQUIRED: tr("需要重新连接 GitHub", "GitHub reconnection required"),
    CONFLICT: tr("需要处理同步冲突", "Sync conflict needs attention"), ERROR_RECOVERABLE: tr("同步失败，可重试", "Sync failed; retry available"), ERROR_FATAL: tr("同步已保护性停止", "Sync stopped for safety"),
  }[status.state] || status.state), [status.state, status.pausedForUpdate, tr]);

  const connect = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!demo && !window.desktop?.connectGitHub) return setError(tr("请在桌面版中连接 GitHub", "Connect GitHub from the desktop app"));
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const wantsUpstreamSync = form.get("syncUpstream") === "on";
    const password = String(form.get("password") || "");
    const confirmPassword = String(form.get("confirmPassword") || "");
    if (wantsUpstreamSync && password !== confirmPassword) return setError(tr("两次输入的加密密码不一致", "The vault passwords do not match"));
    if (wantsUpstreamSync && password.length < 8) return setError(tr("加密密码至少需要 8 个字符", "Use at least 8 characters for the vault password"));
    setBusy(true); setError("");
    try {
      if (demo) {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        setStatus({ ...demoStatus, syncUpstream: wantsUpstreamSync, lastSyncAt: new Date().toISOString(), generation: demoStatus.generation + 1 });
        setRecoveryCode("CGRC-DEMO-7F3A-92KD");
        formElement.reset();
        return;
      }
      const result = await window.desktop!.connectGitHub({ token: String(form.get("token") || ""), repository: String(form.get("repository") || "cherry-ai-connect-sync"), password, syncUpstream: wantsUpstreamSync });
      setStatus(result.status);
      setRecoveryCode(result.recoveryCode || "");
      formElement.reset();
    } catch (reason) { setError(String(reason instanceof Error ? reason.message : reason)); }
    finally { setBusy(false); }
  };

  const syncNow = async () => {
    setBusy(true); setError("");
    try {
      if (demo) {
        await new Promise((resolve) => window.setTimeout(resolve, 600));
        setStatus((current) => ({ ...current, state: "IDLE", lastSyncAt: new Date().toISOString(), generation: current.generation + 1 }));
      } else if (window.desktop?.syncNow) setStatus(await window.desktop.syncNow());
    }
    catch (reason) { setError(String(reason instanceof Error ? reason.message : reason)); }
    finally { setBusy(false); }
  };

  const toggle = async () => {
    setBusy(true); setError("");
    try {
      if (demo) {
        await new Promise((resolve) => window.setTimeout(resolve, 280));
        setStatus((current) => ({ ...current, enabled: !current.enabled, state: current.enabled ? "DISABLED" : "IDLE" }));
      } else if (window.desktop?.setSyncEnabled) setStatus(await window.desktop.setSyncEnabled(!status.enabled));
    }
    catch (reason) { setError(String(reason instanceof Error ? reason.message : reason)); }
    finally { setBusy(false); }
  };

  const disconnect = async () => {
    const confirmed = await requestConfirmation({
      title: tr("断开 GitHub 连接？", "Disconnect GitHub?"),
      message: tr("会先尝试同步一次，然后删除本机保存的 GitHub 登录凭证。GitHub 私有仓库和云端备份不会被删除，本地连接服务继续工作。", "One final sync will be attempted, then the locally stored GitHub credential is removed. The private repository, cloud backup, and local service remain."),
      confirmLabel: tr("断开连接", "Disconnect"), cancelLabel: tr("取消", "Cancel"), tone: "warning", icon: "shield",
    });
    if (!confirmed) return;
    setBusy(true); setError("");
    try {
      if (demo) {
        await new Promise((resolve) => window.setTimeout(resolve, 360));
        setStatus(emptyStatus);
        setRecoveryCode("");
      } else if (window.desktop?.disconnectGitHub) setStatus(await window.desktop.disconnectGitHub());
    }
    catch (reason) { setError(String(reason instanceof Error ? reason.message : reason)); }
    finally { setBusy(false); }
  };

  const unlockVault = async () => {
    const credential = vaultCredential.trim();
    if (!credential) return setError(tr("请输入备份加密密码或 CGRC 恢复码", "Enter the backup vault password or a CGRC recovery code"));
    setBusy(true); setError("");
    try {
      if (demo) {
        await new Promise((resolve) => window.setTimeout(resolve, 360));
        setStatus((current) => ({ ...current, state: "IDLE", vault: { ...current.vault, initialized: true, unlocked: true } }));
        setVaultCredential("");
        return;
      }
      const isRecoveryCode = /^CGRC-/i.test(credential);
      const unlocked = await window.desktop?.unlockSyncVault?.({
        password: isRecoveryCode ? "" : credential,
        recoveryCode: isRecoveryCode ? credential : "",
      });
      if (unlocked?.status) setStatus(unlocked.status);
      if (unlocked?.recoveryCode) setRecoveryCode(unlocked.recoveryCode);
      setVaultCredential("");
    } catch (reason) { setError(String(reason instanceof Error ? reason.message : reason)); }
    finally { setBusy(false); }
  };

  const copyRecovery = async () => {
    try { await navigator.clipboard.writeText(recoveryCode); }
    catch { setError(tr("复制失败，请手动选中恢复码", "Copy failed; select the recovery code manually")); }
  };

  return <article className={`settings-card cloud-sync-card${status.pausedForUpdate ? " is-update-paused" : ""}`}>
    <div className="cloud-sync-heading"><span className="settings-icon cloud-icon"><SyncIcon name="cloud" /></span><div><div className="cloud-title-line"><h3>{tr("GitHub 云同步", "GitHub cloud sync")}</h3>{status.connected && <span key={status.pausedForUpdate ? "paused" : "running"} className={`sync-state-chip state-${status.pausedForUpdate ? "paused-update" : status.state.toLowerCase()}`}>{status.pausedForUpdate ? <SyncIcon name="pause" /> : <span />}{stateLabel}</span>}</div><p>{tr("用一个私有仓库保存用量和可选的加密配置；修改后自动同步，并每分钟检查其他设备的最新版本。", "A private repository stores usage and optional encrypted configuration; changes sync automatically and other devices are checked every minute.")}</p></div></div>
    {status.connected && <div className="sync-mode-summary"><span className="status-dot" /><strong>{status.syncUpstream ? tr("中转站 API 加密同步已开启", "Encrypted upstream API sync is on") : tr("中转站 API 默认不上传", "Upstream API sync is off by default")}</strong><small>{status.syncUpstream ? tr("用量、客户端条目与顺序自动同步；中转站密钥通过保险库加密同步。", "Usage, client entries and order sync automatically; upstream keys sync through the encrypted vault.") : tr("当前同步用量、客户端条目和排列顺序。", "Usage, client entries and their order sync now.")}</small></div>}
    {status.pausedForUpdate && <div className="sync-warning sync-update-notice" role="status">{tr("软件正在更新，云同步暂时暂停。可在设置中查看进度或取消更新；更新结束或失败后自动恢复同步，本地待同步数据会保留。", "The app is updating, so cloud sync is temporarily paused. View progress or cancel in Settings. Sync resumes when the update ends or fails; pending local changes are retained.")}</div>}

    {!status.connected ? <form className="github-connect-form" onSubmit={connect}>
      <div className="github-permission-note"><SyncIcon name="github" /><div><strong>{tr("用 GitHub 凭证连接", "Connect with a GitHub credential")}</strong><span>{tr("当前版本使用 GitHub 访问令牌完成账户连接。令牌由 Windows 安全存储加密，只发送给 GitHub API。需要私有仓库读写权限。", "This version connects with a GitHub access token. Windows protects it locally and it is sent only to the GitHub API. Private-repository read/write access is required.")}</span></div><button type="button" className="text-button" onClick={() => void window.desktop?.openExternal("https://github.com/settings/tokens/new?scopes=repo&description=Cherry%20AI%20Connect")}><SyncIcon name="external" />{tr("创建令牌", "Create token")}</button></div>
      <div className="sync-form-grid"><label><span>{tr("GitHub 访问令牌", "GitHub access token")}</span><input name="token" type="password" autoComplete="off" placeholder="github_pat_… / ghp_…" required /></label><label><span>{tr("私有仓库名称", "Private repository name")}</span><input name="repository" defaultValue="cherry-ai-connect-sync" pattern="[A-Za-z0-9._-]{1,100}" required /></label></div>
      <label className="sync-option"><input name="syncUpstream" type="checkbox" checked={syncUpstream} onChange={(event) => setSyncUpstream(event.target.checked)} /><span><strong>{tr("同步中转站 API（加密）", "Sync upstream APIs (encrypted)")}</strong><small>{tr("默认关闭；开启后才会要求备份加密密码。用量、客户端条目与顺序仅需 GitHub 凭据即可同步。", "Off by default; enabling it requires a vault password. Usage, client entries and order sync with a GitHub credential alone.")}</small></span></label>
      {syncUpstream && <div className="sync-form-grid"><label><span>{tr("备份加密密码", "Backup vault password")}</span><input name="password" type="password" minLength={8} autoComplete="new-password" required /></label><label><span>{tr("再次输入密码", "Confirm password")}</span><input name="confirmPassword" type="password" minLength={8} autoComplete="new-password" required /></label></div>}
      <div className="sync-security-line"><SyncIcon name="shield" /><span>{tr("不会上传聊天内容、完整客户端 Key、密码、恢复码或 GitHub 令牌。用量数据独立上传；中转站地址与上游 Key 只有开启后才加密上传。", "Prompts, full client keys, passwords, recovery codes, and GitHub tokens never upload. Usage syncs independently; routes and upstream keys are encrypted only when enabled.")}</span></div>
      {error && <div className="sync-error">{readableSyncError(error, language)}</div>}
      <div className="sync-actions"><button className="button button-primary" type="submit" disabled={busy || loading || status.pausedForUpdate}><SyncIcon name="github" />{busy ? tr("正在连接并首次同步…", "Connecting and syncing…") : tr("连接 GitHub 并开启同步", "Connect GitHub and enable sync")}</button></div>
    </form> : <>
      <div className="sync-account-row"><div className="account-avatar">{status.account?.avatarUrl ? <img src={status.account.avatarUrl} alt="" /> : <SyncIcon name="user" />}</div><div><small>{tr("已连接账户", "Connected account")}</small><strong>@{status.account?.login}</strong></div><div><small>{tr("私有仓库", "Private repository")}</small><strong>{status.owner}/{status.repository}</strong></div><div><small>{tr("待同步", "Pending")}</small><strong>{status.pendingCount}</strong></div><button type="button" className="text-button" onClick={() => void window.desktop?.openExternal(`https://github.com/${status.owner}/${status.repository}/releases/tag/cherry-sync`)}><SyncIcon name="external" />{tr("查看私有备份", "View private backup")}</button></div>
      <div className="sync-metrics"><div><small>{tr("上次完成（UTC+8）", "Last completed (UTC+8)")}</small><strong>{displayTime(status.lastSyncAt, language)}</strong></div><div><small>{tr("下次同步（UTC+8）", "Next sync (UTC+8)")}</small><strong>{status.pausedForUpdate ? tr("更新结束后恢复", "Resumes after update") : status.enabled ? displayTime(status.nextSyncAt, language) : tr("自动同步已关闭", "Automatic sync off")}</strong></div><div><small>{tr("备份版本（UTC+8）", "Backup version (UTC+8)")}</small><strong>{displayBackupVersion(status.lastSyncAt, status.generation, language)}</strong></div><div><small>Dataset ID</small><strong title={status.datasetId}>{status.datasetId ? `${status.datasetId.slice(0, 10)}…${status.datasetId.slice(-6)}` : "—"}</strong></div></div>
      {!status.pausedForUpdate && (error || status.error) && <div className="sync-error">{readableSyncError(error || status.error, language)}<small>{/^[a-z]+(?:_[a-z0-9]+)+$/.test(status.errorCode) ? status.errorCode : ""}</small></div>}
      {status.warning && <div className="sync-warning">{status.warning === "sync_disabled_with_pending_data" ? tr("自动同步已关闭，但仍有本地数据等待下次上传。", "Automatic sync is off, but local changes are still waiting to upload.") : status.warning === "sync_vault_unavailable_usage_only" ? tr("本次已同步用量和客户端条目；中转站地址和上游 API Key 等待解锁本机保险库后同步。", "Usage and client entries synced; upstream routes and API keys will sync after the local vault is unlocked.") : status.warning}</div>}
      {(!status.syncUpstream || !status.vault.unlocked || status.warning === "sync_vault_unavailable_usage_only") && <div className="sync-conflict-panel"><div><strong>{tr(status.syncUpstream ? "解锁中转站加密同步" : "开启中转站加密同步", status.syncUpstream ? "Unlock encrypted upstream sync" : "Enable encrypted upstream sync")}</strong><p>{tr("用量、客户端条目和顺序已独立同步。中转站地址和 API Key 需要保险库密码验证后自动合并最新版本；首次开启请设置至少 8 位密码，已有云备份请使用原密码或 CGRC 恢复码。", "Usage, client entries and order sync independently. Upstream URLs and API keys merge automatically after vault authentication. Use at least 8 characters for first setup, or the original password / CGRC recovery code for an existing backup.")}</p></div><label><span>{tr("保险库密码或 CGRC 恢复码", "Vault password or CGRC recovery code")}</span><input type="password" value={vaultCredential} onChange={(event) => setVaultCredential(event.target.value)} autoComplete="off" /></label><div><button type="button" className="button button-primary" onClick={() => void unlockVault()} disabled={busy || status.pausedForUpdate}>{tr("解锁并自动同步", "Unlock and sync automatically")}</button></div></div>}
      <div className="sync-actions"><button type="button" className="button button-secondary" onClick={() => void toggle()} disabled={busy || status.pausedForUpdate}><SyncIcon name="cloud" />{status.enabled ? tr("关闭自动同步", "Turn off automatic sync") : tr("开启自动同步", "Turn on automatic sync")}</button><button type="button" className={`button button-primary${status.pausedForUpdate ? " sync-paused" : status.state === "SYNCING" ? " sync-working" : ""}`} onClick={() => void syncNow()} disabled={busy || status.pausedForUpdate || status.state === "SYNCING"}><SyncIcon name={status.pausedForUpdate ? "pause" : "refresh"} />{status.pausedForUpdate ? tr("更新期间暂停", "Paused for update") : status.state === "SYNCING" ? tr("同步中…", "Syncing…") : tr("立即同步", "Sync now")}</button><button type="button" className="button button-ghost sync-disconnect" onClick={() => void disconnect()} disabled={busy || status.pausedForUpdate}>{tr("断开账户", "Disconnect account")}</button></div>
    </>}

    {recoveryCode && <div className="recovery-panel"><div><strong>{tr("恢复码只显示这一次", "Recovery code — shown once")}</strong><p>{tr("保存到安全位置。换电脑或忘记加密密码时需要它；我们不会替你找回。", "Store it safely. It is required after moving PCs or losing the vault password; it cannot be recovered for you.")}</p></div><code>{recoveryCode}</code><button type="button" className="button button-secondary" onClick={() => void copyRecovery()}><SyncIcon name="copy" />{tr("复制恢复码", "Copy recovery code")}</button><button type="button" className="text-button" onClick={() => setRecoveryCode("")}>{tr("我已安全保存", "I stored it safely")}</button></div>}
  </article>;
}
