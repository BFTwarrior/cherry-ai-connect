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

  return <article className="settings-card update-card">
    <div className="settings-heading"><span className="settings-icon update-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 5-5m-5 5-5-5M5 20h14" /></svg></span><div><h3>{tr("检查更新", "Check for updates")}</h3><p>{tr("从 GitHub 官方发布页检查新版本，不会自动下载或安装。", "Check the official GitHub release page. Nothing is downloaded or installed automatically.")}</p></div></div>
    <div className="update-version-row"><div><small>{tr("当前版本", "Current version")}</small><strong>v{currentVersion}</strong></div>{result && <div><small>{tr("最新版本", "Latest version")}</small><strong className={result.updateAvailable ? "has-update" : "is-current"}>v{result.latestVersion || currentVersion}</strong></div>}<span className={`update-state ${result?.updateAvailable ? "available" : result ? "current" : "idle"}`}>{result?.updateAvailable ? tr("发现新版本", "Update available") : result ? tr("已是最新版", "Up to date") : tr("尚未检查", "Not checked")}</span></div>
    {error && <div className="update-error">{error}</div>}
    {result?.checkedAt && <div className="update-checked">{tr("检查时间", "Checked")}: {new Date(result.checkedAt).toLocaleString(language === "zh" ? "zh-CN" : "en-US")}</div>}
    <div className="update-actions"><button type="button" className="button button-secondary" onClick={() => void check()} disabled={checking}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.7-4L3 10M3 5v5h5M4 13a8 8 0 0 0 14.7 4L21 14M21 19v-5h-5" /></svg>{checking ? tr("检查中…", "Checking…") : tr("立即检查", "Check now")}</button>{result?.updateAvailable && <button type="button" className="button button-primary" onClick={() => void window.desktop?.openExternal(result.releaseUrl)}>{tr("打开下载页面", "Open download page")}</button>}</div>
  </article>;
}
