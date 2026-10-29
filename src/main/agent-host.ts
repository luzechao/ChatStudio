import { OpenStudioBackend } from "./mcp.js";
import { ChatAgent } from "./agent.js";
import { errorMessage, type AgentEvent, type HostMessage, type HostRequest } from "../shared/contracts.js";
import { configureSystemTrust } from "./network.js";

if (!process.parentPort) throw new Error("Agent host must run as an Electron utility process.");
configureSystemTrust();
const port = process.parentPort;
const privateRoot = process.argv[2];
if (!privateRoot) throw new Error("Missing ChatStudio private data directory.");
const emit = (event: AgentEvent) => port.postMessage({ type: "event", event } satisfies HostMessage);
const backend = new OpenStudioBackend((event) => {
  if (event.type === "backend" && !event.connected) agent.approvals.clearSession();
  emit(event);
});
let workspace = "";
let connecting = false;
const agent = new ChatAgent(backend, () => workspace, privateRoot, emit);

port.on("message", async ({ data }: { data: HostRequest }) => {
  try {
    if (data.type === "approve") {
      agent.approvals.answer(data.approvalId, data.allowed, data.session);
      return;
    }
    let value: unknown;
    switch (data.type) {
      case "catalog": value = await agent.catalog(); break;
      case "connect":
        if (connecting || agent.isBusy) throw new Error("Wait for the current operation to finish.");
        connecting = true;
        try {
          await agent.reset();
          await backend.connect(data.config, privateRoot);
          workspace = data.config.workspace;
        } finally { connecting = false; }
        break;
      case "disconnect":
        if (connecting) throw new Error("Backend startup is in progress.");
        await agent.reset(); await backend.disconnect(); break;
      case "prompt":
        if (connecting) throw new Error("Backend startup is in progress.");
        await agent.prompt(data.provider, data.model, data.apiKey, data.text, data.baseUrl); break;
      case "abort": await agent.abort(); break;
      case "reset": await agent.reset(); break;
      case "revoke": agent.approvals.revoke(data.name); break;
    }
    port.postMessage({ type: "reply", id: data.id, value } satisfies HostMessage);
  } catch (error) {
    if (data.type === "approve") emit({ type: "error", message: errorMessage(error) });
    else port.postMessage({ type: "reply", id: data.id, error: errorMessage(error) } satisfies HostMessage);
  }
});
