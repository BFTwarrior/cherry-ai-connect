/**
 * 中文：React 渲染层负责页面状态、双语界面、线路/模型/客户端 Key 管理。
 * English: The React renderer owns page state, bilingual UI, and route/model/client-key management.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { UsageView } from "./UsageView";
import { UpdateCard } from "./UpdateCard";
import { CloudSyncCard } from "./CloudSyncCard";
import { ClientKeyForm } from "./ClientKeyForm";
import type { ClientKey, ClientRequestStatus, ConfirmDialogOptions, ConfirmDialogState, DesktopSettings, GatewaySettings, GatewayStatus, Language, ModalState, Provider, ReasoningLevel, SyncProgress, ToastState, ToastTone, View } from "./app-types";
import { Icon } from "./ui/Icon";
import { MenuSelect } from "./ui/MenuSelect";

const DEFAULT_GATEWAY_ORIGIN = "http://127.0.0.1:27891";
const DEFAULT_GATEWAY_API_BASE = `${DEFAULT_GATEWAY_ORIGIN}/v1`;
let activeGatewayOrigin = DEFAULT_GATEWAY_ORIGIN;
const VERSION = "1.35";
const DEMO_MODE = new URLSearchParams(window.location.search).get("demo") === "1";

const DEMO_PROVIDERS: Provider[] = [
  { id: "DEMO-NORTH", name: "北境中转（演示）", baseUrl: "https://demo.example.invalid/north", models: Array.from({ length: 24 }, (_, index) => `demo-north-${index + 1}`), modelCount: 24, enabled: true, hasApiKey: true, modelFetchedAt: "2026-09-19T02:00:00.000Z", lastTestAt: "2026-09-19T02:00:00.000Z", lastTestStatus: "ok", lastLatencyMs: 86, clientKeyCount: 3 },
  { id: "DEMO-AURORA", name: "极光线路（演示）", baseUrl: "https://demo.example.invalid/aurora", models: Array.from({ length: 18 }, (_, index) => `demo-aurora-${index + 1}`), modelCount: 18, enabled: true, hasApiKey: true, modelFetchedAt: "2026-09-19T02:00:00.000Z", lastTestAt: "2026-09-19T02:00:00.000Z", lastTestStatus: "ok", lastLatencyMs: 112, clientKeyCount: 2 },
  { id: "DEMO-LOAD", name: "本地压测线（演示）", baseUrl: "http://127.0.0.1:20000/demo", models: Array.from({ length: 9 }, (_, index) => `demo-load-${index + 1}`), modelCount: 9, enabled: true, hasApiKey: true, modelFetchedAt: "2026-09-19T02:00:00.000Z", lastTestAt: "2026-09-19T02:00:00.000Z", lastTestStatus: "ok", lastLatencyMs: 7, clientKeyCount: 3 },
];

const DEMO_KEYS: ClientKey[] = Array.from({ length: 8 }, (_, index) => {
  const provider = DEMO_PROVIDERS[index % DEMO_PROVIDERS.length];
  return { id: `demo-key-${index + 1}`, name: `演示客户端 ${index + 1}`, nameCustomized: true, providerId: provider.id, providerName: provider.name, reasoningLevel: "unchanged", createdAt: "2026-09-19 10:00:00", enabled: true, hasSecret: true };
});


const levels: ReasoningLevel[] = ["unchanged", "low", "medium", "high", "xhigh", "max"];

function useCopy() {
  return useCallback(async (text: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
      }
    } catch { /* fall back to the legacy Windows clipboard path below */ }
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "true");
    area.style.position = "fixed";
    area.style.left = "-9999px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    if (!copied) throw new Error("clipboard_unavailable");
  }, []);
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${activeGatewayOrigin}${path}`, options);
  } catch {
    throw new Error("无法连接本地网关，请确认程序仍在运行。 / Cannot connect to the local gateway.");
  }
  const raw = await response.text();
  let data: unknown = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
  if (!response.ok) {
    const message = typeof data === "object" && data && "error" in data ? String((data as { error: unknown }).error) : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return data as T;
}

function formatDate(value: string | undefined, language: Language) {
  if (!value) return language === "zh" ? "尚未同步" : "Not synced";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return date.toLocaleString(language === "zh" ? "zh-CN" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function errorSummary(value: string | undefined) {
  const clean = String(value || "").replace(/\s+/g, " ").trim();
  return clean.length > 150 ? `${clean.slice(0, 147)}…` : clean;
}

function levelLabel(level: ReasoningLevel | undefined) {
  return String(level || "unchanged").toUpperCase();
}

function reasoningOptionLabel(level: ReasoningLevel | undefined, language: Language) {
  return String(level || "unchanged").toUpperCase();
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : name.slice(0, 2)).toUpperCase() || "CG";
}

// Keep these component identities stable across App state changes. Otherwise opening a menu
// remounts whole sections and restarts every border and particle animation on the page.
function Metric({ icon, tone, value, label, note }: { icon: string; tone: string; value: string; label: string; note: string }) { return <div className="metric-card"><span className={`metric-icon ${tone}`}><Icon name={icon} size={17} /></span><span><small>{label}</small><strong>{value}</strong><em>{note}</em></span><span className="metric-sparks" aria-hidden="true">{Array.from({ length: 10 }, (_, index) => <i key={index} />)}</span></div>; }
function PanelHeading({ kicker, title, description, action }: { kicker: string; title: string; description?: string; action?: ReactNode }) { return <div className="panel-heading"><div><div className="section-kicker">{kicker}</div><h3>{title}</h3>{description && <p>{description}</p>}</div>{action}</div>; }
function PageIntro({ kicker, description, action }: { kicker: string; description: string; action: ReactNode }) { return <div className="page-intro"><div><div className="section-kicker">{kicker}</div><p>{description}</p></div><div className="page-intro-action">{action}</div></div>; }
function SettingsHeading({ icon, title, description }: { icon: string; title: string; description: string }) { return <div className="settings-heading"><span className="settings-icon"><Icon name={icon} size={17} /></span><div><h3>{title}</h3><p>{description}</p></div></div>; }
function SettingCheck({ name, checked, onChange, title, description }: { name: string; checked: boolean; onChange: (checked: boolean) => void; title: string; description: string }) { return <label className="setting-check"><input type="checkbox" name={name} checked={checked} onChange={(event) => onChange(event.target.checked)} /><span><strong>{title}</strong><small>{description}</small></span></label>; }
function NavItem({ icon, label, active, onClick }: { icon: string; label: string; active: boolean; onClick: () => void }) { return <button className={`nav-item ${active ? "active" : ""}`} onClick={onClick}><span className="nav-icon"><Icon name={icon} size={16} /></span><span>{label}</span><span className="nav-fireflies" aria-hidden="true">{Array.from({ length: 8 }, (_, index) => <i key={index} />)}</span></button>; }
function Field({ label, name, defaultValue, placeholder, type = "text", readOnly = false, required = false }: { label: string; name: string; defaultValue?: string; placeholder?: string; type?: string; readOnly?: boolean; required?: boolean }) { return <label className="field-label">{label}<input className="field-control" name={name} type={type} defaultValue={defaultValue} placeholder={placeholder} readOnly={readOnly} required={required} /></label>; }
function EmptyState({ icon, title, description, action }: { icon: string; title: string; description: string; action?: ReactNode }) { return <div className="empty-state"><span className="empty-icon"><Icon name={icon} size={21} /></span><strong>{title}</strong><p>{description}</p>{action}</div>; }

export default function App() {
  const [language, setLanguage] = useState<Language>(() => (localStorage.getItem("cherry-language") as Language) || "zh");
  const [languageMenuOpen, setLanguageMenuOpen] = useState(false);
  const [reasoningMenuOpen, setReasoningMenuOpen] = useState(false);
  const [view, setView] = useState<View>("overview");
  const [settingsVisit, setSettingsVisit] = useState(0);
  const [providers, setProviders] = useState<Provider[]>(DEMO_MODE ? DEMO_PROVIDERS : []);
  const [keys, setKeys] = useState<ClientKey[]>(DEMO_MODE ? DEMO_KEYS : []);
  const [settings, setSettings] = useState<GatewaySettings>({ forcedLevel: "unchanged", defaultProvider: "" });
  const [settingsDraftLevel, setSettingsDraftLevel] = useState<ReasoningLevel>("unchanged");
  const [desktop, setDesktop] = useState<DesktopSettings>({ language: "zh", autoLaunch: false, startMinimized: false, closeToTray: true });
  const [gatewayPort, setGatewayPort] = useState(DEMO_MODE ? 27891 : 20000);
  const [apiBase, setApiBase] = useState(DEFAULT_GATEWAY_API_BASE);
  const [modal, setModal] = useState<ModalState>(null);
  const [toast, setToast] = useState<ToastState>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>(null);
  const [loading, setLoading] = useState(false);
  const [gatewayResetting, setGatewayResetting] = useState(false);
  const [reasoningUpdating, setReasoningUpdating] = useState(false);
  const [lastClientRequestAt, setLastClientRequestAt] = useState("");
  const [lastClientRequestStatus, setLastClientRequestStatus] = useState<ClientRequestStatus>("never");
  const [lastClientRequestModel, setLastClientRequestModel] = useState("");
  const [secretCopied, setSecretCopied] = useState(false);
  const [copyingKeyId, setCopyingKeyId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState<string | "all" | null>(null);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [syncFailures, setSyncFailures] = useState<string[]>([]);
  const [testingKeyId, setTestingKeyId] = useState<string | null>(null);
  const [modelFilter, setModelFilter] = useState("all");
  const [modelQuery, setModelQuery] = useState("");
  // 中文：模型分组的折叠状态属于纯界面偏好，保存在本机，不参与云同步。
  // English: Model-group collapse state is a local UI preference and never enters cloud sync.
  const [collapsedModelGroups, setCollapsedModelGroups] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem("cherry-collapsed-model-groups") || "[]")); }
    catch { return new Set(); }
  });
  const confirmResolverRef = useRef<((confirmed: boolean) => void) | null>(null);
  const copy = useCopy();

  const tr = useCallback((zh: string, en: string) => language === "zh" ? zh : en, [language]);
  const showToast = useCallback((message: string, tone: ToastTone = "info") => {
    setToast({ message, tone });
  }, []);

  const requestConfirmation = useCallback((options: ConfirmDialogOptions) => new Promise<boolean>((resolve) => {
    confirmResolverRef.current?.(false);
    confirmResolverRef.current = resolve;
    setConfirmDialog(options);
  }), []);

  const resolveConfirmation = useCallback((confirmed: boolean) => {
    const resolver = confirmResolverRef.current;
    confirmResolverRef.current = null;
    setConfirmDialog(null);
    resolver?.(confirmed);
  }, []);

  const applyGatewayInfo = useCallback((info: GatewayInfo | null | undefined) => {
    if (!info?.origin || !info.apiBase) return;
    activeGatewayOrigin = info.origin;
    setGatewayPort(Number(info.port) || 27891);
    setApiBase(info.apiBase);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!confirmDialog) return;
    const handleConfirmKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        resolveConfirmation(false);
      } else if (event.key === "Enter") {
        event.preventDefault();
        resolveConfirmation(true);
      }
    };
    window.addEventListener("keydown", handleConfirmKey);
    return () => window.removeEventListener("keydown", handleConfirmKey);
  }, [confirmDialog, resolveConfirmation]);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      // 中文：网页演示必须完全脱离桌面桥和本地网关，所有页面都只读内存中的假数据。
      // English: The web demo must stay completely detached from the desktop bridge and local gateway;
      // every page reads in-memory fixture data only.
      if (DEMO_MODE) {
        setProviders(DEMO_PROVIDERS);
        setKeys(DEMO_KEYS);
        setSettings({ forcedLevel: "unchanged", defaultProvider: DEMO_PROVIDERS[0].id, reasoningLevels: levels });
        setSettingsDraftLevel("unchanged");
        setGatewayPort(27891);
        setApiBase("http://127.0.0.1:27891/v1");
        setLastClientRequestAt("2026-09-19T02:05:00.000Z");
        setLastClientRequestStatus("ok");
        setLastClientRequestModel("client-key-test");
        return;
      }
      if (window.desktop?.getGatewayInfo) applyGatewayInfo(await window.desktop.getGatewayInfo());
      const [providerData, keyData, settingsData, statusData, desktopData] = await Promise.all([
        request<{ providers: Provider[] }>("/admin/api/providers"),
        request<{ keys: ClientKey[] }>("/admin/api/client-keys"),
        request<GatewaySettings>("/admin/api/settings"),
        request<GatewayStatus>("/admin/api/status"),
        window.desktop?.getSettings?.() ?? Promise.resolve(null),
      ]);
      setProviders(providerData.providers || []);
      setKeys(keyData.keys || []);
      const nextForcedLevel = settingsData.forcedLevel || "unchanged";
      setSettings({ forcedLevel: nextForcedLevel, defaultProvider: settingsData.defaultProvider || "", reasoningLevels: settingsData.reasoningLevels });
      setSettingsDraftLevel(nextForcedLevel);
      setLastClientRequestAt(statusData.lastClientRequestAt || "");
      setLastClientRequestStatus(statusData.lastClientRequestStatus || "never");
      setLastClientRequestModel(statusData.lastClientRequestModel || "");
      if (desktopData) {
        setDesktop((current) => ({ ...current, ...desktopData }));
        if (!localStorage.getItem("cherry-language") && desktopData.language) setLanguage(desktopData.language);
      }
    } catch (error) {
      if (!silent) showToast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      if (!silent) setLoading(false);
    }
  }, [applyGatewayInfo, showToast]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    // 中文：首次同步会在主进程中恢复网关配置；同步通知到达后必须重新读取线路、模型和客户端 Key。
    // English: The main process restores gateway config during the first sync; reload routes, models,
    // and client keys when the sync notification reaches the renderer.
    const remove = window.desktop?.onSyncStatus?.((status) => {
      if (["IDLE", "CONFLICT", "ERROR_RECOVERABLE", "ERROR_FATAL"].includes(status.state)) void load(true);
    });
    return () => remove?.();
  }, [load]);
  useEffect(() => {
    if (DEMO_MODE) return;
    let cancelled = false;
    const refreshClientStatus = async () => {
      try {
        const status = await request<GatewayStatus>("/admin/api/status");
        if (cancelled) return;
        setLastClientRequestAt(status.lastClientRequestAt || "");
        setLastClientRequestStatus(status.lastClientRequestStatus || "never");
        setLastClientRequestModel(status.lastClientRequestModel || "");
      } catch { /* the main load flow presents gateway connection errors */ }
    };
    const timer = window.setInterval(() => { void refreshClientStatus(); }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (modal?.kind !== "key-result") setSecretCopied(false);
  }, [modal]);

  useEffect(() => {
    if (!reasoningMenuOpen) return;
    const closeReasoningMenu = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".reasoning-control")) return;
      setReasoningMenuOpen(false);
    };
    document.addEventListener("mousedown", closeReasoningMenu);
    return () => document.removeEventListener("mousedown", closeReasoningMenu);
  }, [reasoningMenuOpen]);


  const providerById = useCallback((id: string) => providers.find((provider) => provider.id === id), [providers]);
  const totalModels = useMemo(() => providers.reduce((sum, provider) => sum + (provider.modelCount ?? provider.models.length), 0), [providers]);
  const activeKeys = useMemo(() => keys.filter((key) => key.enabled).length, [keys]);

  const navigate = (nextView: View) => {
    if (nextView === "settings") setSettingsVisit((visit) => visit + 1);
    setView(nextView);
    document.querySelector(".main-scroll")?.scrollTo({ top: 0, behavior: "smooth" });
  };

  const toggleModelGroup = (providerId: string) => {
    setCollapsedModelGroups((current) => {
      const next = new Set(current);
      if (next.has(providerId)) next.delete(providerId); else next.add(providerId);
      localStorage.setItem("cherry-collapsed-model-groups", JSON.stringify([...next]));
      return next;
    });
  };

  const changeDefaultReasoning = async (next: ReasoningLevel) => {
    const previous = settings.forcedLevel;
    if (next === previous || reasoningUpdating) return;
    setSettings((current) => ({ ...current, forcedLevel: next }));
    setSettingsDraftLevel(next);
    setReasoningUpdating(true);
    try {
      if (DEMO_MODE) {
        await new Promise((resolve) => window.setTimeout(resolve, 260));
        showToast(tr(`演示模式：默认思考强度已设为 ${reasoningOptionLabel(next, "zh")}`, `Demo: default reasoning is now ${reasoningOptionLabel(next, "en")}`), "success");
        return;
      }
      const result = await request<GatewaySettings>("/admin/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ forcedLevel: next, applyToExisting: false }) });
      const savedLevel = result.forcedLevel || next;
      setSettings((current) => ({ ...current, ...result, forcedLevel: savedLevel }));
      setSettingsDraftLevel(savedLevel);
      showToast(tr(`默认思考强度已设为 ${reasoningOptionLabel(savedLevel, "zh")}；已有客户端 Key 保持独立设置`, `Default reasoning is now ${reasoningOptionLabel(savedLevel, "en")}; existing client keys keep their own levels`), "success");
    } catch (error) {
      setSettings((current) => ({ ...current, forcedLevel: previous }));
      setSettingsDraftLevel(previous);
      showToast(`${tr("思考强度更新失败", "Could not update reasoning level")}：${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      setReasoningUpdating(false);
    }
  };

  const changeLanguage = async (next: Language) => {
    setLanguageMenuOpen(false);
    setLanguage(next);
    localStorage.setItem("cherry-language", next);
    try {
      const nextDesktop = await window.desktop?.setSettings?.({ language: next });
      if (nextDesktop) setDesktop((current) => ({ ...current, ...nextDesktop }));
      showToast(next === "zh" ? "已切换为简体中文" : "Switched to English", "success");
    } catch {
      showToast(next === "zh" ? "界面已切换" : "Interface switched", "success");
    }
  };

  const handleResetGateway = async () => {
    if (loading || gatewayResetting) return;
    const confirmed = await requestConfirmation({
      title: tr("重置连接服务", "Reset connection service"),
      message: tr("旧的本地 API 地址会失效，连接服务将切换到一个随机端口；线路、模型和客户端 Key 会保留。", "The old local API address will stop working and the connection service will switch to a random port. Routes, models, and client keys will be kept."),
      confirmLabel: tr("重置并随机端口", "Reset and randomize"),
      cancelLabel: tr("取消", "Cancel"),
      tone: "warning",
      icon: "refresh",
    });
    if (!confirmed) return;
    setGatewayResetting(true);
    try {
      if (DEMO_MODE) {
        await new Promise((resolve) => window.setTimeout(resolve, 450));
        setGatewayPort(27891);
        setApiBase("http://127.0.0.1:27891/v1");
        showToast(tr("演示模式：已模拟重置连接服务，不会修改本机设置", "Demo: connection service reset simulated; local settings were not changed"), "success");
        return;
      }
      if (!window.desktop?.resetGateway) throw new Error(tr("当前环境不支持重置连接服务", "This environment cannot reset the connection service"));
      const result = await window.desktop.resetGateway();
      applyGatewayInfo(result);
      await load(true);
      showToast(tr(`连接服务已重置，已切换到随机端口 ${result.port}`, `Connection service reset; switched to random port ${result.port}`), "success");
    } catch (error) {
      showToast(`${tr("连接服务重置失败", "Connection service reset failed")}：${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      setGatewayResetting(false);
    }
  };

  const syncProvider = async (id: string, quiet = false) => {
    setSyncing(id);
    try {
      if (DEMO_MODE) {
        const provider = providers.find((item) => item.id === id);
        await new Promise((resolve) => window.setTimeout(resolve, 520));
        setSyncFailures((current) => current.filter((providerId) => providerId !== id));
        const result = { models: provider?.models || [], latencyMs: provider?.lastLatencyMs || 42 };
        if (!quiet) showToast(`${tr("演示线路可用", "Demo route ready")} · ${result.latencyMs}ms · ${result.models.length} ${tr("个模型", "models")}`, "success");
        return result;
      }
      const result = await request<{ models: string[]; latencyMs: number }>(`/admin/api/providers/${encodeURIComponent(id)}/test`, { method: "POST" });
      setSyncFailures((current) => current.filter((providerId) => providerId !== id));
      await load(true);
      if (!quiet) showToast(`${tr("线路可用", "Route ready")} · ${result.latencyMs}ms · ${result.models?.length || 0} ${tr("个模型", "models")}`, "success");
      return result;
    } catch (error) {
      setSyncFailures((current) => current.includes(id) ? current : [...current, id]);
      await load(true);
      if (!quiet) showToast(`${tr("线路检测失败", "Route test failed")}：${error instanceof Error ? error.message : String(error)}`, "error");
      throw error;
    } finally {
      setSyncing(null);
    }
  };

  const syncAll = async (onlyIds?: string[]) => {
    const targets = onlyIds?.length ? providers.filter((provider) => onlyIds.includes(provider.id)) : providers;
    if (!targets.length) return showToast(tr("还没有可检测的线路", "There are no routes to test"), "info");
    setSyncing("all");
    setSyncFailures([]);
    let success = 0;
    const failures: string[] = [];
    for (const [index, provider] of targets.entries()) {
      setSyncProgress({ current: index + 1, total: targets.length, providerId: provider.id, providerName: provider.name || provider.id });
      try {
        if (DEMO_MODE) await new Promise((resolve) => window.setTimeout(resolve, 300));
        else await request(`/admin/api/providers/${encodeURIComponent(provider.id)}/test`, { method: "POST" });
        success += 1;
      } catch {
        failures.push(provider.id);
      }
    }
    if (!DEMO_MODE) await load(true);
    setSyncing(null);
    setSyncProgress(null);
    setSyncFailures(failures);
    showToast(`${tr("已检测", "Tested")} ${success}/${targets.length}`, success === targets.length ? "success" : "info");
  };

  const handleProviderSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const id = String(form.get("id") || "").trim();
    const isEditing = modal?.kind === "provider" && Boolean(modal.provider);
    try {
      if (DEMO_MODE) {
        const current = modal?.kind === "provider" ? modal.provider : undefined;
        const nextProvider: Provider = {
          ...(current || {}), id, name: String(form.get("name") || id), baseUrl: String(form.get("baseUrl") || "https://demo.example.invalid/custom"),
          models: current?.models || ["demo-custom-1", "demo-custom-2", "demo-custom-3"], modelCount: current?.modelCount || 3,
          enabled: true, hasApiKey: true, modelFetchedAt: current?.modelFetchedAt || "2026-09-19T02:05:00.000Z", lastTestStatus: "ok", lastTestAt: "2026-09-19T02:05:00.000Z", lastLatencyMs: current?.lastLatencyMs || 68,
          clientKeyCount: current?.clientKeyCount || 0,
        };
        setProviders((currentProviders) => currentProviders.some((provider) => provider.id === id) ? currentProviders.map((provider) => provider.id === id ? nextProvider : provider) : [...currentProviders, nextProvider]);
        setModal(null);
        showToast(isEditing ? tr("演示线路已更新", "Demo route updated") : tr("演示线路已添加", "Demo route added"), "success");
        return;
      }
      await request("/admin/api/providers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, name: form.get("name"), baseUrl: form.get("baseUrl"), apiKey: form.get("apiKey") }),
      });
      setModal(null);
      try {
        await syncProvider(id, true);
        showToast(isEditing ? tr("线路已更新，模型目录已同步", "Route updated and model catalog synced") : tr("线路已添加，模型目录已同步", "Route added and model catalog synced"), "success");
      } catch {
        showToast(tr("线路已保存，但模型同步失败，请检查地址和 Key", "Route saved, but model sync failed. Check the URL and key."), "info");
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const handleKeySubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const isEditing = modal?.kind === "key" && Boolean(modal.key);
    const currentKey = modal?.kind === "key" ? modal.key : undefined;
    const payload = { name: String(form.get("name") || "").trim(), nameCustomized: form.get("nameCustomized") === "true", providerId: String(form.get("providerId") || ""), reasoningLevel: String(form.get("reasoningLevel") || "unchanged") as ReasoningLevel };
    try {
      if (DEMO_MODE) {
        if (isEditing && currentKey) {
          const provider = providers.find((item) => item.id === payload.providerId);
          setKeys((current) => current.map((key) => key.id === currentKey.id ? { ...key, ...payload, providerName: provider?.name || key.providerName } : key));
          setModal(null);
          showToast(tr("演示客户端 Key 已更新", "Demo client key updated"), "success");
        } else {
          const provider = providers.find((item) => item.id === payload.providerId) || providers[0];
          const id = `demo-key-${Date.now()}`;
          setKeys((current) => [...current, { id, ...payload, providerId: provider?.id || "", providerName: provider?.name || "演示线路", createdAt: "2026-09-19 10:05:00", enabled: true, hasSecret: true }]);
          setModal({ kind: "key-result", secret: `cg_demo_${id}` });
          showToast(tr("演示客户端 Key 已生成", "Demo client key created"), "success");
        }
        return;
      }
      if (isEditing && currentKey) {
        await request(`/admin/api/client-keys/${encodeURIComponent(currentKey.id)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
        setModal(null);
        await load(true);
        showToast(tr("客户端 Key 已更新", "Client key updated"), "success");
      } else {
        const result = await request<{ key: string }>("/admin/api/client-keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
        await load(true);
        setModal({ kind: "key-result", secret: result.key });
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const deleteProvider = async (id: string) => {
    const confirmed = await requestConfirmation({
      title: tr("删除中转站线路", "Delete upstream route"),
      message: tr("这条线路将被永久删除；已绑定的客户端 Key 必须先改绑或删除。", "This route will be permanently deleted. Bound client keys must be moved or deleted first."),
      confirmLabel: tr("永久删除线路", "Delete route"),
      cancelLabel: tr("取消", "Cancel"),
      tone: "danger",
      icon: "trash",
    });
    if (!confirmed) return;
    try {
      if (DEMO_MODE) {
        setProviders((current) => current.filter((provider) => provider.id !== id));
        setKeys((current) => current.filter((key) => key.providerId !== id));
        showToast(tr("演示线路已删除", "Demo route deleted"), "success");
        return;
      }
      await request(`/admin/api/providers/${encodeURIComponent(id)}`, { method: "DELETE" });
      await load(true);
      showToast(tr("线路已删除", "Route deleted"), "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const toggleKey = async (key: ClientKey) => {
    try {
      if (DEMO_MODE) {
        setKeys((current) => current.map((item) => item.id === key.id ? { ...item, enabled: !item.enabled } : item));
        showToast(key.enabled ? tr("演示 Key 已停用", "Demo key disabled") : tr("演示 Key 已启用", "Demo key enabled"), key.enabled ? "error" : "warning");
        return;
      }
      await request(`/admin/api/client-keys/${encodeURIComponent(key.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: !key.enabled }) });
      await load(true);
      showToast(key.enabled ? tr("Key 已停用", "Key disabled") : tr("Key 已启用", "Key enabled"), key.enabled ? "error" : "warning");
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const deleteKey = async (key: ClientKey) => {
    const confirmed = await requestConfirmation({
      title: tr("删除客户端 Key", "Delete client key"),
      message: tr("这个客户端 Key 删除后无法恢复，Cherry 将无法继续使用它。", "This client key cannot be recovered after deletion, and Cherry will no longer be able to use it."),
      confirmLabel: tr("永久删除 Key", "Delete key"),
      cancelLabel: tr("取消", "Cancel"),
      tone: "danger",
      icon: "trash",
    });
    if (!confirmed) return;
    try {
      if (DEMO_MODE) {
        setKeys((current) => current.filter((item) => item.id !== key.id));
        showToast(tr("演示客户端 Key 已删除", "Demo client key deleted"), "success");
        return;
      }
      await request(`/admin/api/client-keys/${encodeURIComponent(key.id)}`, { method: "DELETE" });
      await load(true);
      showToast(tr("客户端 Key 已永久删除", "Client key permanently deleted"), "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const applyReasoningToExisting = async () => {
    if (!keys.length) {
      showToast(tr("当前没有可应用的客户端 Key", "There are no client keys to update"), "info");
      return;
    }
    const level = reasoningOptionLabel(settings.forcedLevel, language);
    const confirmed = await requestConfirmation({
      title: tr("覆盖已有 Key 的思考强度", "Apply reasoning to existing keys"),
      message: tr(
        `将把 ${keys.length} 个已有客户端 Key 的思考强度统一改为 ${level}，覆盖它们当前的独立设置。`,
        `This will set ${keys.length} existing client key(s) to ${level} and overwrite their individual levels.`,
      ),
      confirmLabel: tr(`覆盖 ${keys.length} 个 Key`, `Overwrite ${keys.length} key(s)`),
      cancelLabel: tr("取消", "Cancel"),
      tone: "warning",
      icon: "spark",
    });
    if (!confirmed) return;
    try {
      if (DEMO_MODE) {
        setKeys((current) => current.map((key) => ({ ...key, reasoningLevel: settings.forcedLevel })));
        showToast(tr(`演示 Key 已统一为 ${reasoningOptionLabel(settings.forcedLevel, "zh")}`, `Demo keys are now ${reasoningOptionLabel(settings.forcedLevel, "en")}`), "success");
        return;
      }
      const next = await request<GatewaySettings>("/admin/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ forcedLevel: settings.forcedLevel, applyToExisting: true }) });
      const savedLevel = next.forcedLevel || settings.forcedLevel;
      setSettings((current) => ({ ...current, ...next, forcedLevel: savedLevel }));
      setSettingsDraftLevel(savedLevel);
      await load(true);
      showToast(tr(`现有客户端 Key 已统一为 ${reasoningOptionLabel(savedLevel, "zh")}`, `Existing client keys are now ${reasoningOptionLabel(savedLevel, "en")}`), "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const updateDesktopSetting = async (patch: Partial<DesktopSettings>) => {
    const previous = desktop;
    setDesktop((current) => ({ ...current, ...patch }));
    try {
      const nextDesktop = await window.desktop?.setSettings?.(patch);
      if (nextDesktop) setDesktop((current) => ({ ...current, ...nextDesktop }));
      showToast(tr("桌面设置已立即生效", "Desktop setting applied immediately"), "success");
    } catch (error) {
      setDesktop(previous);
      showToast(`${tr("桌面设置更新失败", "Could not update desktop setting")}：${error instanceof Error ? error.message : String(error)}`, "error");
    }
  };

  const copyApiAddress = async () => {
    try {
      await copy(apiBase);
      showToast(tr("本地 API 地址已复制", "Local API address copied"), "success");
    } catch {
      showToast(tr("复制失败，请手动选中地址复制", "Copy failed; select the address manually"), "error");
    }
  };

  const copyClientKey = async (key: ClientKey) => {
    if (!key.hasSecret) return;
    setCopyingKeyId(key.id);
    try {
      const secret = DEMO_MODE ? `cg_demo_${key.id}` : (await request<{ key: string }>(`/admin/api/client-keys/${encodeURIComponent(key.id)}/secret`)).key;
      await copy(secret);
      showToast(tr("客户端 Key 已复制", "Client key copied"), "success");
    } catch (error) {
      showToast(`${tr("复制客户端 Key 失败", "Could not copy client key")}：${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      setCopyingKeyId(null);
    }
  };

  const rotateClientKey = async (key: ClientKey) => {
    const confirmed = await requestConfirmation({
      title: tr("重新生成客户端 Key", "Regenerate client key"),
      message: tr("旧 Key 会立即失效，你需要把新 Key 重新填入 Cherry。", "The old key will stop working immediately. You will need to replace it in Cherry."),
      confirmLabel: tr("重新生成", "Regenerate"),
      cancelLabel: tr("取消", "Cancel"),
      tone: "warning",
      icon: "refresh",
    });
    if (!confirmed) return;
    try {
      if (DEMO_MODE) {
        await new Promise((resolve) => window.setTimeout(resolve, 300));
        setModal({ kind: "key-result", secret: `cg_demo_rotated_${key.id}` });
        showToast(tr("演示客户端 Key 已重新生成", "Demo client key regenerated"), "success");
        return;
      }
      const result = await request<{ key: string }>(`/admin/api/client-keys/${encodeURIComponent(key.id)}/rotate`, { method: "POST" });
      await load(true);
      setModal({ kind: "key-result", secret: result.key });
      showToast(tr("客户端 Key 已重新生成，旧 Key 已失效", "Client key regenerated; the old key is invalid"), "success");
    } catch (error) {
      showToast(`${tr("重新生成失败", "Could not regenerate key")}：${error instanceof Error ? error.message : String(error)}`, "error");
    }
  };

  const testClientKey = async (key: ClientKey) => {
    if (!key.enabled) return showToast(tr("请先启用这个客户端 Key", "Enable this client key before testing"), "info");
    setTestingKeyId(key.id);
    try {
      const result = DEMO_MODE ? (await new Promise<{ modelCount: number }>((resolve) => window.setTimeout(() => resolve({ modelCount: 128 }), 520))) : await request<{ modelCount: number }>(`/admin/api/client-keys/${encodeURIComponent(key.id)}/test`, { method: "POST" });
      if (!DEMO_MODE) await load(true);
      showToast(`${tr("本地连接正常", "Local connection ready")} · ${result.modelCount} ${tr("个模型", "models")}`, "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setTestingKeyId(null);
    }
  };

  const openDataFolder = () => { void window.desktop?.openDataFolder?.(); };

  const copySecret = async (secret: string) => {
    try {
      await copy(secret);
      setSecretCopied(true);
      showToast(tr("Key 已复制，请在关闭前确认已粘贴", "Key copied; confirm it is pasted before closing"), "success");
    } catch {
      setSecretCopied(false);
      showToast(tr("复制失败：请选中上方 Key 后按 Ctrl+C", "Copy failed: select the key above and press Ctrl+C"), "error");
    }
  };

  const copyErrorDetails = async (message: string) => {
    try {
      await copy(message);
      showToast(tr("错误详情已复制", "Error details copied"), "success");
    } catch {
      showToast(tr("复制失败，请手动选中错误文字复制", "Copy failed; select the error text manually"), "error");
    }
  };

  const pageTitle: Record<View, [string, string]> = {
    overview: ["总览", "Overview"],
    providers: ["中转站线路", "Upstream routes"],
    models: ["模型目录", "Model catalog"],
    keys: ["客户端 Key", "Client keys"],
    usage: ["使用统计", "Usage analytics"],
    cloud: ["云同步", "Cloud sync"],
    settings: ["设置", "Settings"],
  };

  const renderView = () => {
    switch (view) {
      case "providers": return ProvidersView();
      case "models": return ModelsView();
      case "keys": return KeysView();
      case "usage": return <UsageView language={language} gatewayOrigin={apiBase.replace(/\/v1\/?$/, "")} demo={DEMO_MODE} />;
      case "cloud": return CloudSyncView();
      case "settings": return SettingsView();
      default: return OverviewView();
    }
  };

  function StatusBadge({ provider }: { provider: Provider }) {
    const status = provider.lastTestStatus || "never";
    const label = status === "ok" ? tr("可用", "Ready") : status === "error" ? tr("异常", "Error") : tr("未检测", "Not tested");
    return <span className={`status-badge status-${status}`}><span className="status-dot" />{label}</span>;
  }

  function RouteAvatar({ provider }: { provider: Provider }) {
    return <div className="route-avatar">{initials(provider.name || provider.id)}</div>;
  }

  function RouteCard({ provider, compact = false, showSync = !compact, showActions = !compact }: { provider: Provider; compact?: boolean; showSync?: boolean; showActions?: boolean }) {
    const boundKeys = provider.clientKeyCount ?? keys.filter((key) => key.providerId === provider.id).length;
    const modelCount = provider.modelCount ?? provider.models.length;
    return <article className={`route-card ${compact ? "route-card-compact" : ""}`}>
      <div className="route-card-main">
        <RouteAvatar provider={provider} />
        <div className="route-title"><div className="route-name-line"><strong>{provider.name || provider.id}</strong><StatusBadge provider={provider} /></div><code>{provider.id}</code></div>
      </div>
      <div className="route-address" title={provider.baseUrl}><Icon name="globe" size={14} /><span>{provider.baseUrl}</span></div>
      <div className="route-facts">
        <span className="route-fact"><small>{tr("模型", "Models")}</small><b>{modelCount}</b></span>
        <span className="route-fact"><small>{tr("客户端 Key", "Client keys")}</small><b>{boundKeys}</b></span>
        <span className="route-fact route-latency" title={formatDate(provider.lastTestAt || provider.modelFetchedAt, language)}><small>{tr("延迟", "Latency")}</small><b>{provider.lastLatencyMs ? `${provider.lastLatencyMs}ms` : "—"}</b></span>
      </div>
      {showActions && <div className="route-actions">{showSync && <button className="button button-secondary button-small" onClick={() => void syncProvider(provider.id)} disabled={syncing === provider.id || syncing === "all"}><Icon name="refresh" size={14} />{syncing === provider.id ? tr("检测中", "Testing") : tr("检测线路", "Test route")}</button>}<button className="icon-button" onClick={() => setModal({ kind: "provider", provider })} title={tr("编辑线路", "Edit route")} aria-label={tr("编辑线路", "Edit route")}><Icon name="edit" size={15} /></button><button className="icon-button danger" onClick={() => void deleteProvider(provider.id)} title={tr("删除线路", "Delete route")} aria-label={tr("删除线路", "Delete route")}><Icon name="trash" size={15} /></button></div>}
      {provider.lastTestStatus === "error" && provider.lastError && <div className="route-error" title={provider.lastError}><Icon name="shield" size={13} /><span><strong>{tr("检测失败", "Sync failed")}</strong>{errorSummary(provider.lastError)}</span><button className="text-button" onClick={() => void copyErrorDetails(provider.lastError || "")}>{tr("复制详情", "Copy details")}</button></div>}
    </article>;
  }

  function OverviewView() {
    const overviewProviders = DEMO_MODE ? DEMO_PROVIDERS : providers;
    const overviewKeys = DEMO_MODE ? DEMO_KEYS : keys;
    const overviewTotalModels = DEMO_MODE ? 128 : totalModels;
    const overviewActiveKeys = DEMO_MODE ? 8 : activeKeys;
    const hasSuccessfulClientRequest = activeKeys > 0 && lastClientRequestStatus === "ok";
    const firstActiveKey = keys.find((key) => key.enabled);
    const nextStep = !providers.length
      ? { label: tr("添加第一条线路", "Add your first route"), action: () => setModal({ kind: "provider" }), icon: "plus" }
      : !totalModels
        ? { label: tr("刷新模型目录", "Refresh model catalog"), action: () => void syncAll(), icon: "refresh" }
        : !keys.length
          ? { label: tr("生成客户端 Key", "Create client key"), action: () => setModal({ kind: "key" }), icon: "key" }
          : !hasSuccessfulClientRequest && firstActiveKey
            ? { label: tr("测试本地连接", "Test local connection"), action: () => void testClientKey(firstActiveKey), icon: "check" }
            : { label: tr("管理客户端 Key", "Manage client keys"), action: () => navigate("keys"), icon: "key" };
    const overviewProviderById = (id: string) => overviewProviders.find((provider) => provider.id === id);
    const boundRoutes = overviewKeys.filter((key) => key.enabled).map((key) => ({ key, provider: overviewProviderById(key.providerId) })).filter((item) => item.provider);
    return <>
      <section className="welcome-panel">
      <div className="welcome-copy"><div className="eyebrow accent"><span className="live-pulse" />{tr("本地连接中心", "LOCAL CONNECTION CENTER")}</div><h2>{tr("把上游线路，变成", "One secure connection center for your ")}<em>{tr("一个好用的 AI 连接中心", "AI routes")}</em></h2><p>{tr("在这里管理中转站、模型目录和客户端 Key。上游密钥只留在本机，Cherry 只需要连接一个本地地址。", "Manage routes, model catalogs, and client keys here. Upstream secrets stay on this PC while Cherry connects to one local endpoint.")}</p><div className="welcome-actions"><button className="button button-primary" onClick={nextStep.action}><Icon name={nextStep.icon} size={15} />{nextStep.label}</button></div></div>
        <div className="welcome-visual"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="core-orb"><Icon name="route" size={34} /></div><span className="visual-caption">{tr("本地连接", "LOCAL CONNECT")}</span><strong>127.0.0.1</strong><small>PORT {gatewayPort}</small></div>
      </section>
      <div className="metric-grid"><Metric icon="route" tone="purple" value={String(overviewProviders.length === 3 && DEMO_MODE ? 12 : overviewProviders.length)} label={tr("中转站线路", "Upstream routes")} note={tr("可绑定客户端 Key", "Ready for key binding")} /><Metric icon="layers" tone="blue" value={String(overviewTotalModels)} label={tr("已同步模型", "Synced models")} note={tr("来自上游目录", "From upstream catalogs")} /><Metric icon="key" tone="green" value={String(overviewActiveKeys)} label={tr("有效客户端 Key", "Active client keys")} note={tr("仅显示本地凭证", "Local credentials only")} /><Metric icon="spark" tone="amber" value={levelLabel(settings.forcedLevel)} label={tr("默认思考强度", "Default reasoning")} note={tr("真实写入转发请求", "Written into requests")} /></div>
      <div className="overview-columns stable-overview-columns">
        <section className="panel routing-panel"><PanelHeading kicker={tr("客户端路由", "CLIENT ROUTING")} title={tr("当前 Key 路由", "Current key routing")} description={tr("每个客户端 Key 只绑定一条线路；这里显示有效 Key 的实际去向。", "Each client key binds to one route; this shows where active keys actually go.")} /><div className="routing-summary">{boundRoutes.length ? <div className="routing-list">{boundRoutes.slice(0, 3).map(({ key, provider }) => <div className="routing-row" key={key.id}><div className="routing-icon"><Icon name="key" size={17} /></div><div><strong>{key.name}</strong><code>{provider?.name || key.providerId}</code></div><span className="level-chip">{levelLabel(key.reasoningLevel)}</span></div>)}{boundRoutes.length > 3 && <small className="routing-more">+{boundRoutes.length - 3} {tr("个客户端 Key", "more client keys")}</small>}</div> : <div className="routing-empty"><Icon name="route" size={18} /><span>{tr("生成客户端 Key 后，这里会显示它绑定的线路。", "Create a client key to see its bound route here.")}</span></div>}</div><div className="safe-note"><Icon name="shield" size={14} /><span>{tr("上游 Key 加密保存在本机，客户端永远看不到。", "Upstream keys are encrypted locally and never shown to clients.")}</span></div></section>
        <section className="panel connection-panel"><PanelHeading kicker={tr("连接状态", "CONNECTION STATUS")} title={tr("本地连接状态", "Local connection status")} description={tr("集中查看本地入口和最近一次请求，不占用配置引导空间。", "See the local endpoint and latest request without permanent onboarding clutter.")} /><div className="connection-pulse-grid"><button type="button" onClick={() => void copyApiAddress()}><span className="connection-pulse-icon"><Icon name="copy" size={16} /></span><span><small>{tr("本地 API 地址", "Local API URL")}</small><strong>{apiBase}</strong></span></button><div><span className={`connection-pulse-icon status-${lastClientRequestStatus}`}><Icon name={lastClientRequestStatus === "ok" ? "check" : lastClientRequestStatus === "error" ? "shield" : "refresh"} size={16} /></span><span><small>{tr("最近请求", "Latest request")}</small><strong>{lastClientRequestStatus === "ok" ? tr("转发成功", "Forwarded") : lastClientRequestStatus === "error" ? tr("转发失败", "Failed") : tr("等待请求", "Waiting")}</strong><em>{lastClientRequestModel || formatDate(lastClientRequestAt, language)}</em></span></div></div><div className="connection-panel-footer"><span><i className="gold-dot" />{tr(`${DEMO_MODE ? 12 : providers.length} 条线路 · ${DEMO_MODE ? 8 : activeKeys} 个有效 Key`, `${DEMO_MODE ? 12 : providers.length} routes · ${DEMO_MODE ? 8 : activeKeys} active keys`)}</span><button className="text-button" onClick={() => navigate("usage")}>{tr("查看使用记录", "View usage")} <Icon name="arrow" size={13} /></button></div></section>
      </div>
      <section className="section-block"><PanelHeading kicker={tr("线路概览", "ROUTE SNAPSHOT")} title={tr("线路概览", "Route snapshot")} description={tr("这里只显示状态摘要；完整模型列表统一放在模型目录。", "Only status appears here; the full catalog lives in Models.")} action={<button className="text-button" onClick={() => navigate("providers")}>{tr("管理线路", "Manage routes")} <Icon name="arrow" size={14} /></button>} />{overviewProviders.length ? <div className="route-list compact-route-list">{overviewProviders.map((provider) => <RouteCard provider={provider} compact key={provider.id} />)}</div> : <EmptyState icon="route" title={tr("还没有中转站线路", "No upstream routes yet")} description={tr("添加第一条线路后，点击检测即可读取模型。", "Add your first route, then test it to read its models.")} action={<button className="button button-primary" onClick={() => setModal({ kind: "provider" })}>{tr("添加第一条线路", "Add first route")}</button>} />}</section>
    </>;
  }

  function ProvidersView() {
    const actions = <div className="page-action-group">
      {providers.length > 0 && <button className="button button-secondary" onClick={() => void syncAll()} disabled={syncing === "all"}><Icon name="refresh" size={15} />{syncing === "all" ? tr("全部检测中", "Testing all") : tr("检测全部线路", "Test all routes")}</button>}
      <button className="button button-primary" onClick={() => setModal({ kind: "provider" })}><Icon name="plus" size={15} />{tr("添加线路", "Add route")}</button>
    </div>;
    return <section className="page-view">
      <PageIntro kicker={tr("中转站线路", "UPSTREAM ROUTES")} description={tr("一条线路保存一个上游地址和 Key；创建客户端 Key 时必须绑定其中一条。", "Each route stores one upstream URL and key. Every client key must bind to one route.")} action={actions} />
      <div className="info-banner"><div className="banner-icon"><Icon name="shield" size={17} /></div><div><strong>{tr("先检测，再绑定", "Test before binding")}</strong><span>{tr("新增线路会自动检测；也可以随时单独检测或一次检测全部线路。", "New routes are tested automatically. You can also test one route or all routes at any time.")}</span></div><span className="banner-rule">{tr("一 Key 一线路", "1 key · 1 route")}</span></div>
      {syncProgress && <div className="sync-progress-banner" role="status"><Icon name="refresh" size={15} /><div><strong>{tr(`正在检测 ${syncProgress.current}/${syncProgress.total}`, `Testing ${syncProgress.current}/${syncProgress.total}`)}</strong><span>{syncProgress.providerName}</span></div><div className="sync-progress-track"><span style={{ width: `${Math.round((syncProgress.current / syncProgress.total) * 100)}%` }} /></div></div>}
      {providers.length ? <div className="route-list">{providers.map((provider) => <RouteCard provider={provider} key={provider.id} showSync />)}</div> : <EmptyState icon="route" title={tr("还没有中转站线路", "No upstream routes yet")} description={tr("添加线路后才能生成绑定它的客户端 Key。", "Add a route before creating a bound client key.")} action={<button className="button button-primary" onClick={() => setModal({ kind: "provider" })}>{tr("添加中转站线路", "Add upstream route")}</button>} />}
    </section>;
  }

  function ModelsView() {
    const groups = providers.map((provider) => {
      const models = (provider.models || []).filter((model) => !modelQuery.trim() || model.toLowerCase().includes(modelQuery.trim().toLowerCase()));
      return { provider, models };
    }).filter(({ provider }) => modelFilter === "all" || provider.id === modelFilter);
    const visibleCount = groups.reduce((sum, group) => sum + group.models.length, 0);
    const failedNames = syncFailures.map((id) => providers.find((provider) => provider.id === id)?.name || id);
    return <section className="page-view">
      <PageIntro kicker={tr("模型目录", "MODEL CATALOG")} description={tr("按中转站分组显示上游模型；每个分组可以独立展开或折叠。", "Models are grouped by route; every group can expand or collapse independently.")} action={<button className="button button-secondary" onClick={() => void syncAll()} disabled={syncing === "all"}><Icon name="refresh" size={15} />{syncing === "all" ? tr("刷新中", "Refreshing") : tr("刷新全部模型", "Refresh all models")}</button>} />
      {syncProgress && <div className="sync-progress-banner" role="status"><Icon name="refresh" size={15} /><div><strong>{tr(`正在刷新 ${syncProgress.current}/${syncProgress.total}`, `Refreshing ${syncProgress.current}/${syncProgress.total}`)}</strong><span>{syncProgress.providerName}</span></div><div className="sync-progress-track"><span style={{ width: `${Math.round((syncProgress.current / syncProgress.total) * 100)}%` }} /></div></div>}
      {!syncProgress && syncFailures.length > 0 && <div className="sync-result-banner" role="status"><Icon name="shield" size={15} /><div><strong>{tr(`有 ${syncFailures.length} 条线路刷新失败`, `${syncFailures.length} route(s) failed`)}</strong><span>{failedNames.join("、")}</span></div><button className="button button-secondary button-small" onClick={() => void syncAll(syncFailures)} disabled={syncing === "all"}><Icon name="refresh" size={13} />{tr("重试失败线路", "Retry failed")}</button></div>}
      <div className="catalog-toolbar"><div className="select-control"><span>{tr("线路", "Route")}</span><MenuSelect className="catalog-route-menu" value={modelFilter} options={[{ value: "all", label: tr("全部线路", "All routes") }, ...providers.map((provider) => ({ value: provider.id, label: provider.name || provider.id }))]} onChange={setModelFilter} ariaLabel={tr("选择线路", "Choose route")} /></div><label className="search-control"><Icon name="search" size={15} /><input value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} placeholder={tr("搜索模型名称", "Search model name")} /></label><span className="result-count">{visibleCount} {tr("个模型", "models")}</span></div>
      {groups.length ? <div className="model-groups">{groups.map(({ provider, models }) => {
        const collapsed = collapsedModelGroups.has(provider.id) && !modelQuery.trim();
        return <section className={`model-group ${collapsed ? "is-collapsed" : ""}`} key={provider.id}>
          <header className="model-group-header">
            <button type="button" className="group-toggle" onClick={() => toggleModelGroup(provider.id)} aria-expanded={!collapsed} aria-label={collapsed ? tr("展开模型分组", "Expand model group") : tr("折叠模型分组", "Collapse model group")}><Icon name="chevron" size={15} /></button>
            <div className="group-identity"><RouteAvatar provider={provider} /><div><strong>{provider.name || provider.id}</strong><code>{provider.id}</code></div></div>
            <div className="group-summary"><span>{models.length} {tr("个匹配模型", "matching models")}</span><button className="icon-text-button" onClick={() => void syncProvider(provider.id)} disabled={syncing === provider.id}><Icon name="refresh" size={13} />{tr("刷新", "Refresh")}</button></div>
          </header>
          {!collapsed && (models.length ? <div className="model-grid">{models.map((model) => <article className="model-item" key={`${provider.id}:${model}`}><span className="model-mark"><Icon name="layers" size={14} /></span><code title={model}>{model}</code><span className="model-ready"><span className="status-dot" /></span></article>)}</div> : <div className="inline-empty">{tr("没有匹配模型；尝试清空搜索词，或先同步线路。", "No matching models. Clear the search or sync this route.")}</div>)}
        </section>;
      })}</div> : <EmptyState icon="layers" title={providers.length ? tr("没有匹配的模型", "No matching models") : tr("还没有模型目录", "No model catalog yet")} description={providers.length ? tr("换一个搜索词试试。", "Try another search term.") : tr("去中转站线路页添加线路并同步模型。", "Add and sync a route from the Upstream Routes page.")} action={providers.length ? undefined : <button className="button button-primary" onClick={() => navigate("providers")}>{tr("去添加线路", "Go to routes")}</button>} />}
    </section>;
  }

   function KeysView() {
     return <section className="page-view"><PageIntro kicker={tr("客户端凭证", "LOCAL ACCESS TOKENS")} description={tr("给 Cherry 或其他客户端使用的本地凭证。真实上游 Key 永远不会暴露。", "Local credentials for Cherry and other clients. Upstream keys never leave this local connection service.")} action={<button className="button button-primary" onClick={() => setModal({ kind: "key" })} disabled={!providers.length}><Icon name="plus" size={15} />{tr("生成客户端 Key", "Create client key")}</button>} /><div className="key-banner"><div className="banner-icon"><Icon name="lock" size={17} /></div><div><strong>{tr("一个客户端 Key，只绑定一条线路", "One client key binds to one route")}</strong><span>{tr("创建时选择中转站线路和思考强度；之后每次请求都会按这个绑定转发。", "Choose a route and reasoning level at creation; every request follows that binding.")}</span></div><Icon name="shield" size={19} /></div><div className="key-toolbar"><span>{tr("本地访问凭证", "Local access credentials")} <small>{keys.length}</small></span><span>{tr("删除和停用都会立即生效", "Disable or delete takes effect immediately")}</span></div>{keys.length ? <div className="key-list">{keys.map((key) => <article className={`client-key-card ${key.enabled ? "" : "is-disabled"}`} key={key.id}><div className="key-card-head"><div className="key-symbol"><Icon name="key" size={17} /></div><div className="key-name"><strong>{key.name || tr("未命名客户端", "Unnamed client")}</strong><code>cg_••••••••••••</code></div><div className="key-quick-actions">{key.hasSecret && <button className="icon-text-button quick-copy-button" onClick={() => void copyClientKey(key)} disabled={copyingKeyId === key.id} title={tr("复制客户端 Key", "Copy client key")}><Icon name="copy" size={13} />{copyingKeyId === key.id ? tr("复制中", "Copying") : tr("复制 Key", "Copy key")}</button>}<button className="icon-text-button quick-copy-button" onClick={() => void copyApiAddress()} disabled={gatewayResetting} title={tr("复制本地 API 地址", "Copy local API URL")}><Icon name="copy" size={13} />{tr("复制地址", "Copy URL")}</button>{!key.hasSecret && <button className="icon-text-button quick-copy-button regenerate-key-button" onClick={() => void rotateClientKey(key)} title={tr("重新生成并替换旧 Key", "Regenerate and replace the old key")}><Icon name="refresh" size={13} />{tr("重新生成", "Regenerate")}</button>}</div><span className={`key-status ${key.enabled ? "active" : "disabled"}`}><span className="status-dot" />{key.enabled ? tr("有效", "Active") : tr("已停用", "Disabled")}</span></div><div className="key-card-details"><div><small>{tr("绑定线路", "Bound route")}</small><strong><Icon name="route" size={13} />{key.providerName || tr("未绑定", "Unbound")}</strong></div><div><small>{tr("思考强度", "Reasoning")}</small><b className="level-chip">{levelLabel(key.reasoningLevel)}</b></div><div><small>{tr("创建时间", "Created")}</small><span>{key.createdAt}</span></div></div><div className="key-card-actions"><button className="icon-text-button" onClick={() => void testClientKey(key)} disabled={!key.enabled || testingKeyId === key.id}><Icon name="check" size={14} />{testingKeyId === key.id ? tr("测试中", "Testing") : tr("测试连接", "Test connection")}</button><button className="icon-text-button" onClick={() => setModal({ kind: "key", key })}><Icon name="edit" size={14} />{tr("编辑", "Edit")}</button><button className="icon-text-button" onClick={() => void toggleKey(key)}><Icon name="power" size={14} />{key.enabled ? tr("停用", "Disable") : tr("启用", "Enable")}</button><button className="icon-text-button danger-text" onClick={() => void deleteKey(key)}><Icon name="trash" size={14} />{tr("删除", "Delete")}</button></div></article>)}</div> : <EmptyState icon="key" title={tr("还没有客户端 Key", "No client keys yet")} description={providers.length ? tr("生成一个绑定到线路的客户端 Key，填入 Cherry 的 API Key 位置。", "Create a route-bound key and put it in Cherry's API key field.") : tr("请先添加至少一条中转站线路。", "Add at least one upstream route first.")} action={<button className="button button-primary" onClick={() => providers.length ? setModal({ kind: "key" }) : navigate("providers")}>{providers.length ? tr("生成第一个 Key", "Create first key") : tr("先添加线路", "Add a route first")}</button>} />}</section>;
   }

  function SettingsView() {
    return <section className="page-view">
      <PageIntro kicker={tr("设置", "PREFERENCES")} description={tr("控制请求策略、桌面行为和本机安全；语言与云同步已移到独立入口。", "Control request policy, desktop behavior, and local security; language and cloud sync have their own entry points.")} action={undefined} />
      <div className="settings-layout">
        <div className="settings-column">
        <article className="settings-card">
          <SettingsHeading icon="spark" title={tr("请求策略", "Request policy")} description={tr("决定新建 Key 的默认思考强度，也可以单独编辑每个客户端 Key。", "Set the default reasoning level for new keys; each client key can override it.")} />
          <div className="setting-line settings-reasoning-line"><div><strong>{tr("默认思考强度", "Default reasoning level")}</strong><small>{tr("选择后立即写入网关；已有 Key 保持自己的等级。选择 UNCHANGED 则保留客户端原始策略。", "Saved immediately; existing keys keep their own level. UNCHANGED preserves each client's original strategy.")}</small></div><MenuSelect className="settings-level-menu" value={settings.forcedLevel} options={levels.map((level) => ({ value: level, label: reasoningOptionLabel(level, language) }))} onChange={(value) => void changeDefaultReasoning(value as ReasoningLevel)} disabled={reasoningUpdating || gatewayResetting} ariaLabel={tr("默认思考强度", "Default reasoning level")} /></div>
          <button type="button" className="button button-secondary full-width" onClick={() => void applyReasoningToExisting()} disabled={reasoningUpdating || gatewayResetting || !keys.length}><Icon name="spark" size={15} />{tr(`将 ${reasoningOptionLabel(settings.forcedLevel, "zh")} 应用到 ${keys.length} 个已有 Key`, `Apply ${reasoningOptionLabel(settings.forcedLevel, "en")} to ${keys.length} existing key(s)`)}</button>
          <div className="settings-note"><Icon name="key" size={14} /><span>{tr("每个客户端 Key 创建时必须绑定且只绑定一条中转站线路。", "Every client key must bind to exactly one upstream route.")}</span></div>
        </article>
        <UpdateCard language={language} currentVersion={VERSION} checkTrigger={settingsVisit} />
        </div>
        <div className="settings-column">
        <article className="settings-card">
          <SettingsHeading icon="monitor" title={tr("桌面行为", "Desktop behavior")} description={tr("连接服务会随桌面程序一起运行，并可在托盘中保持后台工作。", "The connection service runs with the desktop app and can stay in the tray.")} />
          <SettingCheck name="autoLaunch" checked={desktop.autoLaunch} onChange={(checked) => void updateDesktopSetting({ autoLaunch: checked })} title={tr("开机自动启动", "Start with Windows")} description={tr("登录 Windows 后自动运行连接服务。", "Start the connection service when you sign in to Windows.")} />
          <SettingCheck name="startMinimized" checked={desktop.startMinimized} onChange={(checked) => void updateDesktopSetting({ startMinimized: checked })} title={tr("启动后隐藏到托盘", "Start hidden in tray")} description={tr("开机启动时不弹出主窗口。", "Do not show the main window on startup.")} />
          <SettingCheck name="closeToTray" checked={desktop.closeToTray} onChange={(checked) => void updateDesktopSetting({ closeToTray: checked })} title={tr("关闭窗口时隐藏到托盘", "Close to tray")} description={tr("点击右上角关闭会触发一次后台同步并隐藏窗口；连接服务继续工作。", "Closing triggers one background sync, hides the window, and keeps the service running.")} />
        </article>
        <article className="settings-card compact-settings">
          <SettingsHeading icon="shield" title={tr("安全与连接", "Security & connection")} description={tr("上游密钥使用本机加密保存；Cherry 只连接下面的本地地址。", "Upstream keys are encrypted locally; Cherry only connects to this local address.")} />
          <div className="connection-box"><div><small>{tr("本地 API 地址", "Local API address")}</small><code>{apiBase}</code></div><button type="button" className="icon-text-button settings-copy-button" onClick={() => void copyApiAddress()}><Icon name="copy" size={14} />{tr("复制", "Copy")}</button></div>
          <div className="connection-note"><Icon name="refresh" size={13} /><span>{tr("“重置连接服务”会停止旧监听器并切换到新的随机端口，用来避开端口冲突；线路、模型、统计和客户端 Key 都会保留。", "Resetting the connection service switches to a random port to avoid conflicts; routes, models, analytics, and client keys are preserved.")}</span></div>
          <button type="button" className="button button-secondary full-width" onClick={openDataFolder}><Icon name="folder" size={15} />{tr("打开数据目录", "Open data folder")}</button>
          <div className="settings-note"><Icon name="folder" size={14} /><span>{tr("正式版数据保存在安装程序目录旁的独立数据文件夹，覆盖更新不会清理它；安装到 D 盘时主要数据也保留在 D 盘。", "Packaged data stays in a separate folder beside the app directory, outside the installer's cleanup area. Installing on drive D keeps primary data on drive D.")}</span></div>
          <div className="settings-note warning-note"><Icon name="shield" size={14} /><span>{tr("请勿误删、移动或覆盖 data 及其中的记录文件。删除整个软件文件夹会同时删除缓存、线路、客户端 Key、永久统计和未同步数据。", "Do not accidentally delete, move, or overwrite data or its record files. Deleting the app folder also removes caches, routes, client keys, lifetime analytics, and unsynced data.")}</span></div>
        </article>
        </div>
      </div>
    </section>;
  }

  function CloudSyncView() {
    return <section className="page-view cloud-sync-workspace">
      <PageIntro kicker={tr("云同步", "CLOUD SYNC")} description={tr("独立管理 GitHub 连接、同步状态、数据保护和版本记录。用量可独立同步，中转站 API 仅在主动开启后加密同步。", "Manage the GitHub connection, sync status, data protection, and version history in one workspace. Usage syncs independently; upstream APIs are encrypted only when enabled.")} action={undefined} />
      <CloudSyncCard language={language} requestConfirmation={requestConfirmation} demo={DEMO_MODE} />
    </section>;
  }

  function Modal() {
    if (!modal) return null;
    const close = () => setModal(null);
    return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div className="modal" role="dialog" aria-modal="true">
        <button className="modal-close" onClick={close} aria-label={tr("关闭", "Close")}>×</button>
        {modal.kind === "provider" && <>
          <div className="modal-icon"><Icon name="route" size={19} /></div>
          <div className="modal-kicker">{modal.provider ? tr("EDIT UPSTREAM ROUTE", "EDIT UPSTREAM ROUTE") : tr("NEW UPSTREAM ROUTE", "NEW UPSTREAM ROUTE")}</div>
          <h2>{modal.provider ? tr("编辑中转站线路", "Edit upstream route") : tr("添加中转站线路", "Add upstream route")}</h2>
          <p>{tr("保存后会立即检测 /v1/models；上游 Key 只会加密保存在本机。", "Saving will test /v1/models. The upstream key is encrypted and kept on this PC.")}</p>
          <form onSubmit={handleProviderSubmit}>
            <Field label={tr("线路代号", "Route ID")} name="id" defaultValue={modal.provider?.id || ""} placeholder="router-luna" readOnly={Boolean(modal.provider)} required />
            <Field label={tr("线路名称", "Route name")} name="name" defaultValue={modal.provider?.name || ""} placeholder={tr("例如 我的 Luna 线路", "e.g. My Luna route")} required />
            <Field label="API URL" name="baseUrl" type="url" defaultValue={modal.provider?.baseUrl || ""} placeholder="https://example.com" required />
            <Field label={modal.provider ? tr("中转站 Key（留空保持不变）", "Upstream key (blank keeps it)") : tr("中转站 Key", "Upstream key")} name="apiKey" type="password" placeholder="sk-..." />
            <div className="form-tip"><Icon name="shield" size={14} />{tr("模型不手填，检测成功后自动读取。", "Models are read automatically after a successful test.")}</div>
            <ModalActions cancel={tr("取消", "Cancel")} submit={modal.provider ? tr("保存并同步", "Save & sync") : tr("添加并同步", "Add & sync")} />
          </form>
        </>}
        {modal.kind === "key" && <>
          <div className="modal-icon"><Icon name="key" size={19} /></div>
          <div className="modal-kicker">{modal.key ? tr("EDIT CLIENT KEY", "EDIT CLIENT KEY") : tr("NEW CLIENT KEY", "NEW CLIENT KEY")}</div>
          <h2>{modal.key ? tr("编辑客户端 Key", "Edit client key") : tr("生成客户端 Key", "Create client key")}</h2>
          <p>{tr("默认使用所绑定的线路名称；只有手动改名后才会停止同步。", "The key follows its route name until you customize it manually.")}</p>
          <ClientKeyForm clientKey={modal.key} providers={providers} defaultLevel={settings.forcedLevel} language={language} onSubmit={handleKeySubmit} actions={<ModalActions cancel={tr("取消", "Cancel")} submit={modal.key ? tr("保存修改", "Save changes") : tr("生成 Key", "Create key")} disabled={!providers.length} />} />
        </>}
        {modal.kind === "key-result" && <>
          <div className="modal-icon success-icon"><Icon name="check" size={20} /></div>
          <div className="modal-kicker">{tr("CLIENT KEY READY", "CLIENT KEY READY")}</div>
          <h2>{tr("客户端 Key 已准备好", "Client key ready")}</h2>
          <p>{tr("它已在本机加密保存；关闭窗口后仍可从客户端 Key 卡片复制。上游中转站 Key 不会显示。", "It is encrypted locally and remains copyable from the client-key card. Upstream keys are never shown.")}</p>
          <div className="secret-box"><code>{modal.secret}</code><button className="icon-text-button" onClick={() => void copySecret(modal.secret)}><Icon name="copy" size={14} />{tr("复制", "Copy")}</button></div>
          <div className="copy-feedback" role="status"><Icon name={secretCopied ? "check" : "shield"} size={13} />{secretCopied ? tr("已复制；本地 API 地址可在上方或卡片中复制。", "Copied; the local API URL is available above or on the card.") : tr("可以现在复制，也可以关闭窗口后从卡片复制。", "Copy now or later from the client-key card.")}</div>
          <div className="copy-guide"><span>1</span>{tr(`API 地址：${apiBase}`, `API URL: ${apiBase}`)}</div>
          <div className="copy-guide"><span>2</span>{tr("API Key：粘贴上面的客户端 Key", "API key: paste the client key above")}</div>
          <div className="form-actions"><button className="button button-primary" onClick={close}>{tr("我已保存，完成", "I've saved it")}</button></div>
        </>}
      </div>
    </div>;
  }

  return <div className={`app-shell locale-${language}`}>
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Icon name="spark" size={18} /></div><div><strong>Cherry</strong><small>CONNECT</small></div><span className="brand-tag">{language === "zh" ? "本地" : "LOCAL"}</span></div>
      <button type="button" className="workspace-card workspace-status-card" onClick={() => void copyApiAddress()} title={tr("复制本地 API 地址", "Copy local API URL")}><span className="workspace-icon"><span className={`status-dot ${gatewayResetting ? "is-restarting" : ""}`} /></span><div><strong>{gatewayResetting ? tr("服务正在重启", "Service restarting") : tr("本地服务在线", "Local service online")}</strong><small>127.0.0.1:{gatewayPort} · {tr("点击复制", "Click to copy")}</small></div><Icon name="copy" size={13} /></button>
      <div className="nav-label">{tr("工作台", "WORKSPACE")}</div>
      <NavItem icon="grid" label={tr("总览", "Overview")} active={view === "overview"} onClick={() => navigate("overview")} />
      <NavItem icon="route" label={tr("中转站线路", "Routes")} active={view === "providers"} onClick={() => navigate("providers")} />
      <NavItem icon="layers" label={tr("模型目录", "Models")} active={view === "models"} onClick={() => navigate("models")} />
      <NavItem icon="key" label={tr("客户端 Key", "Client keys")} active={view === "keys"} onClick={() => navigate("keys")} />
      <NavItem icon="chart" label={tr("使用统计", "Usage")} active={view === "usage"} onClick={() => navigate("usage")} />
      <NavItem icon="cloud" label={tr("云同步", "Cloud sync")} active={view === "cloud"} onClick={() => navigate("cloud")} />
      <div className="nav-label nav-spaced">{tr("系统", "SYSTEM")}</div>
      <NavItem icon="settings" label={tr("设置", "Settings")} active={view === "settings"} onClick={() => navigate("settings")} />
      <div className="sidebar-grow" />
      <div className="sidebar-status"><div className="status-line"><span className={`status-dot ${gatewayResetting ? "is-restarting" : ""}`} /><strong>{gatewayResetting ? tr("连接服务重启中…", "Connection service restarting…") : tr("连接服务在线", "Connection service online")}</strong><span>{gatewayResetting ? "…" : gatewayPort}</span></div><div className="sidebar-status-meta"><small>{lastClientRequestStatus === "ok" ? tr("最近一次转发成功", "Last request succeeded") : lastClientRequestStatus === "error" ? tr("最近一次转发失败", "Last request failed") : gatewayResetting ? tr("正在重启连接服务", "Connection service restarting") : tr("等待客户端请求", "Waiting for a client request")}</small><small>{tr("上游 Key 仅保存在本机", "Upstream keys stay local")}</small></div></div>
      <div className="sidebar-footer"><span>Cherry AI 连接中心</span><span>{VERSION}</span></div>
    </aside>
    <main className="main-scroll">
      <header className="topbar"><div><div className="top-eyebrow">{tr("本地连接中心", "LOCAL CONNECTION CENTER")}</div><h1>{tr(pageTitle[view][0], pageTitle[view][1])}</h1></div><div className="top-actions"><button type="button" className={`endpoint-pill endpoint-copy-button ${gatewayResetting ? "is-restarting" : ""}`} onClick={() => void copyApiAddress()} disabled={gatewayResetting} aria-live="polite" title={tr("复制本地 API 地址", "Copy local API address")}><span className="status-dot" />{gatewayResetting ? tr("连接服务重启中…", "Connection service restarting…") : `127.0.0.1:${gatewayPort}`}<Icon name="copy" size={13} /></button><div className={`reasoning-control custom-reasoning-control ${reasoningMenuOpen ? "is-open" : ""} ${reasoningUpdating ? "is-updating" : ""}`} title={tr("修改默认思考强度；已有客户端 Key 保持独立设置", "Change the default reasoning level; existing client keys keep their own setting")}><Icon name="spark" size={14} /><span>{tr("默认思考", "Default")}</span><button type="button" className="reasoning-select-trigger" onClick={() => setReasoningMenuOpen((open) => !open)} disabled={reasoningUpdating || gatewayResetting} aria-haspopup="listbox" aria-expanded={reasoningMenuOpen} aria-label={tr("默认思考强度", "Default reasoning level")}><span>{reasoningOptionLabel(settings.forcedLevel, language)}</span><Icon name="chevron" size={12} /></button>{reasoningMenuOpen && <div className="reasoning-menu" role="listbox" aria-label={tr("默认思考强度选项", "Default reasoning level options")}>{levels.map((level) => <button type="button" role="option" aria-selected={settings.forcedLevel === level} className={settings.forcedLevel === level ? "selected" : ""} onClick={() => { setReasoningMenuOpen(false); void changeDefaultReasoning(level); }} key={level}><span>{reasoningOptionLabel(level, language)}</span>{settings.forcedLevel === level && <Icon name="check" size={13} />}</button>)}</div>}</div><button className="top-reset-button" onClick={() => void handleResetGateway()} disabled={loading || gatewayResetting} title={tr("重置连接服务并随机端口；旧 API 地址会失效", "Reset connection service and randomize port; the old API address will stop working")} aria-label={tr("重置连接服务并随机端口", "Reset and randomize connection service")}><Icon name="refresh" size={15} /><span>{tr("重置连接服务", "Reset connection service")}</span></button><div className="language-switcher"><button className={`language-pill ${languageMenuOpen ? "is-open" : ""}`} onClick={() => setLanguageMenuOpen((open) => !open)} title={tr("选择界面语言", "Choose interface language")} aria-haspopup="menu" aria-expanded={languageMenuOpen}>{language === "zh" ? "中" : "EN"}</button>{languageMenuOpen && <div className="language-menu" role="menu"><button type="button" className={language === "zh" ? "selected" : ""} onClick={() => void changeLanguage("zh")} role="menuitem">简体中文</button><button type="button" className={language === "en" ? "selected" : ""} onClick={() => void changeLanguage("en")} role="menuitem">English</button></div>}</div></div></header>
      <div className="content-wrap">{DEMO_MODE && <div className="demo-data-banner">演示数据：仅当前浏览器页面临时显示，不会写入本地或云端 · Demo data: browser-only, no local or cloud writes</div>}{renderView()}</div>
    </main>
    <Modal />
    <ConfirmDialog />
    {toast && <div className={`toast toast-${toast.tone}`}><span className="toast-dot" /><span>{toast.message}</span></div>}
  </div>;

  function ModalActions({ cancel, submit, disabled = false }: { cancel: string; submit: string; disabled?: boolean }) { return <div className="form-actions"><button type="button" className="button button-ghost" onClick={() => setModal(null)}>{cancel}</button><button type="submit" className="button button-primary" disabled={disabled}>{submit}</button></div>; }
  function ConfirmDialog() {
    if (!confirmDialog) return null;
    const tone = confirmDialog.tone || "primary";
    const icon = confirmDialog.icon || (tone === "danger" ? "trash" : "shield");
    return <div className="confirm-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) resolveConfirmation(false); }}>
      <section className={`confirm-dialog confirm-dialog-${tone}`} role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title" aria-describedby="confirm-dialog-message">
        <div className="confirm-dialog-header"><span className="confirm-icon"><Icon name={icon} size={18} /></span><div><div className="confirm-kicker">{tr("需要确认", "CONFIRM ACTION")}</div><h2 id="confirm-dialog-title">{confirmDialog.title}</h2><p id="confirm-dialog-message">{confirmDialog.message}</p></div></div>
        <div className="confirm-actions"><button type="button" className="button button-ghost" onClick={() => resolveConfirmation(false)}>{confirmDialog.cancelLabel}</button><button type="button" className={`button confirm-submit confirm-submit-${tone}`} autoFocus onClick={() => resolveConfirmation(true)}>{confirmDialog.confirmLabel}</button></div>
      </section>
    </div>;
  }
}
