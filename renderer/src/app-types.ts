/**
 * 中文：渲染层共享的数据契约。集中定义可以防止页面之间出现同名但含义不同的字段。
 * English: Shared renderer contracts. One source of truth prevents pages from drifting on field meaning.
 */

export type View = "overview" | "providers" | "models" | "keys" | "usage" | "settings";
export type Language = "zh" | "en";
export type ReasoningLevel = "low" | "medium" | "high" | "xhigh" | "max";
export type SyncStatus = "ok" | "error" | "never";
export type ClientRequestStatus = "never" | "pending" | "ok" | "error";

export type Provider = {
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

export type ClientKey = {
  id: string;
  name: string;
  nameCustomized: boolean;
  providerId: string;
  providerName: string;
  reasoningLevel: ReasoningLevel;
  createdAt: string;
  enabled: boolean;
  hasSecret?: boolean;
};

export type GatewaySettings = {
  forcedLevel: ReasoningLevel;
  defaultProvider: string;
  reasoningLevels?: ReasoningLevel[];
};

export type GatewayStatus = {
  lastClientRequestAt?: string;
  lastClientRequestStatus?: ClientRequestStatus;
  lastClientRequestModel?: string;
};

export type SyncProgress = {
  current: number;
  total: number;
  providerId: string;
  providerName: string;
};

export type DesktopSettings = {
  language: Language;
  autoLaunch: boolean;
  startMinimized: boolean;
  closeToTray: boolean;
  loginItem?: boolean;
};

export type ModalState =
  | { kind: "provider"; provider?: Provider }
  | { kind: "key"; key?: ClientKey }
  | { kind: "key-result"; secret: string }
  | null;

export type ToastTone = "success" | "error" | "info";
export type ToastState = { message: string; tone: ToastTone } | null;
export type ConfirmTone = "primary" | "warning" | "danger";
export type ConfirmDialogOptions = {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  tone?: ConfirmTone;
  icon?: string;
};
export type ConfirmDialogState = ConfirmDialogOptions | null;
