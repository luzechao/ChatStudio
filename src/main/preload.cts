import { contextBridge, ipcRenderer } from "electron";
import type { ChatStudioAPI, AgentEvent } from "../shared/contracts.js";

const api: ChatStudioAPI = {
  loadConfig: () => ipcRenderer.invoke("config:load"),
  saveConfig: (config) => ipcRenderer.invoke("config:save", config),
  loadCredential: (scope) => ipcRenderer.invoke("credential:load", scope),
  saveCredential: (scope, apiKey) => ipcRenderer.invoke("credential:save", scope, apiKey),
  forgetCredential: (scope) => ipcRenderer.invoke("credential:forget", scope),
  bundledRuntime: (workspace) => ipcRenderer.invoke("runtime:bundled", workspace),
  chooseWorkspace: () => ipcRenderer.invoke("workspace:choose"),
  openProject: (workspace) => ipcRenderer.invoke("project:open", workspace),
  projectState: () => ipcRenderer.invoke("project:state"),
  recentProjects: () => ipcRenderer.invoke("project:recent"),
  inspectModel: (file) => ipcRenderer.invoke("viewer:model", file),
  inspectResults: (file) => ipcRenderer.invoke("viewer:results", file),
  readReport: (file) => ipcRenderer.invoke("viewer:report", file),
  catalog: () => ipcRenderer.invoke("agent:catalog"),
  connect: (config) => ipcRenderer.invoke("agent:connect", config),
  disconnect: () => ipcRenderer.invoke("agent:disconnect"),
  prompt: (input) => ipcRenderer.invoke("agent:prompt", input),
  reset: () => ipcRenderer.invoke("agent:reset"),
  abort: () => ipcRenderer.invoke("agent:abort"),
  approve: (id, allowed, session = false) => ipcRenderer.invoke("agent:approve", id, allowed, session),
  revokePermission: (name) => ipcRenderer.invoke("agent:revoke", name),
  onEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, event: AgentEvent) => listener(event);
    ipcRenderer.on("agent:event", handler);
    return () => ipcRenderer.removeListener("agent:event", handler);
  },
};
contextBridge.exposeInMainWorld("chatstudio", api);
