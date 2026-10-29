export interface BackendConfig {
  command: string;
  args: string[];
  readRoots: string[];
  environment: Record<string, string>;
}

export interface AppConfig {
  workspace: string;
  backend: BackendConfig;
  customEndpoint?: CustomEndpoint;
}

export interface CustomEndpoint {
  baseUrl: string;
  model: string;
}

export const CUSTOM_PROVIDER = "chatstudio-custom";

export function validateCustomEndpoint(value: unknown): CustomEndpoint {
  if (!value || typeof value !== "object" || !("baseUrl" in value) || !("model" in value)
    || typeof value.baseUrl !== "string" || typeof value.model !== "string") {
    throw new Error("Enter a custom API base URL and model/deployment name.");
  }
  let url: URL;
  try { url = new URL(value.baseUrl.trim()); }
  catch { throw new Error("Custom API base URL must be a valid HTTP or HTTPS URL."); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || value.baseUrl.length > 2048) {
    throw new Error("Custom API base URL must use HTTP or HTTPS, without credentials, query parameters, or fragments.");
  }
  const model = value.model.trim();
  if (!model || model.length > 256) throw new Error("Enter a model/deployment name between 1 and 256 characters.");
  return { baseUrl: url.href.replace(/\/+$/, ""), model };
}

export interface ModelChoice {
  provider: string;
  id: string;
  name: string;
}

export type HostRequest =
  | { type: "catalog"; id: string }
  | { type: "connect"; id: string; config: AppConfig }
  | { type: "disconnect"; id: string }
  | { type: "prompt"; id: string; provider: string; model: string; apiKey: string; text: string; baseUrl?: string }
  | { type: "reset"; id: string }
  | { type: "abort"; id: string }
  | { type: "revoke"; id: string; name: string }
  | { type: "approve"; approvalId: string; allowed: boolean; session?: boolean };

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; phase: "start" | "end"; error?: boolean }
  | { type: "approval"; id: string; name: string; arguments: string }
  | { type: "permissions"; tools: string[] }
  | { type: "backend"; connected: boolean; tools: number; message: string }
  | { type: "error"; message: string };

export type HostMessage =
  | { type: "reply"; id: string; value?: unknown; error?: string }
  | { type: "event"; event: AgentEvent };

export interface ChatStudioAPI {
  loadConfig(): Promise<AppConfig>;
  saveConfig(config: AppConfig): Promise<void>;
  chooseWorkspace(): Promise<string | null>;
  catalog(): Promise<ModelChoice[]>;
  connect(config: AppConfig): Promise<void>;
  disconnect(): Promise<void>;
  prompt(input: { provider: string; model: string; apiKey: string; text: string; baseUrl?: string }): Promise<void>;
  reset(): Promise<void>;
  abort(): Promise<void>;
  approve(id: string, allowed: boolean, session?: boolean): Promise<void>;
  revokePermission(name: string): Promise<void>;
  onEvent(listener: (event: AgentEvent) => void): () => void;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
