import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ChatAgent } from "../dist/main/agent.js";
import { OpenStudioBackend } from "../dist/main/mcp.js";
import { configureSystemTrust } from "../dist/main/network.js";

configureSystemTrust();
const [baseUrl, privateRoot] = process.argv.slice(2);
const runtime = await ModelRuntime.create({
  credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
});
const events = [];
const agent = new ChatAgent(new OpenStudioBackend(() => {}), () => privateRoot, privateRoot,
  (event) => events.push(event), runtime);
try {
  await agent.prompt("chatstudio-custom", "diagnostic", "synthetic-local-key", "Say hello.", baseUrl);
  process.parentPort.postMessage({ events, credentials: await runtime.listCredentials() });
} catch (error) {
  process.parentPort.postMessage({ failure: error.message, events });
} finally {
  await agent.reset();
}
