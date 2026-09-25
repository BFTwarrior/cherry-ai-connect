/**
 * 中文：使用统计页只读取网关生成的匿名计量数据，不读取或保存聊天正文与密钥。
 * English: The usage page reads anonymous gateway metrics only; it never reads or stores prompts, responses, or secrets.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { UsageRecordsTable, type UsageRecord, type UsageRecordDensity } from "./usage/UsageRecordsTable";

type Language = "zh" | "en";
type RangeKey = "24h" | "7d" | "30d" | "90d" | "180d";
type UsageSourceFilter = "all" | "official" | "relay";

type UsageTotals = {
  requests: number;
  errors: number;
  unknownRequests?: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheHitRate: number;
  firstRequestAt?: string;
  lastRequestAt?: string;
};

type UsagePoint = Omit<UsageTotals, "cacheHitRate"> & { at: string };

type UsageResponse = {
  source?: UsageSourceFilter;
  official?: { enabled: boolean; available: boolean; source: string; label: string; origin: string; checkedAt: string; status: string; errorCode?: string } | null;
  detailCache: { count: number; bytes: number; maxBytes: number; targetBytes: number; pageLimit: number; relayMaxBytes?: number; codexOfficialMaxBytes?: number };
  lifetime: UsageTotals;
  summary: UsageTotals;
  series: UsagePoint[];
  records: UsageRecord[];
  recordPagination?: { total: number; offset: number; limit: number };
  filters: { providers: Array<{ id: string; name: string }>; models: string[] };
  range: RangeKey;
  updatedAt: string;
  demoSources?: {
    relayLifetime: UsageTotals;
    relaySummary: UsageTotals;
    relaySeries: UsagePoint[];
    officialLifetime: UsageTotals;
    officialSummary: UsageTotals;
    officialSeries: UsagePoint[];
  };
};

const emptyTotals: UsageTotals = { requests: 0, errors: 0, unknownRequests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheHitRate: 0 };
const ranges: Array<{ key: RangeKey; zh: string; en: string }> = [
  { key: "24h", zh: "24 小时", en: "24 hours" },
  { key: "7d", zh: "7 天", en: "7 days" },
  { key: "30d", zh: "30 天", en: "30 days" },
  { key: "90d", zh: "90 天", en: "90 days" },
  { key: "180d", zh: "半年", en: "6 months" },
];

// 中文：固定时间轴和固定数字让分享出去的演示页面每次打开都稳定可核查，不依赖真实网关。
// English: A fixed timeline and fixed values keep the shareable demo stable and independent of the real gateway.
const DEMO_USAGE: UsageResponse = (() => {
  const base = Date.parse("2026-09-19T02:00:00.000Z");
  const series: UsagePoint[] = Array.from({ length: 12 }, (_, index) => {
    const inputTokens = 3_600_000 + index * 280_000 + (index % 3) * 92_000;
    const outputTokens = 6_500 + index * 410;
    const cacheReadTokens = 2_500_000 + index * 190_000;
    return { at: new Date(base + index * 2 * 60 * 60 * 1000).toISOString(), requests: 24 + index * 7, errors: index % 5 === 0 ? 1 : 0, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cacheReadTokens, cacheWriteTokens: 0 };
  });
  const records: UsageRecord[] = Array.from({ length: 8 }, (_, index) => {
    const provider = index % 2 === 0 ? { id: "DEMO-NORTH", name: "北境中转（演示）" } : { id: "DEMO-AURORA", name: "极光线路（演示）" };
    const inputTokens = 16_000 + index * 1_250;
    const outputTokens = 2_400 + index * 180;
    return {
      id: `demo-request-${index + 1}`, at: new Date(base + (11 - index) * 2 * 60 * 60 * 1000).toISOString(), clientKeyName: `演示客户端 ${(index % 4) + 1}`,
      providerId: provider.id, providerName: provider.name, model: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5"][index % 3], endpoint: "/v1/chat/completions", reasoningLevel: ["high", "xhigh", "max"][index % 3],
      status: index === 5 ? 429 : 200, durationMs: 680 + index * 145, ttftMs: 210 + index * 32, stream: index % 3 !== 0,
      inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cacheReadTokens: 8_000 + index * 800, cacheWriteTokens: 0,
    };
  });
  const officialRecords: UsageRecord[] = Array.from({ length: 2 }, (_, index) => {
    const inputTokens = 42_000 + index * 8_000;
    const outputTokens = 4_200 + index * 600;
    return {
      id: `demo-codex-session-${index + 1}`, at: new Date(base + (10 - index) * 2 * 60 * 60 * 1000).toISOString(), clientKeyName: "Codex Official",
      providerId: "codex-official", providerName: "Codex Official", source: "codex-official", model: ["gpt-6-luna", "gpt-6-sol"][index], endpoint: "/local/codex/session", reasoningLevel: "—",
      status: 200, durationMs: 0, ttftMs: 0, stream: false, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cacheReadTokens: 18_000 + index * 2_000, cacheWriteTokens: 0,
    };
  });
  const combinedRecords = [...records, ...officialRecords];
  const officialSeries: UsagePoint[] = series.map((point, index) => index === 9
    ? { ...point, requests: 1, errors: 0, inputTokens: 42_000, outputTokens: 4_200, totalTokens: 46_200, cacheReadTokens: 18_000, cacheWriteTokens: 0 }
    : index === 10
      ? { ...point, requests: 1, errors: 0, inputTokens: 50_000, outputTokens: 4_800, totalTokens: 54_800, cacheReadTokens: 20_000, cacheWriteTokens: 0 }
      : { ...point, requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  const relayLifetime: UsageTotals = { requests: 432, errors: 9, inputTokens: 57_595_034, outputTokens: 103_339, totalTokens: 57_698_373, cacheReadTokens: 52_364_000, cacheWriteTokens: 0, cacheHitRate: 90.9, firstRequestAt: new Date(base - 30 * 86400000).toISOString(), lastRequestAt: series[series.length - 1]?.at };
  const relaySummary: UsageTotals = { requests: 48, errors: 1, inputTokens: 57_595_034, outputTokens: 10_817, totalTokens: 57_605_851, cacheReadTokens: 52_364_000, cacheWriteTokens: 0, cacheHitRate: 90.9, firstRequestAt: series[0].at, lastRequestAt: series[series.length - 1]?.at };
  const officialLifetime = addDemoTotals(emptyTotals, { requests: 2, errors: 0, inputTokens: 92_000, outputTokens: 9_000, totalTokens: 101_000, cacheReadTokens: 38_000, cacheWriteTokens: 0, cacheHitRate: 0, firstRequestAt: officialRecords[1].at, lastRequestAt: officialRecords[0].at });
  return {
    detailCache: { count: combinedRecords.length, bytes: 12_845_312, maxBytes: 100 * 1024 * 1024, targetBytes: 90 * 1024 * 1024, pageLimit: 200, relayMaxBytes: 50 * 1024 * 1024, codexOfficialMaxBytes: 50 * 1024 * 1024 },
    lifetime: addDemoTotals(relayLifetime, officialLifetime),
    summary: addDemoTotals(relaySummary, officialLifetime),
    source: "all", official: { enabled: true, available: true, source: "codex-official", label: "Codex Official", origin: "http://127.0.0.1:43189", checkedAt: "2026-09-19T02:05:00.000Z", status: "available" },
    series: series.map((point, index) => addDemoPoints(point, officialSeries[index])), records: combinedRecords, recordPagination: { total: combinedRecords.length, offset: 0, limit: 200 }, filters: { providers: [{ id: "codex-official", name: "Codex Official" }, { id: "DEMO-NORTH", name: "北境中转（演示）" }, { id: "DEMO-AURORA", name: "极光线路（演示）" }, { id: "DEMO-LOAD", name: "本地压测线（演示）" }], models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5", "codex-auto-review"] }, range: "24h", updatedAt: "2026-09-19T02:05:00.000Z",
    demoSources: { relayLifetime, relaySummary, relaySeries: series, officialLifetime, officialSummary: officialLifetime, officialSeries },
  };
})();

function number(value: number | undefined, language: Language) {
  return new Intl.NumberFormat(language === "zh" ? "zh-CN" : "en-US", { maximumFractionDigits: 0 }).format(Number(value || 0));
}

function compactNumber(value: number | undefined, language: Language) {
  return new Intl.NumberFormat(language === "zh" ? "zh-CN" : "en-US", { notation: "compact", maximumFractionDigits: 1 }).format(Number(value || 0));
}

function dateTime(value: string, language: Language) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString(language === "zh" ? "zh-CN" : "en-US", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function megabytes(value: number | undefined) {
  return (Number(value || 0) / 1024 / 1024).toFixed(1);
}

// 中文：演示页按来源复用与真实接口相同的加法规则，只生成浏览器内存数据。
// English: Demo data uses the same source-addition rules as the real endpoint and stays in memory.
function addDemoTotals(left: UsageTotals, right: UsageTotals): UsageTotals {
  const result: UsageTotals = { ...emptyTotals };
  for (const key of ["requests", "errors", "inputTokens", "outputTokens", "totalTokens", "cacheReadTokens", "cacheWriteTokens"] as const) {
    result[key] = Number(left[key] || 0) + Number(right[key] || 0);
  }
  result.firstRequestAt = [left.firstRequestAt, right.firstRequestAt].filter(Boolean).sort()[0];
  result.lastRequestAt = [left.lastRequestAt, right.lastRequestAt].filter(Boolean).sort().at(-1);
  result.cacheHitRate = result.inputTokens ? Math.min(100, (result.cacheReadTokens / result.inputTokens) * 100) : 0;
  return result;
}

// 中文：演示趋势按时间点叠加官方与中转站，不改变真实网关数据。
// English: Demo trend points add official and relay values by timestamp without touching gateway data.
function addDemoPoints(left: UsagePoint, right: UsagePoint): UsagePoint {
  return {
    at: left.at,
    requests: left.requests + right.requests,
    errors: left.errors + right.errors,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
  };
}

function TinyIcon({ name }: { name: "pulse" | "tokens" | "input" | "output" | "cache" | "request" | "refresh" }) {
  const paths = {
    pulse: <polyline points="3,12 7,12 9,6 13,18 16,10 18,12 21,12" />,
    tokens: <><ellipse cx="12" cy="6" rx="7" ry="3" /><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" /></>,
    input: <><path d="M12 4v12" /><path d="m7 11 5 5 5-5" /><path d="M5 20h14" /></>,
    output: <><path d="M12 20V8" /><path d="m7 13 5-5 5 5" /><path d="M5 4h14" /></>,
    cache: <><rect x="4" y="5" width="16" height="14" rx="3" /><path d="M8 9h8M8 13h5" /></>,
    request: <><path d="M5 12h14" /><path d="m14 7 5 5-5 5" /></>,
    refresh: <><path d="M20 11a8 8 0 0 0-14.7-4L3 10" /><path d="M3 5v5h5" /><path d="M4 13a8 8 0 0 0 14.7 4L21 14" /><path d="M21 19v-5h-5" /></>,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

type UsageFilterOption = { value: string; label: string };

function UsageFilterSelect({ label, value, options, onChange }: { label: string; value: string; options: UsageFilterOption[]; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selected = options.find((option) => option.value === value) || options[0];

  useEffect(() => {
    const handleOutside = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, []);

  return <div className={`usage-select ${open ? "is-open" : ""}`} ref={rootRef}>
    <button type="button" className="usage-select-trigger" onClick={() => setOpen((current) => !current)} aria-haspopup="listbox" aria-expanded={open} aria-label={label}>
      <span>{selected?.label || label}</span>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 9 5 5 5-5" /></svg>
    </button>
    {open && <div className="usage-select-menu" role="listbox" aria-label={label}>
      {options.map((option) => <button type="button" role="option" aria-selected={option.value === value} className={`usage-select-option ${option.value === value ? "selected" : ""}`} key={option.value} onClick={() => { onChange(option.value); setOpen(false); }}>
        <span>{option.label}</span>
        {option.value === value && <span className="usage-select-check" aria-hidden="true">✓</span>}
      </button>)}
    </div>}
  </div>;
}

function UsageChart({ points, language, range }: { points: UsagePoint[]; language: Language; range: RangeKey }) {
  const [active, setActive] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const width = 1000;
  const height = 300;
  const pad = { left: 54, right: 18, top: 22, bottom: 42 };
  const innerWidth = width - pad.left - pad.right;
  const innerHeight = height - pad.top - pad.bottom;
  const max = Math.max(1, ...points.map((point) => point.totalTokens));
  const x = (index: number) => pad.left + (points.length <= 1 ? innerWidth / 2 : (index / (points.length - 1)) * innerWidth);
  const y = (value: number) => pad.top + innerHeight - (value / max) * innerHeight;
  const line = (field: "inputTokens" | "outputTokens" | "cacheReadTokens" | "totalTokens") => points.map((point, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(point[field]).toFixed(1)}`).join(" ");
  const area = points.length ? `${line("totalTokens")} L${x(points.length - 1)},${pad.top + innerHeight} L${x(0)},${pad.top + innerHeight} Z` : "";
  const selected = active === null ? null : points[active];
  const selectedX = active === null ? 0 : x(active);
  const tickIndexes = points.length <= 6 ? points.map((_, index) => index) : [0, Math.floor((points.length - 1) / 4), Math.floor((points.length - 1) / 2), Math.floor(((points.length - 1) * 3) / 4), points.length - 1];
  const axisLabel = (value: string) => new Date(value).toLocaleString(language === "zh" ? "zh-CN" : "en-US", range === "24h" ? { hour: "2-digit", minute: "2-digit" } : { month: "2-digit", day: "2-digit" });

  const handleMove = (clientX: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || !points.length) return;
    const relative = ((clientX - rect.left) / rect.width) * width;
    const index = Math.max(0, Math.min(points.length - 1, Math.round(((relative - pad.left) / innerWidth) * (points.length - 1))));
    setActive(index);
  };

  return <div className="usage-chart-shell">
    <div className="usage-chart-legend">
      <span className="legend-total">● {language === "zh" ? "总 Token" : "Total"}</span>
      <span className="legend-input">● {language === "zh" ? "输入" : "Input"}</span>
      <span className="legend-output">● {language === "zh" ? "输出" : "Output"}</span>
      <span className="legend-cache">● {language === "zh" ? "缓存命中" : "Cache read"}</span>
    </div>
    <svg ref={svgRef} className="usage-chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" onMouseMove={(event) => handleMove(event.clientX)} onMouseLeave={() => setActive(null)}>
      <defs>
        <linearGradient id="usage-total-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#9b6cff" stopOpacity=".38" /><stop offset="1" stopColor="#9b6cff" stopOpacity="0" /></linearGradient>
      </defs>
      {[0, .25, .5, .75, 1].map((fraction) => <g key={fraction}><line className="usage-grid-line" x1={pad.left} x2={width - pad.right} y1={pad.top + innerHeight * fraction} y2={pad.top + innerHeight * fraction} /><text className="usage-axis-text" x={pad.left - 10} y={pad.top + innerHeight * fraction + 4} textAnchor="end">{compactNumber(max * (1 - fraction), language)}</text></g>)}
      {tickIndexes.map((index) => <text className="usage-axis-text" key={index} x={x(index)} y={height - 13} textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"}>{axisLabel(points[index]?.at || "")}</text>)}
      {area && <path className="usage-area" d={area} />}
      {points.length > 0 && <><path className="usage-line usage-line-total" d={line("totalTokens")} /><path className="usage-line usage-line-input" d={line("inputTokens")} /><path className="usage-line usage-line-output" d={line("outputTokens")} /><path className="usage-line usage-line-cache" d={line("cacheReadTokens")} /></>}
      {selected && <><line className="usage-hover-line" x1={selectedX} x2={selectedX} y1={pad.top} y2={pad.top + innerHeight} /><circle className="usage-hover-dot" cx={selectedX} cy={y(selected.totalTokens)} r="5" /></>}
    </svg>
    {selected && <div className={`usage-tooltip ${selectedX > width * .7 ? "align-left" : ""}`} style={{ left: `${(selectedX / width) * 100}%` }}><strong>{dateTime(selected.at, language)}</strong><span className="legend-total">{language === "zh" ? "总 Token" : "Total"}: {number(selected.totalTokens, language)}</span><span className="legend-input">{language === "zh" ? "输入" : "Input"}: {number(selected.inputTokens, language)}</span><span className="legend-output">{language === "zh" ? "输出" : "Output"}: {number(selected.outputTokens, language)}</span><span className="legend-cache">{language === "zh" ? "缓存命中" : "Cache read"}: {number(selected.cacheReadTokens, language)}</span><span>{language === "zh" ? "请求" : "Requests"}: {number(selected.requests, language)}</span></div>}
  </div>;
}

export function UsageView({ language, gatewayOrigin, demo = false }: { language: Language; gatewayOrigin: string; demo?: boolean }) {
  const tr = useCallback((zh: string, en: string) => language === "zh" ? zh : en, [language]);
  const [range, setRange] = useState<RangeKey>("24h");
  const [sourceFilter, setSourceFilter] = useState<UsageSourceFilter>("all");
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [status, setStatus] = useState("all");
  const [recordsOffset, setRecordsOffset] = useState(0);
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // 中文：记录密度是本机视觉偏好；紧凑模式保留全部字段并用区域内横向滚动展示。
  // English: Record density is a local visual preference; compact mode keeps every field in a horizontally scrollable region.
  const [recordDensity, setRecordDensity] = useState<UsageRecordDensity>(() => localStorage.getItem("cherry-usage-record-density") === "detailed" ? "detailed" : "compact");

  const changeRecordDensity = (next: UsageRecordDensity) => {
    setRecordDensity(next);
    localStorage.setItem("cherry-usage-record-density", next);
  };

  // 中文：来源切换后清除旧线路筛选，避免从中转线路切到官方 Codex 时带入不相容的 providerId。
  // English: Clear the old route filter when changing source so a relay provider cannot filter
  // the official Codex view into a misleading empty result.
  const changeSource = (next: UsageSourceFilter) => {
    setSourceFilter(next);
    setProviderId("");
    setRecordsOffset(0);
  };

  const loadUsage = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      if (demo) {
        const demoRecords = DEMO_USAGE.records.filter((record) => sourceFilter === "all" || (sourceFilter === "official" ? record.source === "codex-official" : record.source !== "codex-official"));
        const sourceData = DEMO_USAGE.demoSources;
        const selectedSource = sourceFilter === "official"
          ? { lifetime: sourceData?.officialLifetime || DEMO_USAGE.lifetime, summary: sourceData?.officialSummary || DEMO_USAGE.summary, series: sourceData?.officialSeries || DEMO_USAGE.series }
          : sourceFilter === "relay"
            ? { lifetime: sourceData?.relayLifetime || DEMO_USAGE.lifetime, summary: sourceData?.relaySummary || DEMO_USAGE.summary, series: sourceData?.relaySeries || DEMO_USAGE.series }
            : { lifetime: DEMO_USAGE.lifetime, summary: DEMO_USAGE.summary, series: DEMO_USAGE.series };
        setData({ ...DEMO_USAGE, ...selectedSource, source: sourceFilter, range, records: demoRecords, recordPagination: { total: demoRecords.length, offset: 0, limit: 200 } });
        setError("");
        return;
      }
      const query = new URLSearchParams({ range, limit: "200", recordsOffset: String(recordsOffset), status, source: sourceFilter });
      if (providerId) query.set("providerId", providerId);
      if (model) query.set("model", model);
      const response = await fetch(`${gatewayOrigin}/admin/api/usage?${query}`, { cache: "no-store" });
      const value = await response.json();
      if (!response.ok) throw new Error(value?.error || `HTTP ${response.status}`);
      setData(value);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { if (!silent) setLoading(false); }
  }, [demo, gatewayOrigin, model, providerId, range, recordsOffset, sourceFilter, status]);

  useEffect(() => { void loadUsage(); }, [loadUsage]);
  useEffect(() => {
    const timer = window.setInterval(() => { void loadUsage(true); }, 5000);
    return () => window.clearInterval(timer);
  }, [loadUsage]);

  const lifetime = data?.lifetime || emptyTotals;
  const summary = data?.summary || emptyTotals;
  const recordPage = data?.recordPagination || { total: data?.records.length || 0, offset: 0, limit: 200 };
  const recordStart = recordPage.total ? recordPage.offset + 1 : 0;
  const recordEnd = Math.min(recordPage.offset + recordPage.limit, recordPage.total);
  const knownRequests = Math.max(0, summary.requests - Number(summary.unknownRequests || 0));
  const successRate = knownRequests ? Math.max(0, ((knownRequests - summary.errors) / knownRequests) * 100) : null;
  const selectedLabel = useMemo(() => ranges.find((item) => item.key === range)?.[language] || range, [language, range]);

  const officialAvailable = data?.official?.available === true;
  const officialStateText = sourceFilter === "relay"
    ? tr("当前仅显示中转站", "Relay-only view")
    : officialAvailable
      ? tr("Codex 官方已连接 · 每 5 秒更新", "Codex Official connected · updates every 5s")
      : data?.official?.errorCode
        ? tr("Codex 官方统计读取失败 · 每 5 秒重试", "Codex Official read failed · retrying every 5s")
        : tr("Codex 官方等待本机服务 · 每 5 秒检查", "Codex Official waiting for local service · checks every 5s");
  return <section className="page-view usage-view">
    <div className="page-intro"><div><div className="section-kicker">{tr("使用统计", "USAGE ANALYTICS")}</div><p>{tr("实时记录本地连接服务与正版 Codex 的使用情况；不记录聊天正文和密钥。", "Live local relay and official Codex usage without storing prompts, responses, or secrets.")}</p></div><div className="usage-live"><span className={`status-dot ${officialAvailable ? "" : "is-muted"}`} />{officialStateText}</div></div>

    <article className="lifetime-card">
      <div className="lifetime-icon"><TinyIcon name="tokens" /></div>
      <div className="lifetime-main"><span>{tr("永久累计使用量", "LIFETIME USAGE")}</span><strong>{number(lifetime.totalTokens, language)}</strong><small>{tr("Token 总数 · 没有时间限制，不随明细保留策略而归零", "Total tokens · no time limit; never reset by detail-retention rules")}</small></div>
      <div className="lifetime-breakdown"><div><small>{tr("累计请求", "Requests")}</small><strong>{number(lifetime.requests, language)}</strong></div><div><small>{tr("累计输入", "Input")}</small><strong>{compactNumber(lifetime.inputTokens, language)}</strong></div><div><small>{tr("累计输出", "Output")}</small><strong>{compactNumber(lifetime.outputTokens, language)}</strong></div><div><small>{tr("缓存命中率", "Cache hit")}</small><strong>{lifetime.cacheHitRate.toFixed(1)}%</strong></div></div>
    </article>

    <div className="usage-toolbar">
      <div className="range-tabs">{ranges.map((item) => <button type="button" className={range === item.key ? "active" : ""} key={item.key} onClick={() => setRange(item.key)}>{language === "zh" ? item.zh : item.en}</button>)}</div>
      <div className="usage-filters">
        <UsageFilterSelect label={tr("线路筛选", "Route filter")} value={providerId} options={[{ value: "", label: tr("全部线路", "All routes") }, ...(data?.filters.providers || []).map((provider) => ({ value: provider.id, label: provider.name }))]} onChange={(value) => { setProviderId(value); setRecordsOffset(0); }} />
        <UsageFilterSelect label={tr("模型筛选", "Model filter")} value={model} options={[{ value: "", label: tr("全部模型", "All models") }, ...(data?.filters.models || []).map((item) => ({ value: item, label: item }))]} onChange={(value) => { setModel(value); setRecordsOffset(0); }} />
        <UsageFilterSelect label={tr("状态筛选", "Status filter")} value={status} options={[{ value: "all", label: tr("全部状态", "All status") }, { value: "success", label: tr("仅成功", "Success only") }, { value: "error", label: tr("仅失败", "Errors only") }]} onChange={(value) => { setStatus(value); setRecordsOffset(0); }} />
        <button type="button" className="usage-refresh" onClick={() => void loadUsage()} disabled={loading}><TinyIcon name="refresh" />{tr("刷新", "Refresh")}</button>
      </div>
    </div>

    {error && <div className="usage-error">{tr("统计读取失败：", "Failed to load analytics: ")}{error}</div>}
    <div className="usage-summary-grid">
      <article><span className="summary-icon purple"><TinyIcon name="tokens" /></span><div><small>{selectedLabel} · {tr("Token", "Tokens")}</small><strong>{number(summary.totalTokens, language)}</strong><em>{tr("真实返回用量", "Reported usage")}</em></div></article>
      <article><span className="summary-icon blue"><TinyIcon name="input" /></span><div><small>{tr("输入", "Input")}</small><strong>{number(summary.inputTokens, language)}</strong><em>{tr("含缓存读取", "Includes cache reads")}</em></div></article>
      <article><span className="summary-icon gold"><TinyIcon name="output" /></span><div><small>{tr("输出", "Output")}</small><strong>{number(summary.outputTokens, language)}</strong><em>{tr("模型生成", "Model generated")}</em></div></article>
      <article><span className="summary-icon amber"><TinyIcon name="cache" /></span><div><small>{tr("缓存命中率", "Cache hit rate")}</small><strong>{summary.cacheHitRate.toFixed(1)}%</strong><em>{number(summary.cacheReadTokens, language)} {tr("命中 Token", "cached tokens")}</em></div></article>
      <article><span className="summary-icon teal"><TinyIcon name="request" /></span><div><small>{tr("请求", "Requests")}</small><strong>{number(summary.requests, language)}</strong><em>{successRate === null ? tr("状态未知", "Status unknown") : `${successRate.toFixed(1)}% ${tr("成功", "successful")}`}</em></div></article>
    </div>

    <article className="usage-panel chart-panel"><header><div><span>{tr("使用趋势", "USAGE TREND")}</span><h3>{selectedLabel}</h3></div><small>{tr("悬停折线查看具体时间点", "Hover the lines for exact values")}</small></header>{loading && !data ? <div className="usage-loading">{tr("正在读取统计…", "Loading analytics…")}</div> : data?.series.length ? <UsageChart points={data.series} language={language} range={range} /> : <div className="usage-loading">{tr("该时间范围暂无请求", "No requests in this period")}</div>}</article>

    <article className="usage-panel records-panel">
      <header><div><span>{tr("历史请求记录", "REQUEST HISTORY")}</span><h3>{tr(`第 ${recordStart}–${recordEnd} 条，共 ${recordPage.total} 条`, `Records ${recordStart}–${recordEnd} of ${recordPage.total}`)}</h3></div><div className="records-header-actions"><div className="usage-source-tabs" role="tablist" aria-label={tr("统计来源", "Usage source")}><button type="button" role="tab" aria-selected={sourceFilter === "all"} className={sourceFilter === "all" ? "active" : ""} onClick={() => changeSource("all")}>{tr("全部", "All")}</button><button type="button" role="tab" aria-selected={sourceFilter === "official"} className={sourceFilter === "official" ? "active" : ""} onClick={() => changeSource("official")}>{tr("Codex 官方", "Codex Official")}</button><button type="button" role="tab" aria-selected={sourceFilter === "relay"} className={sourceFilter === "relay" ? "active" : ""} onClick={() => changeSource("relay")}>{tr("中转站", "Relay Stations")}</button></div><div className="record-density-toggle" role="group" aria-label={tr("请求记录显示方式", "Request record layout")}><button type="button" className={recordDensity === "compact" ? "active" : ""} onClick={() => changeRecordDensity("compact")}>{tr("单行", "Single line")}</button><button type="button" className={recordDensity === "detailed" ? "active" : ""} onClick={() => changeRecordDensity("detailed")}>{tr("双行", "Two lines")}</button></div><small>{tr(`中转 ${megabytes(data?.detailCache.relayMaxBytes || 50 * 1024 * 1024)} MB + Codex 官方 ${megabytes(data?.detailCache.codexOfficialMaxBytes || 50 * 1024 * 1024)} MB`, `Relay ${megabytes(data?.detailCache.relayMaxBytes || 50 * 1024 * 1024)} MB + Codex Official ${megabytes(data?.detailCache.codexOfficialMaxBytes || 50 * 1024 * 1024)} MB`)}</small></div></header>
      <UsageRecordsTable records={data?.records || []} language={language} density={recordDensity} />
      {recordPage.total > recordPage.limit && <nav className="usage-record-pagination" aria-label={tr("历史记录分页", "History pages")}><button type="button" disabled={recordPage.offset === 0 || loading} onClick={() => setRecordsOffset(Math.max(0, recordPage.offset - recordPage.limit))}>{tr("较新记录", "Newer")}</button><span>{recordStart}–{recordEnd} / {recordPage.total}</span><button type="button" disabled={recordPage.offset + recordPage.limit >= recordPage.total || loading} onClick={() => setRecordsOffset(recordPage.offset + recordPage.limit)}>{tr("更早记录", "Older")}</button></nav>}
    </article>
  </section>;
}
