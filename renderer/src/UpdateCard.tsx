/**
 * 中文：设置页的一键更新卡片。下载前展示来源和大小，主进程负责校验、同步、备份和安装。
 * English: One-click updater card. It presents the source and size while the main process owns
 * verification, pre-update sync, offline backup, and installer launch.
 */
import { useEffect, useMemo, useState } from "react";
import { Icon } from "./ui/Icon";

type Language = "zh" | "en";

function megabytes(value: number) {
  return value ? `${(value / 1024 / 1024).toFixed(1)} MB` : "—";
}

function readableUpdateError(reason: unknown, language: Language) {
  const raw = reason instanceof Error ? reason.message : String(reason || "");
  const tr = (zh: string, en: string) => language === "zh" ? zh : en;
  const messages: Array<[string, string, string]> = [
    ["update_checksum_missing", "安装包没有可信的 SHA-256 校验值，已停止更新。", "The installer has no trusted SHA-256 value; the update was stopped."],
    ["update_checksum_mismatch", "安装包校验失败，文件已删除，未运行安装器。", "Installer verification failed. The file was removed and not launched."],
    ["update_source_data_incomplete", "本地数据尚未准备完整，已停止更新以免丢失数据。", "Local data is incomplete, so the update stopped to prevent data loss."],
    ["update_installer_missing", "新版 Release 中没有找到 Windows 安装包。", "No Windows installer was found in the new Release."],
    ["update_github_network_timeout", "连接 GitHub 更新服务超时；这与上游 API Key 无关。请检查网络或代理后重试。", "The GitHub update service timed out; this is unrelated to an upstream API key. Check the network or proxy and retry."],
    ["update_github_network_unavailable", "暂时无法连接 GitHub 更新服务；这与上游 API Key 无关。请检查网络后重试。", "The GitHub update service is temporarily unavailable; this is unrelated to an upstream API key. Check the network and retry."],
    ["sync_", "更新前云同步未完成；当前版本和本地数据保持不变。", "Pre-update cloud sync did not complete; the current version and local data remain unchanged."],
  ];
  const match = messages.find(([code]) => raw.includes(code));
  if (!match && /(ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|EAI_AGAIN|GitHub request timed out|connect timed out)/i.test(raw)) {
    return tr("连接 GitHub 更新服务超时或暂时不可用；这与上游 API Key 无关。请检查网络或代理后重试。", "The GitHub update service timed out or is temporarily unavailable; this is unrelated to an upstream API key. Check the network or proxy and retry.");
  }
  return match ? tr(match[1], match[2]) : raw;
}

export function UpdateCard({ language, currentVersion }: { language: Language; currentVersion: string }) {
  const tr = (zh: string, en: string) => language === "zh" ? zh : en;
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [error, setError] = useState("");

  useEffect(() => window.desktop?.onUpdateProgress?.((next) => {
    setProgress(next);
    if (next.stage === "error") {
      setInstalling(false);
      setError(next.error || tr("更新失败", "Update failed"));
    }
  }), [language]);

  const check = async () => {
    if (!window.desktop?.checkForUpdates) return setError(tr("当前环境不支持检查更新", "Update checks are unavailable in this environment"));
    setChecking(true);
    setError("");
    try { setResult(await window.desktop.checkForUpdates()); }
    catch (reason) { setError(readableUpdateError(reason, language)); }
    finally { setChecking(false); }
  };

  const install = async () => {
    if (!window.desktop?.downloadAndInstallUpdate || installing) return;
    setInstalling(true);
    setError("");
    try {
      const next = await window.desktop.downloadAndInstallUpdate();
      if (!next.updateAvailable) await check();
    } catch (reason) {
      setInstalling(false);
      setError(readableUpdateError(reason, language));
    }
  };

  const stageText = useMemo(() => ({
    checking: tr("正在检查版本", "Checking version"),
    downloading: tr(`正在下载安装包 ${progress?.percent || 0}%`, `Downloading installer ${progress?.percent || 0}%`),
    syncing: tr("正在完成更新前同步", "Completing pre-update sync"),
    "backing-up": tr("正在备份本地数据和客户端 Key", "Backing up local data and client keys"),
    installing: tr("安装器已启动，软件即将重新打开", "Installer launched; the app will reopen"),
    error: tr("更新未完成", "Update did not finish"),
  }[progress?.stage || "checking"]), [language, progress]);

  const state = installing ? "installing" : checking ? "checking" : error ? "error" : result?.updateAvailable ? "available" : result ? "current" : "idle";
  const stateText = {
    installing: stageText,
    checking: tr("正在连接 GitHub…", "Contacting GitHub…"),
    error: tr("需要处理", "Needs attention"),
    available: tr("发现新版本", "Update available"),
    current: tr("已是最新版", "Up to date"),
    idle: tr("尚未检查", "Not checked"),
  }[state];
  const canInstall = Boolean(result?.updateAvailable && result.asset?.url && result.asset?.sha256);

  return <article className="settings-card update-card">
    <div className="update-card-header">
      <div className="settings-heading"><span className="settings-icon update-icon"><Icon name="shield" size={17} /></span><div><h3>{tr("安全更新", "Safe updates")}</h3><p>{tr("一键下载、校验、同步并备份数据，再安装新版本；不要求填写上游 API Key。", "Download, verify, sync, back up, and install in one flow; an upstream API key is not required.")}</p></div></div>
      <span className={`update-state ${state}`}><i />{stateText}</span>
    </div>
    <div className="update-version-grid">
      <div><small>{tr("当前版本", "Current")}</small><strong>v{currentVersion}</strong></div>
      <div><small>{tr("最新版本", "Latest")}</small><strong className={result?.updateAvailable ? "has-update" : result ? "is-current" : ""}>{result ? `v${result.latestVersion || currentVersion}` : "—"}</strong></div>
      <div><small>{tr("安装包", "Installer")}</small><strong>{result?.asset ? megabytes(result.asset.size) : "—"}</strong></div>
      <div><small>{tr("数据保护", "Data protection")}</small><strong className="update-protected">{tr("同步 + 本地备份", "Sync + local backup")}</strong></div>
    </div>
    {installing && <div className="update-progress" role="status"><div><strong>{stageText}</strong><span>{progress?.stage === "downloading" ? `${megabytes(progress.received || 0)} / ${megabytes(progress.total || result?.asset?.size || 0)}` : tr("请不要关闭软件", "Keep the app open")}</span></div><div className="update-progress-track"><span style={{ width: `${progress?.stage === "downloading" ? progress.percent : progress?.stage === "checking" ? 8 : 100}%` }} /></div></div>}
    {error && <div className="update-error"><strong>{tr("更新已安全停止", "Update stopped safely")}</strong><span>{error}</span><small>{tr("当前版本和本地数据未被覆盖，可以修复网络或同步问题后重试。", "The current version and local data remain untouched; fix the network or sync issue and retry.")}</small></div>}
    {result?.updateAvailable && !canInstall && <div className="update-error"><strong>{tr("安装包缺少可信校验值", "Installer checksum unavailable")}</strong><span>{tr("为了保护本地数据，软件不会自动运行未经校验的安装包。", "For safety, the app will not run an unverified installer.")}</span></div>}
    <div className="update-actions">
      <button type="button" className="button button-secondary" onClick={() => void check()} disabled={checking || installing}>{checking ? tr("检查中…", "Checking…") : result ? tr("重新检查", "Check again") : tr("检查更新", "Check now")}</button>
      {result?.updateAvailable && <button type="button" className="button button-primary update-install-button" onClick={() => void install()} disabled={!canInstall || installing}>{installing ? stageText : tr("下载并更新", "Download and update")}</button>}
    </div>
    <div className="update-footnote">{tr("更新不会刷新同一设备上的客户端 API Key；只有新设备首次同步才会生成新 Key。", "Updates never rotate client API keys on this device; only a new device creates keys on first sync.")}</div>
    <div className="update-footnote update-local-mode-note">{tr("上游 API Key 可以留空；本地配置、界面和安全更新不依赖它。只有调用上游线路时才需要填写。", "An upstream API key may remain empty; local configuration, the interface, and safe updates do not depend on it. It is only needed when calling an upstream route.")}</div>
  </article>;
}
