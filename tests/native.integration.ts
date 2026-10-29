import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { OpenStudioBackend } from "../src/main/mcp.js";
import { ChatAgent } from "../src/main/agent.js";
import { validateConfig } from "../src/main/config.js";
import type { AgentEvent } from "../src/shared/contracts.js";

function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

function payload(result: unknown): Record<string, unknown> {
  const outer = object(result);
  assert.notEqual(outer.isError, true, JSON.stringify(outer));
  if (outer.structuredContent) return object(outer.structuredContent);
  assert.ok(Array.isArray(outer.content));
  const text = outer.content.map((c: unknown) => object(c).text).join("\n");
  return object(JSON.parse(text));
}

test("native SDK + 206 MCP tools + 18 skills + approved Pi tool loop run inside the OS sandbox", { timeout: 90_000 }, async () => {
  const base = await mkdtemp(path.join(tmpdir(), "chatstudio-native-"));
  const privateRoot = path.join(base, "private");
  const workspace = path.join(base, "workspace");
  await mkdir(privateRoot); await mkdir(workspace);
  const events: AgentEvent[] = [];
  const backend = new OpenStudioBackend((event) => events.push(event));
  let agent: ChatAgent | undefined;
  let approveCalls = true;
  try {
    const config = validateConfig(JSON.parse(await readFile(new URL("../.runtime/backend.json", import.meta.url), "utf8")), true);
    config.workspace = workspace;
    await backend.connect(config, privateRoot);
    assert.equal(backend.tools.length, 206);
    assert.ok(events.some((e) => e.type === "backend" && e.connected));
    const skills = payload(await backend.call("list_skills", {}));
    assert.equal(skills.ok, true);
    assert.ok(Array.isArray(skills.skills));
    assert.equal(skills.skills.length, 18);

    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
    const faux = fauxProvider({ provider: "chatstudio-test", models: [{ id: "scripted", name: "Local scripted test" }] });
    runtime.registerNativeProvider(faux.provider);
    faux.setResponses([
      (context) => {
        const tools = context.messages.flatMap((m) => m.role === "system" ? m.toolsAdded ?? [] : []);
        assert.deepEqual(tools.map((t) => t.name).sort(), ["call_openstudio_tool", "search_openstudio_tools"]);
        return fauxAssistantMessage(fauxToolCall("search_openstudio_tools", { query: "create_example_osm" }), { stopReason: "toolUse" });
      },
      fauxAssistantMessage(fauxToolCall("call_openstudio_tool", { name: "create_example_osm", arguments: { name: "chatstudio-gate" } }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("call_openstudio_tool", { name: "get_model_summary", arguments: {} }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Native OpenStudio model created and inspected."),
    ]);
    agent = new ChatAgent(backend, () => workspace, privateRoot, (event) => {
      events.push(event);
      if (event.type === "approval") agent!.approvals.answer(event.id, approveCalls);
    }, runtime);
    await agent.prompt("chatstudio-test", "scripted", "synthetic-test-key", "Create and inspect an example model.");
    assert.equal(events.filter((e) => e.type === "approval").length, 2);
    assert.ok(events.some((e) => e.type === "text" && e.text.includes("Native")));
    assert.equal(events.filter((e) => e.type === "tool" && e.error).length, 0);
    const summary = payload(await backend.call("get_model_summary", {}));
    assert.equal(summary.ok, true, JSON.stringify(summary));
    const model = object(summary.summary);
    assert.equal(model.spaces, 4);
    assert.equal(model.thermal_zones, 1);
    const saved = payload(await backend.call("save_osm_model", { save_name: "chatstudio-verified" }));
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal(typeof saved.osm_path, "string");
    if (typeof saved.osm_path !== "string") throw new Error("Missing model artifact path.");
    assert.match(await readFile(saved.osm_path, "utf8"), /OS:Version/);
    assert.deepEqual(await runtime.listCredentials(), []);

    let sessionApprovals = 0;
    const trustedAgent = new ChatAgent(backend, () => workspace, privateRoot, (event) => {
      if (event.type === "approval") {
        sessionApprovals++;
        trustedAgent.approvals.answer(event.id, true, true);
      }
    }, runtime);
    try {
      const responses = () => [
        fauxAssistantMessage(fauxToolCall("call_openstudio_tool", { name: "get_model_summary", arguments: {} }), { stopReason: "toolUse" }),
        fauxAssistantMessage("Summary checked."),
      ];
      for (let i = 0; i < 2; i++) {
        faux.setResponses(responses());
        await trustedAgent.prompt("chatstudio-test", "scripted", "synthetic-test-key", "Inspect model.");
      }
      assert.equal(sessionApprovals, 1);
      trustedAgent.approvals.revoke("get_model_summary");
      faux.setResponses(responses());
      await trustedAgent.prompt("chatstudio-test", "scripted", "synthetic-test-key", "Inspect again.");
      assert.equal(sessionApprovals, 2);
      await trustedAgent.reset();
      faux.setResponses(responses());
      await trustedAgent.prompt("chatstudio-test", "scripted", "synthetic-test-key", "New conversation.");
      assert.equal(sessionApprovals, 3);
    } finally { await trustedAgent.reset(); }

    approveCalls = false;
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("call_openstudio_tool", { name: "create_space", arguments: { name: "Denied Space" } }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Your refusal was respected."),
    ]);
    await agent.prompt("chatstudio-test", "scripted", "synthetic-test-key", "Attempt an edit that will be denied.");
    assert.equal(events.filter((e) => e.type === "tool" && e.error).length, 1);
    assert.equal(object(payload(await backend.call("get_model_summary", {})).summary).spaces, 4);
    assert.deepEqual(await runtime.listCredentials(), []);
    assert.ok(!JSON.stringify(events).includes("synthetic-test-key"));

    faux.setResponses([() => { throw new Error("Provider rejected replacement-synthetic-key"); }]);
    await agent.prompt("chatstudio-test", "scripted", "replacement-synthetic-key", "Verify provider error redaction.");
    assert.ok(events.some((e) => e.type === "error" && e.message.includes("[redacted]")));
    assert.ok(!JSON.stringify(events).includes("replacement-synthetic-key"));
    assert.deepEqual(await runtime.listCredentials(), []);
  } finally {
    await agent?.reset();
    await backend.disconnect();
    await rm(base, { recursive: true, force: true });
  }
});
