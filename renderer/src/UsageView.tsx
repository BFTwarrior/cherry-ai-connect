/**
 * 中文：使用统计页只读取网关生成的匿名计量数据，不读取或保存聊天正文与密钥。
 * English: The usage page reads anonymous gateway metrics only; it never reads or stores prompts, responses, or secrets.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { UsageRecordsTable, type UsageRecord, type UsageRecordDensity } from "./usage/UsageRecordsTable";

type Language = "zh" | "en";
type RangeKey = "24h" | "7d" | "30d" | "90d" | "180d";

type UsageTotals = {
  requests: number;
  errors: number;
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
  detailCache: { count: number; bytes: number; maxBytes: number; targetBytes: number; pageLimit: number };
  lifetime: UsageTotals;
  summary: UsageTotals;
  series: UsagePoint[];
  records: UsageRecord[];
  filters: { providers: Array<{ id: string; name: string }>; models: string[] };
  range: RangeKey;
  updatedAt: string;
};

const emptyTotals: UsageTotals = { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheHitRate: 0 };
const ranges: Array<{ key: RangeKey; zh: string; en: string }> = [
  { key: "24h", zh: "24 小时", en: "24 hours" },
  { key: "7d", zh: "7 天", en: "7 days" },
  { key: "30d", zh: "30 天", en: "30 days" },
  { key: "90d", zh: "90 天", en: "90 days" },
  { key: "180d", zh: "半年", en: "6 months" },
];

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

export function UsageView({ language, gatewayOrigin }: { language: Language; gatewayOrigin: string }) {
  const tr = useCallback((zh: string, en: string) => language === "zh" ? zh : en, [language]);
  const [range, setRange] = useState<RangeKey>("24h");
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [status, setStatus] = useState("all");
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

  const loadUsage = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const query = new URLSearchParams({ range, limit: "200", status });
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
  }, [gatewayOrigin, model, providerId, range, status]);

  useEffect(() => { void loadUsage(); }, [loadUsage]);
  useEffect(() => {
    const timer = window.setInterval(() => { void loadUsage(true); }, 5000);
    return () => window.clearInterval(timer);
  }, [loadUsage]);

  const lifetime = data?.lifetime || emptyTotals;
  const summary = data?.summary || emptyTotals;
  const successRate = summary.requests ? Math.max(0, ((summary.requests - summary.errors) / summary.requests) * 100) : 0;
  const selectedLabel = useMemo(() => ranges.find((item) => item.key === range)?.[language] || range, [language, range]);

  return <section className="page-view usage-view">
    <div className="page-intro"><div><div className="section-kicker">{tr("使用统计", "USAGE ANALYTICS")}</div><p>{tr("实时记录本地连接服务的使用情况；不记录聊天正文和密钥。", "Live connection-service metrics without storing prompts, responses, or secrets.")}</p></div><div className="usage-live"><span className="status-dot" />{tr("每 5 秒更新", "Updates every 5s")}</div></div>

    <article className="lifetime-card">
      <div className="lifetime-icon"><TinyIcon name="tokens" /></div>
      <div className="lifetime-main"><span>{tr("永久累计使用量", "LIFETIME USAGE")}</span><strong>{number(lifetime.totalTokens, language)}</strong><small>{tr("Token 总数 · 没有时间限制，不随 50 MB 明细缓存清理而归零", "Total tokens · no time limit; never reset when the 50 MB detail cache is pruned")}</small></div>
      <div className="lifetime-breakdown"><div><small>{tr("累计请求", "Requests")}</small><strong>{number(lifetime.requests, language)}</strong></div><div><small>{tr("累计输入", "Input")}</small><strong>{compactNumber(lifetime.inputTokens, language)}</strong></div><div><small>{tr("累计输出", "Output")}</small><strong>{compactNumber(lifetime.outputTokens, language)}</strong></div><div><small>{tr("缓存命中率", "Cache hit")}</small><strong>{lifetime.cacheHitRate.toFixed(1)}%</strong></div></div>
    </article>

    <div className="usage-toolbar">
      <div className="range-tabs">{ranges.map((item) => <button type="button" className={range === item.key ? "active" : ""} key={item.key} onClick={() => setRange(item.key)}>{language === "zh" ? item.zh : item.en}</button>)}</div>
      <div className="usage-filters"><select value={providerId} onChange={(event) => setProviderId(event.target.value)}><option value="">{tr("全部线路", "All routes")}</option>{data?.filters.providers.map((provider) => <option value={provider.id} key={provider.id}>{provider.name}</option>)}</select><select value={model} onChange={(event) => setModel(event.target.value)}><option value="">{tr("全部模型", "All models")}</option>{data?.filters.models.map((item) => <option value={item} key={item}>{item}</option>)}</select><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">{tr("全部状态", "All status")}</option><option value="success">{tr("仅成功", "Success only")}</option><option value="error">{tr("仅失败", "Errors only")}</option></select><button type="button" className="usage-refresh" onClick={() => void loadUsage()} disabled={loading}><TinyIcon name="refresh" />{tr("刷新", "Refresh")}</button></div>
    </div>

    {error && <div className="usage-error">{tr("统计读取失败：", "Failed to load analytics: ")}{error}</div>}
    <div className="usage-summary-grid">
      <article><span className="summary-icon purple"><TinyIcon name="tokens" /></span><div><small>{selectedLabel} · {tr("Token", "Tokens")}</small><strong>{number(summary.totalTokens, language)}</strong><em>{tr("真实返回用量", "Reported usage")}</em></div></article>
      <article><span className="summary-icon blue"><TinyIcon name="input" /></span><div><small>{tr("输入", "Input")}</small><strong>{number(summary.inputTokens, language)}</strong><em>{tr("含缓存读取", "Includes cache reads")}</em></div></article>
      <article><span className="summary-icon gold"><TinyIcon name="output" /></span><div><small>{tr("输出", "Output")}</small><strong>{number(summary.outputTokens, language)}</strong><em>{tr("模型生成", "Model generated")}</em></div></article>
      <article><span className="summary-icon amber"><TinyIcon name="cache" /></span><div><small>{tr("缓存命中率", "Cache hit rate")}</small><strong>{summary.cacheHitRate.toFixed(1)}%</strong><em>{number(summary.cacheReadTokens, language)} {tr("命中 Token", "cached tokens")}</em></div></article>
      <article><span className="summary-icon teal"><TinyIcon name="request" /></span><div><small>{tr("请求", "Requests")}</small><strong>{number(summary.requests, language)}</strong><em>{successRate.toFixed(1)}% {tr("成功", "successful")}</em></div></article>
    </div>

    <article className="usage-panel chart-panel"><header><div><span>{tr("使用趋势", "USAGE TREND")}</span><h3>{selectedLabel}</h3></div><small>{tr("悬停折线查看具体时间点", "Hover the lines for exact values")}</small></header>{loading && !data ? <div className="usage-loading">{tr("正在读取统计…", "Loading analytics…")}</div> : data?.series.length ? <UsageChart points={data.series} language={language} range={range} /> : <div className="usage-loading">{tr("该时间范围暂无请求", "No requests in this period")}</div>}</article>

    <article className="usage-panel records-panel">
      <header><div><span>{tr("实时请求记录", "LIVE REQUEST LOG")}</span><h3>{tr("最新 200 条（单页）", "Latest 200 (one page)")}</h3></div><div className="records-header-actions"><div className="record-density-toggle" role="group" aria-label={tr("请求记录显示方式", "Request record layout")}><button type="button" className={recordDensity === "compact" ? "active" : ""} onClick={() => changeRecordDensity("compact")}>{tr("单行", "Single line")}</button><button type="button" className={recordDensity === "detailed" ? "active" : ""} onClick={() => changeRecordDensity("detailed")}>{tr("双行", "Two lines")}</button></div><small>{tr(`本机明细缓存 ${megabytes(data?.detailCache.bytes)} / ${megabytes(data?.detailCache.maxBytes || 50 * 1024 * 1024)} MB`, `Local detail cache ${megabytes(data?.detailCache.bytes)} / ${megabytes(data?.detailCache.maxBytes || 50 * 1024 * 1024)} MB`)}</small></div></header>
      <UsageRecordsTable records={data?.records || []} language={language} density={recordDensity} />
    </article>
  </section>;
}
