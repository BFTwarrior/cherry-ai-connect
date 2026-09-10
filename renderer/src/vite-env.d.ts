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

interface Window {
  desktop?: {
    openDataFolder: () => Promise<unknown>;
    getSettings: () => Promise<DesktopSettings>;
    setSettings: (patch: Partial<DesktopSettings>) => Promise<DesktopSettings>;
    getGatewayInfo: () => Promise<GatewayInfo>;
    resetGateway: () => Promise<{ ok: boolean } & GatewayInfo>;
    showWindow: () => void;
    hideWindow: () => void;
    quit: () => void;
  };
}

declare module "*.css";
