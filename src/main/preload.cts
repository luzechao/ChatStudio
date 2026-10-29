import { contextBridge, ipcRenderer } from "electron";
import type { ChatStudioAPI, AgentEvent } from "../shared/contracts.js";

const api: ChatStudioAPI = {
  loadConfig: () => ipcRenderer.invoke("config:load"),
  saveConfig: (config) => ipcRenderer.invoke("config:save", config),
  chooseWorkspace: () => ipcRenderer.invoke("workspace:choose"),
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
