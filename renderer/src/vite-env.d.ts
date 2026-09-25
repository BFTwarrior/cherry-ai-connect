interface DesktopSettings {
  language?: "zh" | "en";
  autoLaunch?: boolean;
  startMinimized?: boolean;
  closeToTray?: boolean;
  loginItem?: boolean;
}

interface GatewayInfo {
  port: number;
  origin: string;
  apiBase: string;
  previousPort?: number;
  randomized?: boolean;
  restartedAt?: string;
}

interface UpdateCheckResult {
  ok: boolean;
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseUrl: string;
  publishedAt: string;
  checkedAt: string;
  asset: { name: string; url: string; size: number; sha256: string } | null;
}

// 中文：主进程给出的进度快照契约；sequence 用于拒绝异步快照覆盖较新的实时事件。
// English: Main-process progress contract; sequence prevents an older async snapshot from
// overwriting a newer live event.
interface UpdateProgress {
  sequence: number;
  stage: "checking" | "downloading" | "syncing" | "backing-up" | "installing" | "completed" | "error";
  percent: number;
  received?: number;
  total?: number;
  error?: string;
  at: string;
}

interface UpdateProgressSnapshot {
  active: boolean;
  status: "idle" | "running" | "completed" | "error";
  sequence: number;
  progress: UpdateProgress | null;
}

interface CloudSyncStatus {
  enabled: boolean;
  syncUpstream: boolean;
  connected: boolean;
  provider: "github";
  owner: string;
  repository: string;
  repositoryPrivate: boolean;
  account: { id: string; login: string; avatarUrl?: string } | null;
  state: "DISABLED" | "IDLE" | "DIRTY" | "SYNCING" | "PENDING_NETWORK" | "AUTH_REQUIRED" | "CONFLICT" | "ERROR_RECOVERABLE" | "ERROR_FATAL";
  datasetId: string;
  generation: number;
  pendingCount: number;
  lastSyncAt: string;
  lastAttemptAt: string;
  nextSyncAt: string;
  errorCode: string;
  error: string;
  warning: string;
  intervalMinutes: number;
  vault: { initialized: boolean; unlocked: boolean; datasetId?: string; keyEpoch?: number; vaultRevision?: number; error?: string };
}

interface GitHubConnectResult {
  ok: boolean;
  recoveryCode: string;
  status: CloudSyncStatus;
}

interface SyncConflictResult {
  ok: boolean;
  recoveryCode: string;
  status: CloudSyncStatus;
}

interface Window {
  desktop?: {
    openDataFolder: () => Promise<unknown>;
    getSettings: () => Promise<DesktopSettings>;
    setSettings: (patch: Partial<DesktopSettings>) => Promise<DesktopSettings>;
    getGatewayInfo: () => Promise<GatewayInfo>;
    resetGateway: () => Promise<{ ok: boolean } & GatewayInfo>;
    checkForUpdates: () => Promise<UpdateCheckResult>;
    downloadAndInstallUpdate: () => Promise<{ ok: boolean; updateAvailable: boolean; launched?: boolean; version?: string }>;
    getUpdateProgress: () => Promise<UpdateProgressSnapshot>;
    onUpdateProgress: (listener: (progress: UpdateProgress) => void) => () => void;
    getSyncStatus: () => Promise<CloudSyncStatus>;
    connectGitHub: (value: { token: string; repository: string; password: string; syncUpstream?: boolean }) => Promise<GitHubConnectResult>;
    syncNow: () => Promise<CloudSyncStatus>;
    setSyncEnabled: (enabled: boolean) => Promise<CloudSyncStatus>;
    unlockSyncVault: (value: { password?: string; recoveryCode?: string }) => Promise<{ ok: boolean; status: CloudSyncStatus }>;
    resolveSyncConflict: (value: { choice: "local" | "remote"; password?: string; recoveryCode?: string }) => Promise<SyncConflictResult>;
    disconnectGitHub: () => Promise<CloudSyncStatus>;
    onSyncStatus: (listener: (status: CloudSyncStatus) => void) => () => void;
    openExternal: (url: string) => Promise<unknown>;
    importClientKey: (value: { keyId: string; target: "ccswitch" | "cherry-studio" }) => Promise<{ ok: true }>;
    showWindow: () => void;
    hideWindow: () => void;
    quit: () => void;
  };
}

declare module "*.css";
