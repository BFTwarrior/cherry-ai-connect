/**
 * 中文：实时请求记录表。这里集中定义字段、速度阈值和可读性规则，避免列表与详情含义不一致。
 * English: Live request table. Fields, latency thresholds, and readability rules live here so views stay consistent.
 */

import { memo, useMemo } from "react";

type Language = "zh" | "en";
export type UsageRecordDensity = "compact" | "detailed";

export type UsageRecord = {
  id: string;
  at: string;
  clientKeyName: string;
  providerId: string;
  providerName: string;
  source?: "relay" | "codex-official" | string;
  sourceLabel?: string;
  model: string;
  endpoint: string;
  reasoningLevel: string;
  status: number | null;
  durationMs: number | null;
  ttftMs: number | null;
  stream: boolean | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  usageKind?: "session-cumulative" | "request" | string;
};

// 中文：阈值与产品文档一致；后续若测试数据调整，只需修改这一处。
// English: These match the product spec; future tuning changes one source of truth.
export const LATENCY_THRESHOLDS = {
  firstToken: { attentionMs: 3_000, slowMs: 8_000 },
  total: { attentionMs: 10_000, slowMs: 30_000 },
} as const;

function formattedDate(value: string, language: Language, formatter?: Intl.DateTimeFormat) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : (formatter || new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-US", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })).format(date);
}

function formattedDuration(value: number | null | undefined) {
  if (value === null || value === undefined) return "—";
  const milliseconds = Number(value || 0);
  return milliseconds >= 1000 ? `${(milliseconds / 1000).toFixed(2)}s` : `${Math.round(milliseconds)}ms`;
}

function latencyLevel(value: number | null, kind: "firstToken" | "total") {
  // 中文：官方 session 汇总通常没有延迟字段，未知必须独立于“快”状态显示。
  // English: Official session aggregates often lack latency fields; unknown must stay distinct
  // from the fast state.
  if (value === null || value === undefined) return "unknown";
  const threshold = LATENCY_THRESHOLDS[kind];
  if (value > threshold.slowMs) return "slow";
  if (value > threshold.attentionMs) return "attention";
  return "fast";
}

function LatencyValue({ value, kind, language }: { value: number | null; kind: "firstToken" | "total"; language: Language }) {
  const level = latencyLevel(value, kind);
  if (level === "unknown") return <div className="latency-value latency-unknown"><strong>—</strong><span>{language === "zh" ? "未知" : "Unknown"}</span></div>;
  const labels = language === "zh"
    ? { fast: "快", attention: "需关注", slow: "较慢" }
    : { fast: "Fast", attention: "Watch", slow: "Slow" };
  return <div className={`latency-value latency-${level}`}><strong>{formattedDuration(value)}</strong><span><i />{labels[level]}</span></div>;
}

export const UsageRecordsTable = memo(function UsageRecordsTable({ records, language, density }: { records: UsageRecord[]; language: Language; density: UsageRecordDensity }) {
  const tr = (zh: string, en: string) => language === "zh" ? zh : en;
  const numberFormatter = useMemo(() => new Intl.NumberFormat(language === "zh" ? "zh-CN" : "en-US", { maximumFractionDigits: 0 }), [language]);
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-US", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }), [language]);
  const formattedNumber = (value: number | undefined) => numberFormatter.format(Number(value || 0));
  return <div className={`usage-records-list mode-${density}`} aria-label={tr("实时请求记录", "Live request log")}>
    {records.map((record) => {
      const successful = record.status === null || (record.status >= 200 && record.status < 400);
      const streamLabel = record.stream === true ? tr("流式", "Stream") : record.stream === false ? tr("非流式", "Standard") : tr("未知", "Unknown");
      return <article className={`usage-record-card ${successful ? "" : "request-row-error"}`} key={record.id}>
        <header className="usage-record-identity">
          <div><small>{tr("时间", "Time")}</small><time>{formattedDate(record.at, language, dateFormatter)}</time><em>{streamLabel}</em></div>
          <div><small>{tr("客户端 / 线路", "Client / Route")}</small><strong>{record.source === "codex-official" ? tr("Codex 官方", "Codex Official") : (record.clientKeyName || "—")}</strong><em>{record.source === "codex-official" ? tr("Codex 官方", "Codex Official") : (record.providerName || record.providerId)}</em></div>
          <div className="record-model"><small>{tr("模型", "Model")}</small><code title={record.model}>{record.model || "—"}</code><em title={record.endpoint}>{record.endpoint}</em></div>
          <div><small>{tr("思考强度", "Reasoning")}</small><span className="reasoning-tag">{String(record.reasoningLevel || "—").toUpperCase()}</span></div>
          <div><small>{tr("状态", "Status")}</small><span className={`request-status ${record.status === null ? "unknown" : successful ? "ok" : "error"}`}>{record.status === null ? tr("未知", "Unknown") : record.status}</span></div>
        </header>
        <div className="usage-record-metrics">
          <div className="token-input"><small>{record.usageKind === "session-cumulative" ? tr("累计输入 Token", "Session input") : tr("输入 Token", "Input tokens")}</small><strong>{formattedNumber(record.inputTokens)}</strong>{record.usageKind === "session-cumulative" && <em>{tr("官方会话累计", "Cumulative session total")}</em>}</div>
          <div className="token-output"><small>{tr("输出 Token", "Output tokens")}</small><strong>{formattedNumber(record.outputTokens)}</strong></div>
          <div className="token-cache"><small>{tr("缓存 Token", "Cache tokens")}</small><strong>{formattedNumber(record.cacheReadTokens)}</strong><em>{tr("写入", "Write")} +{formattedNumber(record.cacheWriteTokens)}</em></div>
          <div className="token-total"><small>{tr("总 Token", "Total tokens")}</small><strong>{formattedNumber(record.totalTokens)}</strong></div>
          <div><small>{tr("首字时间", "First token")}</small><LatencyValue value={record.ttftMs} kind="firstToken" language={language} /></div>
          <div><small>{tr("总耗时", "Total time")}</small><LatencyValue value={record.durationMs} kind="total" language={language} /></div>
        </div>
      </article>;
    })}
    {!records.length && <div className="usage-empty-row">{tr("还没有匹配的请求记录。通过 Cherry 发起一次对话后，这里会自动出现。", "No matching requests yet. Send a message through Cherry and it will appear here automatically.")}</div>}
  </div>;
});
