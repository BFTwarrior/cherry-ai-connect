/** 中文：设置页的手动更新检查，不会静默下载或安装。 English: Manual update check; it never downloads or installs silently. */
import { useState } from "react";

type Language = "zh" | "en";

export function UpdateCard({ language, currentVersion }: { language: Language; currentVersion: string }) {
  const tr = (zh: string, en: string) => language === "zh" ? zh : en;
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  const [error, setError] = useState("");

  const check = async () => {
    if (!window.desktop?.checkForUpdates) return setError(tr("当前环境不支持检查更新", "Update checks are unavailable in this environment"));
    setChecking(true);
    setError("");
    try { setResult(await window.desktop.checkForUpdates()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setChecking(false); }
  };

  const state = checking ? "checking" : error ? "error" : result?.updateAvailable ? "available" : result ? "current" : "idle";
  const stateText = {
    checking: tr("正在连接 GitHub…", "Contacting GitHub…"),
    error: tr("检查失败", "Check failed"),
    available: tr("发现新版本", "Update available"),
    current: tr("已是最新版", "Up to date"),
    idle: tr("等待手动检查", "Ready to check"),
  }[state];
  const formatTime = (value: string) => new Date(value).toLocaleString(language === "zh" ? "zh-CN" : "en-US", { hour12: false });

  return <article className="settings-card update-card">
    <div className="update-card-header">
      <div className="settings-heading"><span className="settings-icon update-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 5-5m-5 5-5-5M5 20h14" /></svg></span><div><h3>{tr("检查更新", "Check for updates")}</h3><p>{tr("只检查 GitHub 官方 Release；不会自动下载或安装。", "Checks the official GitHub Release only; nothing downloads or installs automatically.")}</p></div></div>
      <span className={`update-state ${state}`}><i />{stateText}</span>
    </div>
    <div className="update-version-grid">
      <div><small>{tr("当前版本", "Current version")}</small><strong>v{currentVersion}</strong></div>
      <div><small>{tr("GitHub 最新版本", "Latest on GitHub")}</small><strong className={result?.updateAvailable ? "has-update" : result ? "is-current" : ""}>{result ? `v${result.latestVersion || currentVersion}` : "—"}</strong></div>
      <div><small>{tr("上次检查", "Last checked")}</small><strong>{result?.checkedAt ? formatTime(result.checkedAt) : tr("尚未检查", "Not checked")}</strong></div>
      <div><small>{tr("发布时间", "Published")}</small><strong>{result?.publishedAt ? formatTime(result.publishedAt) : "—"}</strong></div>
    </div>
    {error && <div className="update-error"><strong>{tr("无法完成检查", "Could not check")}</strong><span>{error}</span><small>{tr("请确认网络可访问 GitHub，稍后可再次点击检查。", "Confirm GitHub is reachable, then try again.")}</small></div>}
    <div className="update-actions"><button type="button" className="button button-secondary" onClick={() => void check()} disabled={checking}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.7-4L3 10M3 5v5h5M4 13a8 8 0 0 0 14.7 4L21 14M21 19v-5h-5" /></svg>{checking ? tr("检查中…", "Checking…") : result ? tr("重新检查", "Check again") : tr("立即检查", "Check now")}</button>{result?.updateAvailable && <button type="button" className="button button-primary" onClick={() => void window.desktop?.openExternal(result.releaseUrl)}>{tr("打开官方下载页", "Open official download")}</button>}</div>
  </article>;
}
