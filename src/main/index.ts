import { app, BrowserWindow, dialog, ipcMain, safeStorage, utilityProcess, type UtilityProcess } from "electron";
import { mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfig, validateConfig } from "./config.js";
import type { AppConfig, HostRequest, HostMessage } from "../shared/contracts.js";
import type { InspectionKind } from "../shared/inspection.js";
import { CUSTOM_PROVIDER, validateCustomEndpoint } from "../shared/contracts.js";
import { bundledConfig } from "./native-runtime.js";
import { Projects } from "./projects.js";
import { Credentials } from "./credentials.js";
import { projectFile } from "./inspection.js";
import { getSrtWinPath, getWindowsSandboxUserStatus, installWindowsSandbox } from "@carderne/sandbox-runtime";

const here = path.dirname(fileURLToPath(import.meta.url));
let window: BrowserWindow | undefined;
let host: UtilityProcess | undefined;
let quitting = false;
let privateRoot = "";
let promptRunning = false;
let projectChanging = false;
let viewerRunning = false;
let viewerHost: UtilityProcess | undefined;
let viewerTask: Promise<unknown> | undefined;
let capturedReply = "";
let capturedError = "";
let projects: Projects;
const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

function agentHost(): UtilityProcess {
  if (host) return host;
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot", "TEMP", "TMP", "LANG", "CHATSTUDIO_SANDBOX_HELPERS"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  host = utilityProcess.fork(path.join(here, "agent-host.js"), [privateRoot], { env, serviceName: "ChatStudio agent", stdio: "pipe" });
  host.on("message", (message: HostMessage) => {
    if (message.type === "event") {
      if (promptRunning && message.event.type === "text") capturedReply += message.event.text;
      if (promptRunning && message.event.type === "error") capturedError = message.event.message;
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
      if (request.type === "prompt") process.kill();
      reject(new Error("Agent request timed out. Stop the operation before retrying."));
    }, request.type === "prompt" ? 15 * 60_000 : 60_000);
    pending.set(request.id, { resolve, reject, timer });
    process.postMessage(request);
  });
}

async function inspect(config: AppConfig, kind: InspectionKind, file: string): Promise<unknown> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot", "TEMP", "TMP", "LANG", "CHATSTUDIO_SANDBOX_HELPERS"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const child = utilityProcess.fork(path.join(here, "inspection-host.js"), [], { env, serviceName: "ChatStudio viewer", stdio: "pipe" });
  viewerHost = child;
  try {
    viewerTask = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error("Viewer request timed out.")); }, 100_000);
      child.on("message", (message: { error?: string; value?: unknown }) => {
        clearTimeout(timer);
        if (message.error) reject(new Error(message.error)); else resolve(message.value);
      });
      child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`Viewer process stopped (${code}).`)); });
      child.postMessage({ config, privateRoot, kind, file });
    });
    return await viewerTask;
  } finally { child.kill(); viewerHost = undefined; viewerTask = undefined; }
}

async function createWindow(): Promise<void> {
  window = new BrowserWindow({
    width: 1320, height: 900, minWidth: 980, minHeight: 700, title: "ChatStudio",
    backgroundColor: "#11151c",
    icon: path.join(app.getAppPath(), "assets/chatstudio-logo.png"),
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
projects = new Projects(privateRoot);
const credentials = new Credentials(privateRoot, safeStorage);
const configPath = path.join(privateRoot, "config.json");
const bundleRoot = path.join(process.resourcesPath, "native");
if (app.isPackaged) process.env.CHATSTUDIO_SANDBOX_HELPERS = path.join(bundleRoot, "sandbox");
let hasBundle = false;
if (app.isPackaged) {
  try { await readFile(path.join(bundleRoot, "manifest.json")); hasBundle = true; }
  catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
}
const loadConfig = async (): Promise<AppConfig> => {
    try {
      const saved = validateConfig(JSON.parse(await readFile(configPath, "utf8")));
      if (saved.bundledRuntime) {
        if (!hasBundle) throw new Error("Saved configuration requires a bundled native runtime, but this installer has none.");
        return { ...saved, backend: (await bundledConfig(bundleRoot, saved.workspace)).backend };
      }
      return saved;
    }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        if (hasBundle) return bundledConfig(bundleRoot, path.join(app.getPath("documents"), "ChatStudio Projects", "first-building"));
        try {
          return validateConfig(JSON.parse(await readFile(path.join(app.getAppPath(), ".runtime/backend.json"), "utf8")));
        } catch (runtimeError) {
          if (runtimeError && typeof runtimeError === "object" && "code" in runtimeError && runtimeError.code === "ENOENT") return defaultConfig();
          throw runtimeError;
        }
      }
      throw error;
    }
};
const inspectFile = async (kind: InspectionKind, file: unknown) => {
  if (viewerRunning || projectChanging || promptRunning) throw new Error("Wait for the current operation before loading a viewer.");
  if (!projects.workspace || typeof file !== "string") throw new Error("Open a project and choose a file first.");
  viewerRunning = true;
  try {
    if (process.platform === "win32") await rpc({ type: "disconnect", id: randomUUID() });
    return await inspect({ ...await loadConfig(), workspace: projects.workspace }, kind, file);
  }
  finally { viewerRunning = false; }
};
const channels: Record<string, (...args: unknown[]) => unknown> = {
  "sandbox:status": () => ({
    windows: process.platform === "win32",
    ready: process.platform !== "win32" || getWindowsSandboxUserStatus().provisioned,
  }),
  "sandbox:install": async () => {
    if (process.platform !== "win32") throw new Error("Windows sandbox setup is only available on Windows.");
    if (promptRunning || projectChanging || viewerRunning) throw new Error("Wait for the current operation before sandbox setup.");
    projectChanging = true;
    try {
      const result = installWindowsSandbox();
      if (result.cancelled) throw new Error("Windows sandbox setup was cancelled. Native execution remains disabled.");
      if (!result.user.provisioned) throw new Error("Windows sandbox setup did not provision the sandbox account.");
      await promisify(execFile)(getSrtWinPath(), ["exec", "--quiet", "--",
        path.join(process.env.SystemRoot || "C:\\Windows", "System32/whoami.exe")],
      { cwd: process.env.SystemRoot || "C:\\Windows", timeout: 120_000 });
    } finally { projectChanging = false; }
  },
  "credential:load": (scope) => credentials.load(scope),
  "credential:save": (scope, apiKey) => credentials.save(scope, apiKey),
  "credential:forget": (scope) => credentials.forget(scope),
  "config:load": loadConfig,
  "viewer:model": (file) => inspectFile("model", file),
  "viewer:results": (file) => inspectFile("results", file),
  "viewer:report": async (file) => {
    if (!projects.workspace || projectChanging) throw new Error("Open a project first.");
    const resolved = await projectFile(projects.workspace, file, [".html", ".htm"]);
    const handle = await open(resolved, "r");
    try {
      if ((await handle.stat()).size > 10 * 1024 * 1024) throw new Error("HTML report exceeds the 10 MB viewing limit.");
      return await handle.readFile("utf8");
    } finally { await handle.close(); }
  },
  "config:save": async (config) => writeFile(configPath, JSON.stringify(validateConfig(config), null, 2), { mode: 0o600 }),
  "runtime:bundled": async (workspace) => {
    if (!hasBundle) return null;
    if (typeof workspace !== "string") throw new Error("Invalid project folder.");
    const config = validateConfig({ ...defaultConfig(),
      workspace: workspace || path.join(app.getPath("documents"), "ChatStudio Projects", "first-building") });
    return bundledConfig(bundleRoot, config.workspace);
  },
  "workspace:choose": async () => {
    if (!window) throw new Error("Window unavailable.");
    const result = await dialog.showOpenDialog(window, { title: "Choose a dedicated ChatStudio project folder", properties: ["openDirectory", "createDirectory"] });
    return result.canceled ? null : result.filePaths[0];
  },
  "project:recent": () => projects.recent(),
  "project:state": () => projects.state(),
  "project:open": async (workspace) => {
    if (promptRunning || projectChanging || viewerRunning) throw new Error("Wait for the current operation before switching projects.");
    if (typeof workspace !== "string" || !workspace) throw new Error("Choose a project folder.");
    projectChanging = true;
    try {
      return await projects.load(workspace, async (project) => {
        await rpc({ type: "project", id: randomUUID(), workspace: project.path });
      });
    } finally { projectChanging = false; }
  },
  "agent:catalog": () => rpc({ type: "catalog", id: randomUUID() }),
  "agent:connect": async (config) => {
    if (promptRunning || projectChanging || viewerRunning) throw new Error("Wait for the current operation before connecting.");
    projectChanging = true;
    try {
      const validated = validateConfig(config, true);
      if (projects.workspace && projects.workspace !== await realpath(validated.workspace)) throw new Error("Open this project before connecting its local engine.");
      return await rpc({ type: "connect", id: randomUUID(), config: validated });
    } finally { projectChanging = false; }
  },
  "agent:disconnect": async () => {
    if (promptRunning || projectChanging || viewerRunning) throw new Error("Wait for the current operation before disconnecting.");
    projectChanging = true;
    try { return await rpc({ type: "disconnect", id: randomUUID() }); }
    finally { projectChanging = false; }
  },
  "agent:reset": async () => {
    if (promptRunning || projectChanging) throw new Error("Wait for the current operation before starting a new conversation.");
    projectChanging = true;
    try {
      await rpc({ type: "reset", id: randomUUID() });
      projects.newConversation();
    } finally { projectChanging = false; }
  },
  "agent:abort": () => rpc({ type: "abort", id: randomUUID() }),
  "agent:approve": (id, allowed, session) => {
    if (typeof id !== "string" || typeof allowed !== "boolean" || typeof session !== "boolean") throw new Error("Invalid approval.");
    return rpc({ type: "approve", approvalId: id, allowed, session });
  },
  "agent:revoke": (name) => {
    if (typeof name !== "string" || !name || name.length > 150) throw new Error("Invalid tool name.");
    return rpc({ type: "revoke", id: randomUUID(), name });
  },
  "agent:prompt": async (input) => {
    if (promptRunning || projectChanging || viewerRunning) throw new Error("Wait for the current operation to finish.");
    if (!input || typeof input !== "object") throw new Error("Invalid message.");
    if (!("provider" in input && typeof input.provider === "string" && "model" in input && typeof input.model === "string"
      && "apiKey" in input && typeof input.apiKey === "string" && "text" in input && typeof input.text === "string")) throw new Error("Invalid message fields.");
    const endpoint = input.provider === CUSTOM_PROVIDER
      ? validateCustomEndpoint({ baseUrl: "baseUrl" in input ? input.baseUrl : undefined, model: input.model }) : undefined;
    if (!input.apiKey.trim()) throw new Error("Enter a provider API key in Settings.");
    promptRunning = true; capturedReply = ""; capturedError = "";
    const key = input.apiKey;
    const redact = (text: string) => text.replaceAll(key, "[redacted]");
    let userSaved = false;
    try {
      await projects.append({ role: "user", text: redact(input.text) });
      userSaved = true;
      await rpc({ type: "prompt", id: randomUUID(), provider: input.provider, model: endpoint?.model ?? input.model,
        apiKey: input.apiKey, text: input.text, ...(endpoint ? { baseUrl: endpoint.baseUrl } : {}) });
    } catch (error) {
      capturedError = redact(error instanceof Error ? error.message : String(error));
      throw new Error(capturedError);
    } finally {
      try {
        const text = capturedReply + (capturedError ? `\n\nRequest error: ${capturedError}` : "");
        if (userSaved && text) await projects.append({ role: "assistant", text: redact(text) });
      } finally { promptRunning = false; capturedReply = ""; capturedError = ""; }
    }
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
  if ((!host && !viewerHost) || quitting) return;
  event.preventDefault();
  quitting = true;
  viewerHost?.postMessage({ type: "cancel" });
  const timeout = setTimeout(() => { host?.kill(); viewerHost?.kill(); app.quit(); }, 5000);
  void Promise.all([host ? rpc({ type: "disconnect", id: randomUUID() }) : undefined, viewerTask]).catch((error: unknown) => {
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
