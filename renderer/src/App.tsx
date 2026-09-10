/**
 * 中文：React 渲染层负责页面状态、双语界面、线路/模型/客户端 Key 管理。
 * English: The React renderer owns page state, bilingual UI, and route/model/client-key management.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";

const DEFAULT_GATEWAY_ORIGIN = "http://127.0.0.1:27891";
const DEFAULT_GATEWAY_API_BASE = `${DEFAULT_GATEWAY_ORIGIN}/v1`;
let activeGatewayOrigin = DEFAULT_GATEWAY_ORIGIN;
const VERSION = "0.4.3";

type View = "overview" | "providers" | "models" | "keys" | "settings";
type Language = "zh" | "en";
type ReasoningLevel = "low" | "medium" | "high" | "xhigh" | "max";
type SyncStatus = "ok" | "error" | "never";
type ClientRequestStatus = "never" | "pending" | "ok" | "error";

type Provider = {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
  modelCount: number;
  enabled: boolean;
  hasApiKey: boolean;
  modelFetchedAt: string;
  lastTestAt?: string;
  lastTestStatus?: SyncStatus;
  lastLatencyMs?: number;
  lastError?: string;
  clientKeyCount?: number;
};

type ClientKey = {
  id: string;
  name: string;
  providerId: string;
  providerName: string;
  reasoningLevel: ReasoningLevel;
  createdAt: string;
  enabled: boolean;
  hasSecret?: boolean;
};

type GatewaySettings = {
  forcedLevel: ReasoningLevel;
  defaultProvider: string;
  reasoningLevels?: ReasoningLevel[];
};

type GatewayStatus = {
  lastClientRequestAt?: string;
  lastClientRequestStatus?: ClientRequestStatus;
  lastClientRequestModel?: string;
};

type SyncProgress = {
  current: number;
  total: number;
  providerId: string;
  providerName: string;
};

type DesktopSettings = {
  language: Language;
  autoLaunch: boolean;
  startMinimized: boolean;
  closeToTray: boolean;
  loginItem?: boolean;
};

type ModalState =
  | { kind: "provider"; provider?: Provider }
  | { kind: "key"; key?: ClientKey }
  | { kind: "key-result"; secret: string }
  | null;

type ToastTone = "success" | "error" | "info";
type ToastState = { message: string; tone: ToastTone } | null;
type ConfirmTone = "primary" | "warning" | "danger";
type ConfirmDialogOptions = {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  tone?: ConfirmTone;
  icon?: string;
};
type ConfirmDialogState = ConfirmDialogOptions | null;

const levels: ReasoningLevel[] = ["low", "medium", "high", "xhigh", "max"];

const iconPaths: Record<string, ReactNode> = {
  spark: <path d="m12 3 1.7 6.3L20 11l-6.3 1.7L12 19l-1.7-6.3L4 11l6.3-1.7z" />,
  grid: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
  route: <><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="M8.5 6h4a5 5 0 0 1 5 5v4.5" /><path d="M15.5 18h-4a5 5 0 0 1-5-5V8.5" /></>,
  layers: <><path d="m12 3 9 5-9 5-9-5z" /><path d="m3 12 9 5 9-5" /><path d="m3 16 9 5 9-5" /></>,
  key: <><circle cx="8" cy="15" r="4" /><path d="m11 12 8-8 3 3-2 2 2 2-3 3-2-2-3 3" /></>,
  settings: <><circle cx="12" cy="12" r="3.5" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-1.8 1.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-2.6V20a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1-1.8-1.8.1-.1A1.7 1.7 0 0 0 8 15a1.7 1.7 0 0 0-1.6-1H6v-2.6h.4a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1 1.8-1.8.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.6V5h2.6v.4a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1 1.8 1.8-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2V14h-.2a1.7 1.7 0 0 0-1.6 1Z" /></>,
  folder: <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H10l2 2h6.5A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z" />,
  refresh: <><path d="M20 11a8 8 0 0 0-14.7-4L3 10" /><path d="M3 5v5h5" /><path d="M4 13a8 8 0 0 0 14.7 4L21 14" /><path d="M21 19v-5h-5" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  edit: <><path d="m4 16-.8 4.8L8 20l11-11-4-4z" /><path d="m13.5 6.5 4 4" /></>,
  trash: <><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></>,
  power: <><path d="M12 3v9" /><path d="M6.4 5.7a8 8 0 1 0 11.2 0" /></>,
  check: <path d="m5 12 4.5 4.5L19 7" />,
  shield: <><path d="M12 3 20 6v5c0 5.2-3.4 8.5-8 10-4.6-1.5-8-4.8-8-10V6z" /><path d="m8.5 12 2.3 2.3 4.8-5" /></>,
  lock: <><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
  monitor: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>,
  copy: <><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
  search: <><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 5 5" /></>,
  arrow: <><path d="M5 12h13" /><path d="m13 6 6 6-6 6" /></>,
  external: <><path d="M14 5h5v5" /><path d="m19 5-8 8" /><path d="M18 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 10v6M12 7.5v.1" /></>,
};

function Icon({ name, size = 17 }: { name: string; size?: number }) {
  return <svg className="icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">{iconPaths[name] ?? iconPaths.spark}</svg>;
}

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
  return String(level || "high").toUpperCase();
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : name.slice(0, 2)).toUpperCase() || "CG";
}

export default function App() {
  const [language, setLanguage] = useState<Language>(() => (localStorage.getItem("cherry-language") as Language) || "zh");
  const [view, setView] = useState<View>("overview");
  const [providers, setProviders] = useState<Provider[]>([]);
  const [keys, setKeys] = useState<ClientKey[]>([]);
  const [settings, setSettings] = useState<GatewaySettings>({ forcedLevel: "high", defaultProvider: "" });
  const [settingsDraftLevel, setSettingsDraftLevel] = useState<ReasoningLevel>("high");
  const [desktop, setDesktop] = useState<DesktopSettings>({ language: "zh", autoLaunch: false, startMinimized: false, closeToTray: true });
  const [gatewayPort, setGatewayPort] = useState(27891);
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
  const hasLoadedOnce = useRef(false);
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
    let restarted = false;
    let resetPort: number | undefined;
    if (!silent && hasLoadedOnce.current && window.desktop?.resetGateway) {
      setGatewayResetting(true);
      try {
        const result = await window.desktop.resetGateway();
        restarted = result.ok;
        resetPort = result.port;
        applyGatewayInfo(result);
      } catch (error) {
        showToast(`网关重置失败 / Gateway restart failed：${error instanceof Error ? error.message : String(error)}`, "error");
      }
    }
    try {
      if (!hasLoadedOnce.current && window.desktop?.getGatewayInfo) applyGatewayInfo(await window.desktop.getGatewayInfo());
      const [providerData, keyData, settingsData, statusData, desktopData] = await Promise.all([
        request<{ providers: Provider[] }>("/admin/api/providers"),
        request<{ keys: ClientKey[] }>("/admin/api/client-keys"),
        request<GatewaySettings>("/admin/api/settings"),
        request<GatewayStatus>("/admin/api/status"),
        window.desktop?.getSettings?.() ?? Promise.resolve(null),
      ]);
      setProviders(providerData.providers || []);
      setKeys(keyData.keys || []);
      const nextForcedLevel = settingsData.forcedLevel || "high";
      setSettings({ forcedLevel: nextForcedLevel, defaultProvider: settingsData.defaultProvider || "", reasoningLevels: settingsData.reasoningLevels });
      setSettingsDraftLevel(nextForcedLevel);
      setLastClientRequestAt(statusData.lastClientRequestAt || "");
      setLastClientRequestStatus(statusData.lastClientRequestStatus || "never");
      setLastClientRequestModel(statusData.lastClientRequestModel || "");
      if (desktopData) {
        setDesktop((current) => ({ ...current, ...desktopData }));
        if (!localStorage.getItem("cherry-language") && desktopData.language) setLanguage(desktopData.language);
      }
      if (restarted) showToast(`网关已重置，已切换到随机端口 ${resetPort || gatewayPort} / Gateway reset; switched to random port ${resetPort || gatewayPort}`, "success");
    } catch (error) {
      if (!silent) showToast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      if (!silent) setGatewayResetting(false);
      if (!silent) setLoading(false);
      hasLoadedOnce.current = true;
    }
  }, [applyGatewayInfo, showToast]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
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


  const providerById = useCallback((id: string) => providers.find((provider) => provider.id === id), [providers]);
  const totalModels = useMemo(() => providers.reduce((sum, provider) => sum + (provider.modelCount ?? provider.models.length), 0), [providers]);
  const activeKeys = useMemo(() => keys.filter((key) => key.enabled).length, [keys]);

  const navigate = (nextView: View) => {
    setView(nextView);
    document.querySelector(".main-scroll")?.scrollTo({ top: 0, behavior: "smooth" });
  };

  const isMac = useMemo(() => /Mac|iPhone|iPad/i.test(navigator.platform), []);
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable)) return;
      if (event.altKey || (isMac ? !event.metaKey : !event.ctrlKey)) return;
      const nextView: Record<string, View> = { "1": "overview", "2": "providers", "3": "models", "4": "keys" };
      if (!nextView[event.key]) return;
      event.preventDefault();
      navigate(nextView[event.key]);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isMac]);

  const changeDefaultReasoning = async (next: ReasoningLevel) => {
    const previous = settings.forcedLevel;
    if (next === previous || reasoningUpdating) return;
    setSettings((current) => ({ ...current, forcedLevel: next }));
    setSettingsDraftLevel(next);
    setReasoningUpdating(true);
    try {
      const result = await request<GatewaySettings>("/admin/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ forcedLevel: next, applyToExisting: false }) });
      const savedLevel = result.forcedLevel || next;
      setSettings((current) => ({ ...current, ...result, forcedLevel: savedLevel }));
      setSettingsDraftLevel(savedLevel);
      showToast(tr(`默认思考强度已设为 ${savedLevel.toUpperCase()}；已有客户端 Key 保持独立设置`, `Default reasoning is now ${savedLevel.toUpperCase()}; existing client keys keep their own levels`), "success");
    } catch (error) {
      setSettings((current) => ({ ...current, forcedLevel: previous }));
      setSettingsDraftLevel(previous);
      showToast(`${tr("思考强度更新失败", "Could not update reasoning level")}：${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      setReasoningUpdating(false);
    }
  };

  const changeLanguage = async (next: Language) => {
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
      title: tr("重置网关", "Reset gateway"),
      message: tr("旧的本地 API 地址会失效，网关将切换到一个随机端口；线路、模型和客户端 Key 会保留。", "The old local API address will stop working and the gateway will switch to a random port. Routes, models, and client keys will be kept."),
      confirmLabel: tr("重置并随机端口", "Reset and randomize"),
      cancelLabel: tr("取消", "Cancel"),
      tone: "warning",
      icon: "refresh",
    });
    if (!confirmed) return;
    await load();
  };

  const syncProvider = async (id: string, quiet = false) => {
    setSyncing(id);
    try {
      const result = await request<{ models: string[]; latencyMs: number }>(`/admin/api/providers/${encodeURIComponent(id)}/test`, { method: "POST" });
      setSyncFailures((current) => current.filter((providerId) => providerId !== id));
      await load(true);
      if (!quiet) showToast(`${tr("线路可用", "Route ready")} · ${result.latencyMs}ms · ${result.models?.length || 0} ${tr("个模型", "models")}`, "success");
      return result;
    } catch (error) {
      setSyncFailures((current) => current.includes(id) ? current : [...current, id]);
      await load(true);
      if (!quiet) showToast(`${tr("同步失败", "Sync failed")}：${error instanceof Error ? error.message : String(error)}`, "error");
      throw error;
    } finally {
      setSyncing(null);
    }
  };

  const syncAll = async (onlyIds?: string[]) => {
    const targets = onlyIds?.length ? providers.filter((provider) => onlyIds.includes(provider.id)) : providers;
    if (!targets.length) return showToast(tr("还没有可同步的线路", "There are no routes to sync"), "info");
    setSyncing("all");
    setSyncFailures([]);
    let success = 0;
    const failures: string[] = [];
    for (const [index, provider] of targets.entries()) {
      setSyncProgress({ current: index + 1, total: targets.length, providerId: provider.id, providerName: provider.name || provider.id });
      try {
        await request(`/admin/api/providers/${encodeURIComponent(provider.id)}/test`, { method: "POST" });
        success += 1;
      } catch {
        failures.push(provider.id);
      }
    }
    await load(true);
    setSyncing(null);
    setSyncProgress(null);
    setSyncFailures(failures);
    showToast(`${tr("已同步", "Synced")} ${success}/${targets.length}`, success === targets.length ? "success" : "info");
  };

  const runQuickSync = () => {
    if (syncing === "all" || gatewayResetting) return;
    navigate("models");
    void syncAll();
  };

  const handleProviderSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const id = String(form.get("id") || "").trim();
    const isEditing = modal?.kind === "provider" && Boolean(modal.provider);
    try {
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
    const payload = { name: String(form.get("name") || "").trim(), providerId: String(form.get("providerId") || ""), reasoningLevel: String(form.get("reasoningLevel") || "high") };
    try {
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
      await request(`/admin/api/providers/${encodeURIComponent(id)}`, { method: "DELETE" });
      await load(true);
      showToast(tr("线路已删除", "Route deleted"), "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const toggleKey = async (key: ClientKey) => {
    try {
      await request(`/admin/api/client-keys/${encodeURIComponent(key.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: !key.enabled }) });
      await load(true);
      showToast(key.enabled ? tr("Key 已停用", "Key disabled") : tr("Key 已启用", "Key enabled"), "success");
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
    const level = settings.forcedLevel.toUpperCase();
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
      const next = await request<GatewaySettings>("/admin/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ forcedLevel: settings.forcedLevel, applyToExisting: true }) });
      const savedLevel = next.forcedLevel || settings.forcedLevel;
      setSettings((current) => ({ ...current, ...next, forcedLevel: savedLevel }));
      setSettingsDraftLevel(savedLevel);
      await load(true);
      showToast(tr(`现有客户端 Key 已统一为 ${savedLevel.toUpperCase()}`, `Existing client keys are now ${savedLevel.toUpperCase()}`), "success");
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
      const result = await request<{ key: string }>(`/admin/api/client-keys/${encodeURIComponent(key.id)}/secret`);
      await copy(result.key);
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
      const result = await request<{ modelCount: number }>(`/admin/api/client-keys/${encodeURIComponent(key.id)}/test`, { method: "POST" });
      await load(true);
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
    settings: ["设置", "Settings"],
  };

  const renderView = () => {
    switch (view) {
      case "providers": return <ProvidersView />;
      case "models": return <ModelsView />;
      case "keys": return <KeysView />;
      case "settings": return <SettingsView />;
      default: return <OverviewView />;
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
      <div className="route-facts"><span><b>{modelCount}</b>{tr("个模型", "models")}</span><span><b>{boundKeys}</b>{tr("个客户端 Key", "client keys")}</span><span>{provider.lastLatencyMs ? `${provider.lastLatencyMs}ms` : formatDate(provider.modelFetchedAt, language)}</span></div>
      {showActions && <div className="route-actions">{showSync && <button className="button button-secondary button-small" onClick={() => void syncProvider(provider.id)} disabled={syncing === provider.id || syncing === "all"}><Icon name="refresh" size={14} />{syncing === provider.id ? tr("同步中", "Syncing") : tr("同步此线路", "Sync this route")}</button>}<button className="icon-button" onClick={() => setModal({ kind: "provider", provider })} title={tr("编辑线路", "Edit route")} aria-label={tr("编辑线路", "Edit route")}><Icon name="edit" size={15} /></button><button className="icon-button danger" onClick={() => void deleteProvider(provider.id)} title={tr("删除线路", "Delete route")} aria-label={tr("删除线路", "Delete route")}><Icon name="trash" size={15} /></button></div>}
      {provider.lastTestStatus === "error" && provider.lastError && <div className="route-error" title={provider.lastError}><Icon name="shield" size={13} /><span><strong>{tr("检测失败", "Sync failed")}</strong>{errorSummary(provider.lastError)}</span><button className="text-button" onClick={() => void copyErrorDetails(provider.lastError || "")}>{tr("复制详情", "Copy details")}</button></div>}
    </article>;
  }

  function OverviewView() {
    const hasSuccessfulClientRequest = activeKeys > 0 && lastClientRequestStatus === "ok";
    const firstActiveKey = keys.find((key) => key.enabled);
    const nextStep = !providers.length
      ? { label: tr("添加第一条线路", "Add your first route"), action: () => setModal({ kind: "provider" }), icon: "plus" }
      : !totalModels
        ? { label: tr("同步模型目录", "Sync model catalog"), action: () => void syncAll(), icon: "refresh" }
        : !keys.length
          ? { label: tr("生成客户端 Key", "Create client key"), action: () => setModal({ kind: "key" }), icon: "key" }
          : !hasSuccessfulClientRequest && firstActiveKey
            ? { label: tr("测试本地连接", "Test local connection"), action: () => void testClientKey(firstActiveKey), icon: "check" }
            : { label: tr("管理客户端 Key", "Manage client keys"), action: () => navigate("keys"), icon: "key" };
    const checklist = [
      { done: providers.length > 0, label: tr("添加一条中转站线路", "Add an upstream route"), action: providers.length ? () => navigate("providers") : () => setModal({ kind: "provider" }) },
      { done: totalModels > 0, label: tr("同步上游模型目录", "Sync the upstream model catalog"), action: totalModels > 0 ? () => navigate("models") : runQuickSync },
      { done: keys.length > 0, label: tr("生成一个客户端 Key", "Create a client key"), action: keys.length ? () => navigate("keys") : providers.length ? () => setModal({ kind: "key" }) : () => navigate("providers") },
      { done: hasSuccessfulClientRequest, label: tr("在 Cherry 中成功使用客户端 Key", "Complete a successful Cherry client request"), action: hasSuccessfulClientRequest ? () => navigate("keys") : firstActiveKey ? () => void testClientKey(firstActiveKey) : () => navigate("keys") },
    ];
    const boundRoutes = keys.filter((key) => key.enabled).map((key) => ({ key, provider: providerById(key.providerId) })).filter((item) => item.provider);
    return <>
      <section className="welcome-panel">
        <div className="welcome-copy"><div className="eyebrow accent"><span className="live-pulse" />{tr("本地控制中心", "LOCAL CONTROL CENTER")}</div><h2>{tr("把上游线路，变成", "One local gateway for your ")}<em>{tr("一个好用的本地网关", "upstream routes")}</em></h2><p>{tr("在这里管理中转站、模型目录和客户端 Key。上游密钥只留在本机，Cherry 只需要连接一个本地地址。", "Manage routes, model catalogs, and client keys here. Upstream secrets stay on this PC while Cherry connects to one local endpoint.")}</p><div className="welcome-actions"><button className="button button-primary" onClick={nextStep.action}><Icon name={nextStep.icon} size={15} />{nextStep.label}</button></div></div>
        <div className="welcome-visual"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="core-orb"><Icon name="route" size={34} /></div><span className="visual-caption">{tr("本地网关", "LOCAL RELAY")}</span><strong>127.0.0.1</strong><small>PORT {gatewayPort}</small></div>
      </section>
      <div className="metric-grid"><Metric icon="route" tone="purple" value={String(providers.length)} label={tr("中转站线路", "Upstream routes")} note={tr("可绑定客户端 Key", "Ready for key binding")} /><Metric icon="layers" tone="blue" value={String(totalModels)} label={tr("已同步模型", "Synced models")} note={tr("来自上游目录", "From upstream catalogs")} /><Metric icon="key" tone="green" value={String(activeKeys)} label={tr("有效客户端 Key", "Active client keys")} note={tr("仅显示本地凭证", "Local credentials only")} /><Metric icon="spark" tone="amber" value={levelLabel(settings.forcedLevel)} label={tr("默认思考强度", "Default reasoning")} note={tr("真实写入转发请求", "Written into requests")} /></div>
      <div className="overview-columns"><section className="panel checklist-panel"><PanelHeading kicker={tr("QUICK START", "QUICK START")} title={tr("四步完成配置", "Finish setup in four steps")} action={<span className="progress-label">{checklist.filter((item) => item.done).length}/4</span>} /><div className="checklist">{checklist.map((item) => <button className={`checklist-row ${item.done ? "done" : ""}`} key={item.label} onClick={item.action}><span className="check-circle"><Icon name="check" size={12} /></span><span>{item.label}</span><span className="checklist-action-label">{item.done ? tr("查看", "View") : tr("执行", "Run")}</span><Icon name="arrow" size={15} /></button>)}</div><div className={`checklist-hint status-${lastClientRequestStatus}`}>{lastClientRequestStatus === "ok" ? <><Icon name="check" size={13} />{tr(`最近一次转发成功${lastClientRequestModel ? ` · ${lastClientRequestModel}` : ""} · ${formatDate(lastClientRequestAt, language)}`, `Last forwarded request succeeded${lastClientRequestModel ? ` · ${lastClientRequestModel}` : ""} · ${formatDate(lastClientRequestAt, language)}`)}</> : lastClientRequestStatus === "pending" ? <><Icon name="refresh" size={13} />{tr("正在等待上游响应…", "Waiting for the upstream response…")}</> : lastClientRequestStatus === "error" ? <><Icon name="shield" size={13} />{tr("最近一次客户端请求失败，请检查线路状态。", "The latest client request failed; check the route status.")}</> : <><Icon name="info" size={13} />{tr("尚未检测到成功的客户端转发；完成一次 Cherry 请求后这里会变为已完成。", "No successful client request yet; this step completes after Cherry makes one request.")}</>}</div></section><section className="panel default-panel"><PanelHeading kicker={tr("客户端路由", "CLIENT ROUTING")} title={tr("当前 Key 路由", "Current key routing")} description={tr("每个客户端 Key 只绑定一条线路；这里显示有效 Key 的实际去向。", "Each client key binds to one route; this shows where active keys actually go.")} /><div className="routing-summary">{boundRoutes.length ? <div className="routing-list">{boundRoutes.slice(0, 3).map(({ key, provider }) => <div className="routing-row" key={key.id}><div className="routing-icon"><Icon name="key" size={17} /></div><div><strong>{key.name}</strong><code>{provider?.name || key.providerId}</code></div><span className="level-chip">{levelLabel(key.reasoningLevel)}</span></div>)}{boundRoutes.length > 3 && <small className="routing-more">+{boundRoutes.length - 3} {tr("个客户端 Key", "more client keys")}</small>}</div> : <div className="routing-empty"><Icon name="route" size={18} /><span>{tr("生成客户端 Key 后，这里会显示它绑定的线路。", "Create a client key to see its bound route here.")}</span></div>}</div><div className="safe-note"><Icon name="shield" size={14} /><span>{tr("上游 Key 加密保存在本机，客户端永远看不到。", "Upstream keys are encrypted locally and never shown to clients.")}</span></div></section></div>
      <section className="section-block"><PanelHeading kicker={tr("线路概览", "ROUTE SNAPSHOT")} title={tr("线路概览", "Route snapshot")} description={tr("这里只显示状态摘要；完整模型列表统一放在模型目录。", "Only status appears here; the full catalog lives in Models.")} action={<button className="text-button" onClick={() => navigate("providers")}>{tr("管理线路", "Manage routes")} <Icon name="arrow" size={14} /></button>} />{providers.length ? <div className="route-list compact-route-list">{providers.slice(0, 3).map((provider) => <RouteCard provider={provider} compact key={provider.id} />)}</div> : <EmptyState icon="route" title={tr("还没有中转站线路", "No upstream routes yet")} description={tr("添加第一条线路后，点击同步即可读取模型。", "Add your first route, then sync to read its models.")} action={<button className="button button-primary" onClick={() => setModal({ kind: "provider" })}>{tr("添加第一条线路", "Add first route")}</button>} />}</section>
    </>;
  }

  function ProvidersView() {
    return <section className="page-view"><PageIntro kicker={tr("中转站线路", "UPSTREAM ROUTES")} description={tr("一条线路保存一个上游地址和 Key；创建客户端 Key 时必须绑定其中一条。", "Each route stores one upstream URL and key. Every client key must bind to one route.")} action={<button className="button button-primary" onClick={() => setModal({ kind: "provider" })}><Icon name="plus" size={15} />{tr("添加线路", "Add route")}</button>} /><div className="info-banner"><div className="banner-icon"><Icon name="shield" size={17} /></div><div><strong>{tr("先检测，再绑定", "Test before binding")}</strong><span>{tr("模型目录是统一同步中心；新增线路会自动检测，后续请在模型目录中同步全部或单条线路。", "The Model Catalog is the sync center; new routes are tested automatically, then sync all or one route there.")}</span></div><span className="banner-rule">{tr("一 Key 一线路", "1 key · 1 route")}</span></div>{providers.length ? <div className="route-list">{providers.map((provider) => <RouteCard provider={provider} key={provider.id} showSync={false} />)}</div> : <EmptyState icon="route" title={tr("还没有中转站线路", "No upstream routes yet")} description={tr("添加线路后才能生成绑定它的客户端 Key。", "Add a route before creating a bound client key.")} action={<button className="button button-primary" onClick={() => setModal({ kind: "provider" })}>{tr("添加中转站线路", "Add upstream route")}</button>} />}</section>;
  }

  function ModelsView() {
    const groups = providers.map((provider) => {
      const models = (provider.models || []).filter((model) => !modelQuery.trim() || model.toLowerCase().includes(modelQuery.trim().toLowerCase()));
      return { provider, models };
    }).filter(({ provider }) => modelFilter === "all" || provider.id === modelFilter);
    const visibleCount = groups.reduce((sum, group) => sum + group.models.length, 0);
    const failedNames = syncFailures.map((id) => providers.find((provider) => provider.id === id)?.name || id);
    return <section className="page-view"><PageIntro kicker={tr("模型目录", "MODEL CATALOG")} description={tr("按中转站分组显示上游模型，名称再长也不会堆在一张卡片里。", "Models are grouped by route so long names stay readable.")} action={<button className="button button-secondary" onClick={() => void syncAll()} disabled={syncing === "all"}><Icon name="refresh" size={15} />{syncing === "all" ? tr("同步中", "Syncing") : tr("同步全部", "Sync all")}</button>} />{syncProgress && <div className="sync-progress-banner" role="status"><Icon name="refresh" size={15} /><div><strong>{tr(`正在同步 ${syncProgress.current}/${syncProgress.total}`, `Syncing ${syncProgress.current}/${syncProgress.total}`)}</strong><span>{syncProgress.providerName}</span></div><div className="sync-progress-track"><span style={{ width: `${Math.round((syncProgress.current / syncProgress.total) * 100)}%` }} /></div></div>}{!syncProgress && syncFailures.length > 0 && <div className="sync-result-banner" role="status"><Icon name="shield" size={15} /><div><strong>{tr(`有 ${syncFailures.length} 条线路同步失败`, `${syncFailures.length} route(s) failed`)}</strong><span>{failedNames.join("、")}</span></div><button className="button button-secondary button-small" onClick={() => void syncAll(syncFailures)} disabled={syncing === "all"}><Icon name="refresh" size={13} />{tr("重试失败线路", "Retry failed")}</button></div>}<div className="catalog-toolbar"><label className="select-control"><span>{tr("线路", "Route")}</span><select value={modelFilter} onChange={(event) => setModelFilter(event.target.value)}><option value="all">{tr("全部线路", "All routes")}</option>{providers.map((provider) => <option value={provider.id} key={provider.id}>{provider.name || provider.id}</option>)}</select></label><label className="search-control"><Icon name="search" size={15} /><input value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} placeholder={tr("搜索模型名称", "Search model name")} /></label><span className="result-count">{visibleCount} {tr("个模型", "models")}</span></div>{groups.length ? <div className="model-groups">{groups.map(({ provider, models }) => <section className="model-group" key={provider.id}><header className="model-group-header"><div className="group-identity"><RouteAvatar provider={provider} /><div><strong>{provider.name || provider.id}</strong><code>{provider.id}</code></div></div><div className="group-summary"><span>{models.length} {tr("个匹配模型", "matching models")}</span><button className="icon-text-button" onClick={() => void syncProvider(provider.id)} disabled={syncing === provider.id}><Icon name="refresh" size={13} />{tr("同步", "Sync")}</button></div></header>{models.length ? <div className="model-grid">{models.map((model) => <article className="model-item" key={`${provider.id}:${model}`}><span className="model-mark"><Icon name="layers" size={14} /></span><code title={model}>{model}</code><span className="model-ready"><span className="status-dot" /></span></article>)}</div> : <div className="inline-empty">{tr("没有匹配模型；尝试清空搜索词，或先同步线路。", "No matching models. Clear the search or sync this route.")}</div>}</section>)}</div> : <EmptyState icon="layers" title={providers.length ? tr("没有匹配的模型", "No matching models") : tr("还没有模型目录", "No model catalog yet")} description={providers.length ? tr("换一个搜索词试试。", "Try another search term.") : tr("去中转站线路页添加线路并同步模型。", "Add and sync a route from the Upstream Routes page.")} action={providers.length ? undefined : <button className="button button-primary" onClick={() => navigate("providers")}>{tr("去添加线路", "Go to routes")}</button>} />}</section>;
  }

   function KeysView() {
     return <section className="page-view"><PageIntro kicker={tr("客户端凭证", "LOCAL ACCESS TOKENS")} description={tr("给 Cherry 或其他客户端使用的本地凭证。真实上游 Key 永远不会暴露。", "Local credentials for Cherry and other clients. Upstream keys never leave this gateway.")} action={<button className="button button-primary" onClick={() => setModal({ kind: "key" })} disabled={!providers.length}><Icon name="plus" size={15} />{tr("生成客户端 Key", "Create client key")}</button>} /><div className="key-banner"><div className="banner-icon"><Icon name="lock" size={17} /></div><div><strong>{tr("一个客户端 Key，只绑定一条线路", "One client key binds to one route")}</strong><span>{tr("创建时选择中转站线路和思考强度；之后每次请求都会按这个绑定转发。", "Choose a route and reasoning level at creation; every request follows that binding.")}</span></div><Icon name="shield" size={19} /></div><div className="key-toolbar"><span>{tr("本地访问凭证", "Local access credentials")} <small>{keys.length}</small></span><span>{tr("删除和停用都会立即生效", "Disable or delete takes effect immediately")}</span></div>{keys.length ? <div className="key-list">{keys.map((key) => <article className={`client-key-card ${key.enabled ? "" : "is-disabled"}`} key={key.id}><div className="key-card-head"><div className="key-symbol"><Icon name="key" size={17} /></div><div className="key-name"><strong>{key.name || tr("未命名客户端", "Unnamed client")}</strong><code>cg_••••••••••••</code></div><div className="key-quick-actions">{key.hasSecret && <button className="icon-text-button quick-copy-button" onClick={() => void copyClientKey(key)} disabled={copyingKeyId === key.id} title={tr("复制客户端 Key", "Copy client key")}><Icon name="copy" size={13} />{copyingKeyId === key.id ? tr("复制中", "Copying") : tr("复制 Key", "Copy key")}</button>}<button className="icon-text-button quick-copy-button" onClick={() => void copyApiAddress()} disabled={gatewayResetting} title={tr("复制本地 API 地址", "Copy local API URL")}><Icon name="copy" size={13} />{tr("复制地址", "Copy URL")}</button>{!key.hasSecret && <button className="icon-text-button quick-copy-button regenerate-key-button" onClick={() => void rotateClientKey(key)} title={tr("重新生成并替换旧 Key", "Regenerate and replace the old key")}><Icon name="refresh" size={13} />{tr("重新生成", "Regenerate")}</button>}</div><span className={`key-status ${key.enabled ? "active" : "disabled"}`}><span className="status-dot" />{key.enabled ? tr("有效", "Active") : tr("已停用", "Disabled")}</span></div><div className="key-card-details"><div><small>{tr("绑定线路", "Bound route")}</small><strong><Icon name="route" size={13} />{key.providerName || tr("未绑定", "Unbound")}</strong></div><div><small>{tr("思考强度", "Reasoning")}</small><b className="level-chip">{levelLabel(key.reasoningLevel)}</b></div><div><small>{tr("创建时间", "Created")}</small><span>{key.createdAt}</span></div></div><div className="key-card-actions"><button className="icon-text-button" onClick={() => void testClientKey(key)} disabled={!key.enabled || testingKeyId === key.id}><Icon name="check" size={14} />{testingKeyId === key.id ? tr("测试中", "Testing") : tr("测试连接", "Test connection")}</button><button className="icon-text-button" onClick={() => setModal({ kind: "key", key })}><Icon name="edit" size={14} />{tr("编辑", "Edit")}</button><button className="icon-text-button" onClick={() => void toggleKey(key)}><Icon name="power" size={14} />{key.enabled ? tr("停用", "Disable") : tr("启用", "Enable")}</button><button className="icon-text-button danger-text" onClick={() => void deleteKey(key)}><Icon name="trash" size={14} />{tr("删除", "Delete")}</button></div></article>)}</div> : <EmptyState icon="key" title={tr("还没有客户端 Key", "No client keys yet")} description={providers.length ? tr("生成一个绑定到线路的客户端 Key，填入 Cherry 的 API Key 位置。", "Create a route-bound key and put it in Cherry's API key field.") : tr("请先添加至少一条中转站线路。", "Add at least one upstream route first.")} action={<button className="button button-primary" onClick={() => providers.length ? setModal({ kind: "key" }) : navigate("providers")}>{providers.length ? tr("生成第一个 Key", "Create first key") : tr("先添加线路", "Add a route first")}</button>} />}</section>;
   }

   function SettingsView() {
     return <section className="page-view"><PageIntro kicker={tr("设置", "PREFERENCES")} description={tr("控制请求策略、桌面行为和界面语言；所有设置修改后立即生效。", "Control request policy, desktop behavior, and language; every change applies immediately.")} action={undefined} /><div className="settings-layout"><article className="settings-card"><SettingsHeading icon="spark" title={tr("请求策略", "Request policy")} description={tr("决定新建 Key 的默认思考强度，也可以单独编辑每个客户端 Key。", "Set the default reasoning level for new keys; each client key can override it.")} /><div className="setting-line"><div><strong>{tr("默认思考强度", "Default reasoning level")}</strong><small>{tr("选择后立即写入网关；已有 Key 保持自己的等级。", "Saved immediately; existing keys keep their own level.")}</small></div><select name="forcedLevel" value={settings.forcedLevel} onChange={(event) => void changeDefaultReasoning(event.target.value as ReasoningLevel)} disabled={reasoningUpdating || gatewayResetting}>{levels.map((level) => <option value={level} key={level}>{level.toUpperCase()}</option>)}</select></div><button type="button" className="button button-secondary full-width" onClick={() => void applyReasoningToExisting()} disabled={reasoningUpdating || gatewayResetting || !keys.length}><Icon name="spark" size={15} />{tr(`将 ${settings.forcedLevel.toUpperCase()} 应用到 ${keys.length} 个已有 Key`, `Apply ${settings.forcedLevel.toUpperCase()} to ${keys.length} existing key(s)`)}</button><div className="settings-note"><Icon name="key" size={14} /><span>{tr("线路不再作为设置项：每个客户端 Key 创建时必须绑定且只绑定一条中转站线路。", "Route selection is not a preference: every client key must bind to exactly one upstream route when created.")}</span></div></article><article className="settings-card"><SettingsHeading icon="monitor" title={tr("桌面行为", "Desktop behavior")} description={tr("网关会随桌面程序一起运行，并可在托盘中保持后台工作。", "The gateway runs with the desktop app and can stay in the tray.")} /><SettingCheck name="autoLaunch" checked={desktop.autoLaunch} onChange={(checked) => void updateDesktopSetting({ autoLaunch: checked })} title={tr("开机自动启动", "Start with Windows")} description={tr("登录 Windows 后自动运行网关。", "Start the gateway when you sign in to Windows.")} /><SettingCheck name="startMinimized" checked={desktop.startMinimized} onChange={(checked) => void updateDesktopSetting({ startMinimized: checked })} title={tr("启动后隐藏到托盘", "Start hidden in tray")} description={tr("开机启动时不弹出主窗口。", "Do not show the main window on startup.")} /><SettingCheck name="closeToTray" checked={desktop.closeToTray} onChange={(checked) => void updateDesktopSetting({ closeToTray: checked })} title={tr("关闭窗口时隐藏到托盘", "Close to tray")} description={tr("点击右上角关闭只隐藏窗口，网关继续工作。", "Closing the window hides it while the gateway keeps working.")} /></article><article className="settings-card compact-settings"><SettingsHeading icon="globe" title={tr("界面语言", "Interface language")} description={tr("切换后界面和托盘菜单立即更新。", "Updates the interface and tray menu immediately.")} /><div className="language-options"><button type="button" className={language === "zh" ? "selected" : ""} onClick={() => void changeLanguage("zh")}>简体中文</button><button type="button" className={language === "en" ? "selected" : ""} onClick={() => void changeLanguage("en")}>English</button></div></article><article className="settings-card compact-settings"><SettingsHeading icon="shield" title={tr("安全与连接", "Security & connection")} description={tr("上游密钥使用本机加密保存；Cherry 只连接下面的本地地址。", "Upstream keys are encrypted locally; Cherry only connects to this local address.")} /><div className="connection-box"><div><small>{tr("本地 API 地址", "Local API address")}</small><code>{apiBase}</code></div><button type="button" className="icon-text-button" onClick={() => void copyApiAddress()}><Icon name="copy" size={14} />{tr("复制", "Copy")}</button></div><div className="connection-note"><Icon name="refresh" size={13} /><span>{tr("“重置网关”会停止旧监听器并切换到新的随机端口，用来避开端口冲突；线路、模型和客户端 Key 都会保留。", "Reset gateway stops the old listener and switches to a random port to avoid conflicts; routes, models, and client keys are preserved.")}</span></div><button type="button" className="button button-secondary full-width" onClick={openDataFolder}><Icon name="folder" size={15} />{tr("打开数据目录", "Open data folder")}</button></article></div></section>;
   }

  function Modal() {
    if (!modal) return null;
    const close = () => setModal(null);
    return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><div className="modal" role="dialog" aria-modal="true"><button className="modal-close" onClick={close} aria-label={tr("关闭", "Close")}>×</button>{modal.kind === "provider" && <><div className="modal-icon"><Icon name="route" size={19} /></div><div className="modal-kicker">{modal.provider ? tr("EDIT UPSTREAM ROUTE", "EDIT UPSTREAM ROUTE") : tr("NEW UPSTREAM ROUTE", "NEW UPSTREAM ROUTE")}</div><h2>{modal.provider ? tr("编辑中转站线路", "Edit upstream route") : tr("添加中转站线路", "Add upstream route")}</h2><p>{tr("保存后会立即检测 /v1/models；上游 Key 只会加密保存在本机。", "Saving will test /v1/models. The upstream key is encrypted and kept on this PC.")}</p><form onSubmit={handleProviderSubmit}><Field label={tr("线路代号", "Route ID")} name="id" defaultValue={modal.provider?.id || ""} placeholder="router-luna" readOnly={Boolean(modal.provider)} required /><Field label={tr("线路名称", "Route name")} name="name" defaultValue={modal.provider?.name || ""} placeholder={tr("例如 我的 Luna 线路", "e.g. My Luna route")} required /><Field label="API URL" name="baseUrl" type="url" defaultValue={modal.provider?.baseUrl || ""} placeholder="https://example.com" required /><Field label={modal.provider ? tr("中转站 Key（留空保持不变）", "Upstream key (blank keeps it)") : tr("中转站 Key", "Upstream key")} name="apiKey" type="password" placeholder="sk-..." /><div className="form-tip"><Icon name="shield" size={14} />{tr("模型不手填，检测成功后自动读取。", "Models are read automatically after a successful test.")}</div><ModalActions cancel={tr("取消", "Cancel")} submit={modal.provider ? tr("保存并同步", "Save & sync") : tr("添加并同步", "Add & sync")} /></form></>}{modal.kind === "key" && <><div className="modal-icon"><Icon name="key" size={19} /></div><div className="modal-kicker">{modal.key ? tr("EDIT CLIENT KEY", "EDIT CLIENT KEY") : tr("NEW CLIENT KEY", "NEW CLIENT KEY")}</div><h2>{modal.key ? tr("编辑客户端 Key", "Edit client key") : tr("生成客户端 Key", "Create client key")}</h2><p>{tr("客户端 Key 是给 Cherry 使用的外壳；它只绑定一条中转站线路。", "This client key is the shell Cherry uses and binds to one upstream route.")}</p><form onSubmit={handleKeySubmit}><Field label={tr("Key 名称", "Key name")} name="name" defaultValue={modal.key?.name || tr("Cherry 客户端", "Cherry client")} placeholder={tr("例如 Cherry 主账号", "e.g. Cherry primary")} required /><label className="field-label">{tr("绑定中转站线路", "Bind upstream route")}<select className="field-control" name="providerId" defaultValue={modal.key?.providerId || providers[0]?.id || ""} disabled={!providers.length} required><option value="">{tr("请选择线路", "Select a route")}</option>{providers.map((provider) => <option value={provider.id} key={provider.id}>{provider.name || provider.id} · {provider.id}</option>)}</select></label><label className="field-label">{tr("思考强度", "Reasoning level")}<select className="field-control" name="reasoningLevel" defaultValue={modal.key?.reasoningLevel || settings.forcedLevel || "high"}>{levels.map((level) => <option value={level} key={level}>{level.toUpperCase()}</option>)}</select><small className="field-help">{tr("保存后会随每次请求发送给上游，不是只改界面标签。", "This is sent upstream with every request; it is not a visual-only label.")}</small></label>{!providers.length && <div className="form-warning"><Icon name="route" size={14} />{tr("请先添加一条中转站线路，再生成客户端 Key。", "Add an upstream route before creating a client key.")}</div>}<ModalActions cancel={tr("取消", "Cancel")} submit={modal.key ? tr("保存修改", "Save changes") : tr("生成 Key", "Create key")} disabled={!providers.length} /></form></>}{modal.kind === "key-result" && <><div className="modal-icon success-icon"><Icon name="check" size={20} /></div><div className="modal-kicker">{tr("CLIENT KEY READY", "CLIENT KEY READY")}</div><h2>{tr("客户端 Key 已准备好", "Client key ready")}</h2><p>{tr("它已在本机加密保存；此窗口关闭后，仍可在客户端 Key 卡片中随时复制。上游中转站 Key 不会显示。", "It is encrypted on this PC and can still be copied from the client key card after this window closes. Upstream keys are never shown.")}</p><div className="secret-box"><code>{modal.secret}</code><button className="icon-text-button" onClick={() => void copySecret(modal.secret)}><Icon name="copy" size={14} />{tr("复制", "Copy")}</button></div><div className="copy-feedback" role="status"><Icon name={secretCopied ? "check" : "shield"} size={13} />{secretCopied ? tr("已复制；本地 API 地址可在上方或卡片中复制。", "Copied; the local API URL is available above or on the card.") : tr("可以现在复制，也可以关闭窗口后从卡片复制。", "Copy is not confirmed; you can select the key and press Ctrl+C manually.")}</div><div className="copy-guide"><span>1</span>{tr(`API 地址：${apiBase}`, `API URL: ${apiBase}`)}</div><div className="copy-guide"><span>2</span>{tr("API Key：粘贴上面的客户端 Key", "API key: paste the client key above")}</div><div className="form-actions"><button className="button button-primary" onClick={close}>{tr("我已保存，完成", "I've saved it")}</button></div></>}</div></div>;
  }

  return <div className={`app-shell locale-${language}`}><aside className="sidebar"><div className="brand"><div className="brand-mark"><Icon name="spark" size={18} /></div><div><strong>Cherry</strong><small>GATEWAY</small></div><span className="brand-tag">{language === "zh" ? "本地" : "LOCAL"}</span></div><div className="workspace-card"><span className="workspace-icon"><Icon name="route" size={15} /></span><div><strong>{tr("本地网关", "Local gateway")}</strong><small>Cherry Relay</small></div><Icon name="arrow" size={13} /></div><div className="nav-label">{tr("工作台", "WORKSPACE")}</div><NavItem icon="grid" label={tr("总览", "Overview")} active={view === "overview"} onClick={() => navigate("overview")} shortcut={isMac ? "⌘1" : "Ctrl+1"} /><NavItem icon="route" label={tr("中转站线路", "Routes")} active={view === "providers"} onClick={() => navigate("providers")} shortcut={isMac ? "⌘2" : "Ctrl+2"} /><NavItem icon="layers" label={tr("模型目录", "Models")} active={view === "models"} onClick={() => navigate("models")} shortcut={isMac ? "⌘3" : "Ctrl+3"} /><NavItem icon="key" label={tr("客户端 Key", "Client keys")} active={view === "keys"} onClick={() => navigate("keys")} shortcut={isMac ? "⌘4" : "Ctrl+4"} /><div className="nav-label nav-spaced">{tr("系统", "SYSTEM")}</div><NavItem icon="settings" label={tr("设置", "Settings")} active={view === "settings"} onClick={() => navigate("settings")} /><div className="sidebar-grow" /><div className="sidebar-status"><div className="status-line"><span className={`status-dot ${gatewayResetting ? "is-restarting" : ""}`} /><strong>{gatewayResetting ? tr("网关重启中…", "Gateway restarting…") : tr("网关在线", "Gateway online")}</strong><span>{gatewayResetting ? "…" : gatewayPort}</span></div><div className="sidebar-status-meta"><small>{lastClientRequestStatus === "ok" ? tr("最近一次转发成功", "Last request succeeded") : lastClientRequestStatus === "error" ? tr("最近一次转发失败", "Last request failed") : gatewayResetting ? tr("正在重启网关", "Gateway restarting") : tr("等待客户端请求", "Waiting for a client request")}</small><small>{tr("上游 Key 仅保存在本机", "Upstream keys stay local")}</small></div></div><div className="sidebar-footer"><span>Cherry Gateway</span><span>{VERSION}</span></div></aside><main className="main-scroll"><header className="topbar"><div><div className="top-eyebrow">{tr("本地控制中心", "LOCAL CONTROL CENTER")}</div><h1>{tr(pageTitle[view][0], pageTitle[view][1])}</h1></div><div className="top-actions"><button type="button" className={`endpoint-pill endpoint-copy-button ${gatewayResetting ? "is-restarting" : ""}`} onClick={() => void copyApiAddress()} disabled={gatewayResetting} aria-live="polite" title={tr("复制本地 API 地址", "Copy local API address")}><span className="status-dot" />{gatewayResetting ? tr("网关重启中…", "Gateway restarting…") : `127.0.0.1:${gatewayPort}`}<Icon name="copy" size={13} /></button><label className={`reasoning-control ${reasoningUpdating ? "is-updating" : ""}`} title={tr("修改默认思考强度；已有客户端 Key 保持独立设置", "Change the default reasoning level; existing client keys keep their own setting")}><Icon name="spark" size={14} /><span>{tr("默认思考", "Default")}</span><select value={settings.forcedLevel} onChange={(event) => void changeDefaultReasoning(event.target.value as ReasoningLevel)} disabled={reasoningUpdating || gatewayResetting} aria-label={tr("默认思考强度", "Default reasoning level")}>{levels.map((level) => <option value={level} key={level}>{level.toUpperCase()}</option>)}</select></label><button className="top-reset-button" onClick={() => void handleResetGateway()} disabled={loading || gatewayResetting} title={tr("重置网关并随机端口；旧 API 地址会失效", "Reset gateway and randomize port; the old API address will stop working")} aria-label={tr("重置网关并随机端口", "Reset gateway and randomize port")}><Icon name="refresh" size={15} /><span>{tr("重置网关", "Reset gateway")}</span></button><button className="language-pill" onClick={() => void changeLanguage(language === "zh" ? "en" : "zh")} title={tr("切换语言", "Switch language")}>{language === "zh" ? "EN" : "中"}</button></div></header><div className="content-wrap">{renderView()}</div></main><Modal /><ConfirmDialog />{toast && <div className={`toast toast-${toast.tone}`}><span className="toast-dot" /><span>{toast.message}</span></div>}</div>;

  function Metric({ icon, tone, value, label, note }: { icon: string; tone: string; value: string; label: string; note: string }) { return <div className="metric-card"><span className={`metric-icon ${tone}`}><Icon name={icon} size={17} /></span><span><small>{label}</small><strong>{value}</strong><em>{note}</em></span></div>; }
  function PanelHeading({ kicker, title, description, action }: { kicker: string; title: string; description?: string; action?: ReactNode }) { return <div className="panel-heading"><div><div className="section-kicker">{kicker}</div><h3>{title}</h3>{description && <p>{description}</p>}</div>{action}</div>; }
  function PageIntro({ kicker, description, action }: { kicker: string; description: string; action: ReactNode }) { return <div className="page-intro"><div><div className="section-kicker">{kicker}</div><p>{description}</p></div><div className="page-intro-action">{action}</div></div>; }
  function SettingsHeading({ icon, title, description }: { icon: string; title: string; description: string }) { return <div className="settings-heading"><span className="settings-icon"><Icon name={icon} size={17} /></span><div><h3>{title}</h3><p>{description}</p></div></div>; }
  function SettingCheck({ name, checked, onChange, title, description }: { name: string; checked: boolean; onChange: (checked: boolean) => void; title: string; description: string }) { return <label className="setting-check"><input type="checkbox" name={name} checked={checked} onChange={(event) => onChange(event.target.checked)} /><span><strong>{title}</strong><small>{description}</small></span></label>; }
  function NavItem({ icon, label, active, onClick, shortcut }: { icon: string; label: string; active: boolean; onClick: () => void; shortcut?: string }) { return <button className={`nav-item ${active ? "active" : ""}`} onClick={onClick} aria-keyshortcuts={shortcut}><span className="nav-icon"><Icon name={icon} size={16} /></span><span>{label}</span>{shortcut && <kbd>{shortcut}</kbd>}</button>; }
  function Field({ label, name, defaultValue, placeholder, type = "text", readOnly = false, required = false }: { label: string; name: string; defaultValue?: string; placeholder?: string; type?: string; readOnly?: boolean; required?: boolean }) { return <label className="field-label">{label}<input className="field-control" name={name} type={type} defaultValue={defaultValue} placeholder={placeholder} readOnly={readOnly} required={required} /></label>; }
  function ModalActions({ cancel, submit, disabled = false }: { cancel: string; submit: string; disabled?: boolean }) { return <div className="form-actions"><button type="button" className="button button-ghost" onClick={() => setModal(null)}>{cancel}</button><button type="submit" className="button button-primary" disabled={disabled}>{submit}</button></div>; }
  function EmptyState({ icon, title, description, action }: { icon: string; title: string; description: string; action?: ReactNode }) { return <div className="empty-state"><span className="empty-icon"><Icon name={icon} size={21} /></span><strong>{title}</strong><p>{description}</p>{action}</div>; }
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
