import { app, BrowserWindow, dialog, ipcMain, utilityProcess, type UtilityProcess } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfig, validateConfig } from "./config.js";
import type { HostRequest, HostMessage } from "../shared/contracts.js";
import { CUSTOM_PROVIDER, validateCustomEndpoint } from "../shared/contracts.js";

const here = path.dirname(fileURLToPath(import.meta.url));
let window: BrowserWindow | undefined;
let host: UtilityProcess | undefined;
let quitting = false;
let privateRoot = "";
const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

function agentHost(): UtilityProcess {
  if (host) return host;
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot", "TEMP", "TMP", "LANG"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  host = utilityProcess.fork(path.join(here, "agent-host.js"), [privateRoot], { env, serviceName: "ChatStudio agent", stdio: "pipe" });
  host.on("message", (message: HostMessage) => {
    if (message.type === "event") {
      if (window && !window.isDestroyed()) window.webContents.send("agent:event", message.event);
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.value);
  });
  host.on("exit", (code) => {
    host = undefined;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(`Agent process exited (${code}).`));
    }
    pending.clear();
    if (window && !window.isDestroyed()) window.webContents.send("agent:event", { type: "backend", connected: false, tools: 0, message: "Agent process stopped." });
  });
  return host;
}

function rpc(request: HostRequest): Promise<unknown> {
  const process = agentHost();
  if (request.type === "approve") {
    process.postMessage(request);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(request.id);
      reject(new Error("Agent request timed out. Stop the operation before retrying."));
    }, request.type === "prompt" ? 15 * 60_000 : 60_000);
    pending.set(request.id, { resolve, reject, timer });
    process.postMessage(request);
  });
}

async function createWindow(): Promise<void> {
  window = new BrowserWindow({
    width: 1320, height: 900, minWidth: 980, minHeight: 700, title: "ChatStudio",
    backgroundColor: "#11151c",
    webPreferences: { preload: path.join(here, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.on("closed", () => { window = undefined; });
  await window.loadFile(path.join(here, "../renderer/index.html"));
  if (process.argv.includes("--smoke-test")) {
    const result = await window.webContents.executeJavaScript(`({
      title: document.title,
      heading: document.querySelector('h1')?.textContent,
      bridge: typeof window.chatstudio?.catalog === 'function'
    })`);
    console.log("CHATSTUDIO_SMOKE", JSON.stringify(result));
    const catalog = await rpc({ type: "catalog", id: randomUUID() });
    console.log("CHATSTUDIO_MODELS", Array.isArray(catalog) ? catalog.length : 0);
    app.quit();
  }
}

async function initialize(): Promise<void> {
await app.whenReady();
app.setName("ChatStudio");
privateRoot = app.getPath("userData");
if (process.argv.includes("--smoke-test")) {
  privateRoot = path.join(app.getPath("temp"), "chatstudio-smoke");
}
await mkdir(privateRoot, { recursive: true, mode: 0o700 });
const configPath = path.join(privateRoot, "config.json");
const channels: Record<string, (...args: unknown[]) => unknown> = {
  "config:load": async () => {
    try { return validateConfig(JSON.parse(await readFile(configPath, "utf8"))); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        try {
          return validateConfig(JSON.parse(await readFile(path.join(app.getAppPath(), ".runtime/backend.json"), "utf8")));
        } catch (runtimeError) {
          if (runtimeError && typeof runtimeError === "object" && "code" in runtimeError && runtimeError.code === "ENOENT") return defaultConfig();
          throw runtimeError;
        }
      }
      throw error;
    }
  },
  "config:save": async (config) => writeFile(configPath, JSON.stringify(validateConfig(config), null, 2), { mode: 0o600 }),
  "workspace:choose": async () => {
    if (!window) throw new Error("Window unavailable.");
    const result = await dialog.showOpenDialog(window, { title: "Choose a dedicated ChatStudio project folder", properties: ["openDirectory", "createDirectory"] });
    return result.canceled ? null : result.filePaths[0];
  },
  "agent:catalog": () => rpc({ type: "catalog", id: randomUUID() }),
  "agent:connect": (config) => rpc({ type: "connect", id: randomUUID(), config: validateConfig(config, true) }),
  "agent:disconnect": () => rpc({ type: "disconnect", id: randomUUID() }),
  "agent:reset": () => rpc({ type: "reset", id: randomUUID() }),
  "agent:abort": () => rpc({ type: "abort", id: randomUUID() }),
  "agent:approve": (id, allowed, session) => {
    if (typeof id !== "string" || typeof allowed !== "boolean" || typeof session !== "boolean") throw new Error("Invalid approval.");
    return rpc({ type: "approve", approvalId: id, allowed, session });
  },
  "agent:revoke": (name) => {
    if (typeof name !== "string" || !name || name.length > 150) throw new Error("Invalid tool name.");
    return rpc({ type: "revoke", id: randomUUID(), name });
  },
  "agent:prompt": (input) => {
    if (!input || typeof input !== "object") throw new Error("Invalid message.");
    if (!("provider" in input && typeof input.provider === "string" && "model" in input && typeof input.model === "string"
      && "apiKey" in input && typeof input.apiKey === "string" && "text" in input && typeof input.text === "string")) throw new Error("Invalid message fields.");
    const endpoint = input.provider === CUSTOM_PROVIDER
      ? validateCustomEndpoint({ baseUrl: "baseUrl" in input ? input.baseUrl : undefined, model: input.model }) : undefined;
    return rpc({ type: "prompt", id: randomUUID(), provider: input.provider, model: endpoint?.model ?? input.model,
      apiKey: input.apiKey, text: input.text, ...(endpoint ? { baseUrl: endpoint.baseUrl } : {}) });
  },
};
for (const [channel, handler] of Object.entries(channels)) {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error("Untrusted IPC sender.");
    }
    return handler(...args);
  });
}
app.on("before-quit", (event) => {
  if (!host || quitting) return;
  event.preventDefault();
  quitting = true;
  const timeout = setTimeout(() => { host?.kill(); app.quit(); }, 5000);
  void rpc({ type: "disconnect", id: randomUUID() }).catch((error: unknown) => {
    console.error("Backend shutdown failed:", error instanceof Error ? error.message : String(error));
  }).finally(() => { clearTimeout(timeout); host?.kill(); app.quit(); });
});
app.on("window-all-closed", () => app.quit());
await createWindow();
}

void initialize().catch((error: unknown) => {
  console.error("ChatStudio startup failed:", error instanceof Error ? error.message : String(error));
  app.exit(1);
});
