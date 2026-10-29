import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ChatAgent } from "../dist/main/agent.js";
import { OpenStudioBackend } from "../dist/main/mcp.js";
import { configureSystemTrust } from "../dist/main/network.js";

configureSystemTrust();
const [baseUrl, privateRoot, provider = "chatstudio-custom"] = process.argv.slice(2);
const runtime = await ModelRuntime.create({
  credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
});
const events = [];
const modelId = provider === "openrouter" ? "~anthropic/claude-haiku-latest" : "diagnostic";
if (provider === "openrouter") {
  const model = runtime.getModel(provider, modelId);
  if (!model) throw new Error("Missing OpenRouter Haiku Latest model.");
  runtime.registerProvider(provider, { baseUrl, models: [{ ...model, baseUrl }] });
}
const agent = new ChatAgent(new OpenStudioBackend(() => {}), () => privateRoot, privateRoot,
  (event) => events.push(event), runtime);
try {
  await agent.prompt(provider, modelId, "synthetic-local-key", "Say hello.", baseUrl);
  process.parentPort.postMessage({ events, credentials: await runtime.listCredentials() });
} catch (error) {
  process.parentPort.postMessage({ failure: error.message, events });
} finally {
  await agent.reset();
}
