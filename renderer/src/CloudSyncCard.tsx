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
  errorCode: "", error: "", warning: "", intervalMinutes: 30, vault: { initialized: false, unlocked: false },
};

// 中文：演示页面使用一个看起来完整但完全虚构的云同步状态；任何按钮都只修改 React 内存状态。
// English: The demo page uses a complete but fictional cloud-sync state; its buttons only mutate React memory.
const demoStatus: CloudSyncStatus = {
  enabled: true, syncUpstream: true, connected: true, provider: "github", owner: "demo-user", repository: "cherry-ai-connect-demo", repositoryPrivate: true,
  account: { id: "demo-account", login: "demo-user" }, state: "IDLE", datasetId: "demo-dataset-2026", generation: 12, pendingCount: 0,
  lastSyncAt: "2026-09-19T02:05:00.000Z", lastAttemptAt: "2026-09-19T02:05:00.000Z", nextSyncAt: "2026-09-19T02:35:00.000Z",
  errorCode: "", error: "", warning: "", intervalMinutes: 30, vault: { initialized: true, unlocked: true, datasetId: "demo-dataset-2026", keyEpoch: 1, vaultRevision: 4 },
};

function SyncIcon({ name }: { name: "cloud" | "github" | "refresh" | "shield" | "copy" | "external" | "user" }) {
  const paths = {
    cloud: <><path d="M7 18h10a4 4 0 0 0 .7-7.9A6 6 0 0 0 6.2 8.7 4.7 4.7 0 0 0 7 18Z" /><path d="m9 14 3-3 3 3M12 11v8" /></>,
    github: <><path d="M15 21v-3.9c0-1 .1-1.5-.5-2 2.7-.3 5.5-1.3 5.5-6A4.7 4.7 0 0 0 18.8 6 4.4 4.4 0 0 0 18.7 3S17.7 2.7 15 4a11 11 0 0 0-6 0C6.3 2.7 5.3 3 5.3 3A4.4 4.4 0 0 0 5.2 6 4.7 4.7 0 0 0 4 9.2c0 4.6 2.8 5.6 5.5 5.9-.4.4-.6.9-.6 1.8V21" /><path d="M9 19c-2.5.8-4-1-4-1.8" /></>,
    refresh: <><path d="M20 11a8 8 0 0 0-14.7-4L3 10M3 5v5h5M4 13a8 8 0 0 0 14.7 4L21 14M21 19v-5h-5" /></>,
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

export function CloudSyncCard({ language, requestConfirmation, demo = false }: { language: Language; requestConfirmation: ConfirmRequest; demo?: boolean }) {
  const tr = useCallback((zh: string, en: string) => language === "zh" ? zh : en, [language]);
  const [status, setStatus] = useState<CloudSyncStatus>(emptyStatus);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [conflictCredential, setConflictCredential] = useState("");
  const [vaultCredential, setVaultCredential] = useState("");
  const [syncUpstream, setSyncUpstream] = useState(false);

  useEffect(() => {
    if (demo) {
      setStatus(demoStatus);
      setLoading(false);
      return;
    }
    let active = true;
    void window.desktop?.getSyncStatus?.().then((value) => { if (active) setStatus(value); }).catch((reason) => { if (active) setError(String(reason?.message || reason)); }).finally(() => { if (active) setLoading(false); });
    const remove = window.desktop?.onSyncStatus?.((value) => { if (active) setStatus(value); });
    return () => { active = false; remove?.(); };
  }, [demo]);

  const stateLabel = useMemo(() => ({
    DISABLED: tr("自动同步已关闭", "Automatic sync off"), IDLE: tr("云端与本机已同步", "Cloud and local are synced"), DIRTY: tr("有数据等待同步", "Changes waiting to sync"),
    SYNCING: tr("正在安全同步", "Secure sync in progress"), PENDING_NETWORK: tr("网络恢复后重试", "Waiting for network"), AUTH_REQUIRED: tr("需要重新连接 GitHub", "GitHub reconnection required"),
    CONFLICT: tr("需要处理同步冲突", "Sync conflict needs attention"), ERROR_RECOVERABLE: tr("同步失败，可重试", "Sync failed; retry available"), ERROR_FATAL: tr("同步已保护性停止", "Sync stopped for safety"),
  }[status.state] || status.state), [status.state, tr]);

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

  const resolveConflict = async (choice: "local" | "remote") => {
    if (!window.desktop?.resolveSyncConflict) return setError(tr("当前版本无法处理同步冲突", "This build cannot resolve sync conflicts"));
    const confirmed = await requestConfirmation({
      title: choice === "local" ? tr("使用本机配置？", "Use this PC's configuration?") : tr("使用云端配置？", "Use the cloud configuration?"),
      message: choice === "local"
        ? tr("本机线路和设置会成为新的云端版本；另一台设备下次同步时会看到这次变更。", "This PC's routes and settings will become the new cloud copy. Other devices will see the change on their next sync.")
        : tr("将先校验并解密云端备份，再替换本机线路地址和上游 Key。完整客户端 Key 不会从云端恢复，需要时请重新生成。", "The cloud backup is verified and decrypted before replacing local route URLs and upstream keys. Full client keys cannot be restored from cloud and may need regeneration."),
      confirmLabel: choice === "local" ? tr("使用本机", "Use this PC") : tr("使用云端", "Use cloud"),
      cancelLabel: tr("取消", "Cancel"), tone: "warning", icon: "shield",
    });
    if (!confirmed) return;
    setBusy(true); setError("");
    try {
      if (demo) {
        await new Promise((resolve) => window.setTimeout(resolve, 360));
        setStatus((current) => ({ ...current, state: "IDLE", vault: { ...current.vault, initialized: true, unlocked: true } }));
        setConflictCredential("");
        return;
      }
      const credential = conflictCredential.trim();
      const isRecoveryCode = /^CGRC-/i.test(credential);
      const result = await window.desktop.resolveSyncConflict({
        choice,
        password: isRecoveryCode ? "" : credential,
        recoveryCode: isRecoveryCode ? credential : "",
      });
      setStatus(result.status);
      if (result.recoveryCode) setRecoveryCode(result.recoveryCode);
      setConflictCredential("");
    } catch (reason) { setError(String(reason instanceof Error ? reason.message : reason)); }
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
      setVaultCredential("");
      if (window.desktop?.syncNow) setStatus(await window.desktop.syncNow());
    } catch (reason) { setError(String(reason instanceof Error ? reason.message : reason)); }
    finally { setBusy(false); }
  };

  const copyRecovery = async () => {
    try { await navigator.clipboard.writeText(recoveryCode); }
    catch { setError(tr("复制失败，请手动选中恢复码", "Copy failed; select the recovery code manually")); }
  };

  return <article className="settings-card cloud-sync-card">
    <div className="cloud-sync-heading"><span className="settings-icon cloud-icon"><SyncIcon name="cloud" /></span><div><div className="cloud-title-line"><h3>{tr("GitHub 云同步", "GitHub cloud sync")}</h3>{status.connected && <span className={`sync-state-chip state-${status.state.toLowerCase()}`}><span />{stateLabel}</span>}</div><p>{tr("用一个私有仓库保存用量和可选的加密配置；每 30 分钟及开启、关闭、启动、退出等重要时刻自动同步。", "A private repository stores usage and optional encrypted configuration; sync runs every 30 minutes and at major lifecycle events.")}</p></div></div>
    {status.connected && <div className="sync-mode-summary"><span className="status-dot" /><strong>{status.syncUpstream ? tr("中转站 API 加密同步已开启", "Encrypted upstream API sync is on") : tr("中转站 API 默认不上传", "Upstream API sync is off by default")}</strong><small>{status.syncUpstream ? tr("用量和线路配置按分层规则同步。", "Usage and route configuration follow the layered sync rules.") : tr("当前只同步用量和基础元数据。", "Only usage and basic metadata sync now.")}</small></div>}

    {!status.connected ? <form className="github-connect-form" onSubmit={connect}>
      <div className="github-permission-note"><SyncIcon name="github" /><div><strong>{tr("用 GitHub 凭证连接", "Connect with a GitHub credential")}</strong><span>{tr("当前版本使用 GitHub 访问令牌完成账户连接。令牌由 Windows 安全存储加密，只发送给 GitHub API。需要私有仓库读写权限。", "This version connects with a GitHub access token. Windows protects it locally and it is sent only to the GitHub API. Private-repository read/write access is required.")}</span></div><button type="button" className="text-button" onClick={() => void window.desktop?.openExternal("https://github.com/settings/tokens/new?scopes=repo&description=Cherry%20AI%20Connect")}><SyncIcon name="external" />{tr("创建令牌", "Create token")}</button></div>
      <div className="sync-form-grid"><label><span>{tr("GitHub 访问令牌", "GitHub access token")}</span><input name="token" type="password" autoComplete="off" placeholder="github_pat_… / ghp_…" required /></label><label><span>{tr("私有仓库名称", "Private repository name")}</span><input name="repository" defaultValue="cherry-ai-connect-sync" pattern="[A-Za-z0-9._-]{1,100}" required /></label></div>
      <label className="sync-option"><input name="syncUpstream" type="checkbox" checked={syncUpstream} onChange={(event) => setSyncUpstream(event.target.checked)} /><span><strong>{tr("同步中转站 API（加密）", "Sync upstream APIs (encrypted)")}</strong><small>{tr("默认关闭；开启后才会要求备份加密密码。用量和基础元数据始终可独立同步。", "Off by default; enabling it requires a vault password. Usage and basic metadata can sync independently.")}</small></span></label>
      {syncUpstream && <div className="sync-form-grid"><label><span>{tr("备份加密密码", "Backup vault password")}</span><input name="password" type="password" minLength={8} autoComplete="new-password" required /></label><label><span>{tr("再次输入密码", "Confirm password")}</span><input name="confirmPassword" type="password" minLength={8} autoComplete="new-password" required /></label></div>}
      <div className="sync-security-line"><SyncIcon name="shield" /><span>{tr("不会上传聊天内容、完整客户端 Key、密码、恢复码或 GitHub 令牌。用量数据独立上传；中转站地址与上游 Key 只有开启后才加密上传。", "Prompts, full client keys, passwords, recovery codes, and GitHub tokens never upload. Usage syncs independently; routes and upstream keys are encrypted only when enabled.")}</span></div>
      {error && <div className="sync-error">{error}</div>}
      <div className="sync-actions"><button className="button button-primary" type="submit" disabled={busy || loading}><SyncIcon name="github" />{busy ? tr("正在连接并首次同步…", "Connecting and syncing…") : tr("连接 GitHub 并开启同步", "Connect GitHub and enable sync")}</button></div>
    </form> : <>
      <div className="sync-account-row"><div className="account-avatar">{status.account?.avatarUrl ? <img src={status.account.avatarUrl} alt="" /> : <SyncIcon name="user" />}</div><div><small>{tr("已连接账户", "Connected account")}</small><strong>@{status.account?.login}</strong></div><div><small>{tr("私有仓库", "Private repository")}</small><strong>{status.owner}/{status.repository}</strong></div><div><small>{tr("待同步", "Pending")}</small><strong>{status.pendingCount}</strong></div><button type="button" className="text-button" onClick={() => void window.desktop?.openExternal(`https://github.com/${status.owner}/${status.repository}/releases/tag/cherry-sync`)}><SyncIcon name="external" />{tr("查看私有备份", "View private backup")}</button></div>
      <div className="sync-metrics"><div><small>{tr("上次完成（UTC+8）", "Last completed (UTC+8)")}</small><strong>{displayTime(status.lastSyncAt, language)}</strong></div><div><small>{tr("下次同步（UTC+8）", "Next sync (UTC+8)")}</small><strong>{status.enabled ? displayTime(status.nextSyncAt, language) : tr("自动同步已关闭", "Automatic sync off")}</strong></div><div><small>{tr("备份版本（UTC+8）", "Backup version (UTC+8)")}</small><strong>{displayBackupVersion(status.lastSyncAt, status.generation, language)}</strong></div><div><small>Dataset ID</small><strong title={status.datasetId}>{status.datasetId ? `${status.datasetId.slice(0, 10)}…${status.datasetId.slice(-6)}` : "—"}</strong></div></div>
      {(error || (status.state !== "CONFLICT" && status.error)) && <div className="sync-error">{error || status.error}<small>{status.errorCode}</small></div>}
      {status.warning && <div className="sync-warning">{status.warning === "sync_disabled_with_pending_data" ? tr("自动同步已关闭，但仍有本地数据等待下次上传。", "Automatic sync is off, but local changes are still waiting to upload.") : status.warning === "sync_vault_unavailable_usage_only" ? tr("本次已同步用量数据；中转站地址和上游 API Key 等待解锁本机保险库后同步。", "Usage data synced; upstream routes and API keys will sync after the local vault is unlocked.") : status.warning}</div>}
      {status.vault.initialized && !status.vault.unlocked && <div className="sync-conflict-panel"><div><strong>{tr("本机同步保险库需要解锁", "Unlock the local sync vault")}</strong><p>{tr("用量仍可独立同步；解锁后才能继续同步中转站地址和上游 API Key。请输入原来的备份加密密码，或输入 CGRC 恢复码。", "Usage can sync independently; unlock the vault to sync upstream routes and API keys. Enter the original backup vault password or a CGRC recovery code.")}</p></div><label><span>{tr("备份加密密码或 CGRC 恢复码", "Vault password or CGRC recovery code")}</span><input type="password" value={vaultCredential} onChange={(event) => setVaultCredential(event.target.value)} autoComplete="off" /></label><div><button type="button" className="button button-primary" onClick={() => void unlockVault()} disabled={busy}>{tr("解锁并同步", "Unlock and sync")}</button></div></div>}
      {status.state === "CONFLICT" && <div className="sync-conflict-panel"><div><strong>{tr("检测到两份不同的线路配置", "Two different route configurations were found")}</strong><p>{tr("为保护上游 Key，程序已暂停配置上传。请选择保留本机还是恢复云端；使用量会继续按事件去重合并。", "Configuration upload is paused to protect upstream keys. Choose this PC or the cloud copy; usage events continue to merge safely.")}</p></div><label><span>{tr("加密密码或 CGRC 恢复码", "Vault password or CGRC recovery code")}</span><input type="password" value={conflictCredential} onChange={(event) => setConflictCredential(event.target.value)} autoComplete="off" /><small>{tr("恢复云端时输入云端密码或恢复码；首次保留本机时请输入至少 8 位的新密码。", "For cloud restore, enter the cloud password or recovery code. To keep an unprotected local copy for the first time, enter a new password of at least 8 characters.")}</small></label><div><button type="button" className="button button-secondary" onClick={() => void resolveConflict("local")} disabled={busy}>{tr("保留本机配置", "Keep this PC")}</button><button type="button" className="button button-primary" onClick={() => void resolveConflict("remote")} disabled={busy}>{tr("恢复云端配置", "Restore cloud copy")}</button></div></div>}
      <div className="sync-actions"><button type="button" className="button button-secondary" onClick={() => void toggle()} disabled={busy}><SyncIcon name="cloud" />{status.enabled ? tr("关闭自动同步", "Turn off automatic sync") : tr("开启自动同步", "Turn on automatic sync")}</button><button type="button" className="button button-primary" onClick={() => void syncNow()} disabled={busy || status.state === "SYNCING"}><SyncIcon name="refresh" />{status.state === "SYNCING" ? tr("同步中…", "Syncing…") : tr("立即同步", "Sync now")}</button><button type="button" className="button button-ghost sync-disconnect" onClick={() => void disconnect()} disabled={busy}>{tr("断开账户", "Disconnect account")}</button></div>
    </>}

    {recoveryCode && <div className="recovery-panel"><div><strong>{tr("恢复码只显示这一次", "Recovery code — shown once")}</strong><p>{tr("保存到安全位置。换电脑或忘记加密密码时需要它；我们不会替你找回。", "Store it safely. It is required after moving PCs or losing the vault password; it cannot be recovered for you.")}</p></div><code>{recoveryCode}</code><button type="button" className="button button-secondary" onClick={() => void copyRecovery()}><SyncIcon name="copy" />{tr("复制恢复码", "Copy recovery code")}</button><button type="button" className="text-button" onClick={() => setRecoveryCode("")}>{tr("我已安全保存", "I stored it safely")}</button></div>}
  </article>;
}
