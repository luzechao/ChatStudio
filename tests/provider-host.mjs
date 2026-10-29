import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ChatAgent } from "../dist/main/agent.js";
import { OpenStudioBackend } from "../dist/main/mcp.js";
import { configureSystemTrust } from "../dist/main/network.js";

configureSystemTrust();
const [baseUrl, privateRoot, provider = "chatstudio-custom", webMode = "off"] = process.argv.slice(2);
const webRequests = [];
if (webMode !== "off") {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith("https://mcp.exa.ai/")) {
      webRequests.push({ url: String(url), headers: options.headers, body: JSON.parse(options.body) });
      return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{
        type: "text", text: "Title: OpenStudio SDK\nURL: https://openstudio.net\nText: Public documentation",
      }] } });
    }
    return originalFetch(url, options);
  };
}
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
  (event) => {
    events.push(event);
    if (event.type === "approval") agent.approvals.answer(event.id, webMode !== "deny");
  }, runtime);
try {
  await agent.setInternetAccess(webMode !== "off");
  await agent.prompt(provider, modelId, "synthetic-local-key", "Say hello.", baseUrl);
  process.parentPort.postMessage({ events, credentials: await runtime.listCredentials(), webRequests });
} catch (error) {
  process.parentPort.postMessage({ failure: error.message, events });
} finally {
  await agent.reset();
}
