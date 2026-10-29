import assert from "node:assert/strict";
import test from "node:test";
import { Approvals } from "../src/main/approvals.js";
import type { AgentEvent } from "../src/shared/contracts.js";

test("approval is explicit, one-shot, and scoped to the requested call", async () => {
  const events: AgentEvent[] = [];
  const gate = new Approvals((e) => events.push(e));
  const result = gate.request("delete_object", { handle: "123" });
  const event = events[0];
  assert.equal(event.type, "approval");
  if (event.type !== "approval") throw new Error("Missing approval event.");
  assert.equal(event.name, "delete_object");
  assert.deepEqual(JSON.parse(event.arguments), { handle: "123" });
  gate.answer(event.id, true);
  assert.equal(await result, true);
  assert.throws(() => gate.answer(event.id, true), /expired/);
});

test("abort, denial and disconnect never approve a pending tool", async () => {
  const gate = new Approvals(() => {});
  const controller = new AbortController();
  const aborted = gate.request("run_simulation", {}, controller.signal);
  controller.abort();
  assert.equal(await aborted, false);
  assert.equal(await gate.request("run_simulation", {}, controller.signal), false);
  const pending = gate.request("apply_measure", {});
  gate.cancelAll();
  assert.equal(await pending, false);
});

test("session permission is tool-scoped, revocable and cleared on reset", async () => {
  const events: AgentEvent[] = [];
  const gate = new Approvals((event) => events.push(event));
  const first = gate.request("get_model_summary", {});
  const approval = events.find((event) => event.type === "approval");
  if (!approval || approval.type !== "approval") throw new Error("Missing approval.");
  gate.answer(approval.id, true, true);
  assert.equal(await first, true);
  const count = events.length;
  assert.equal(await gate.request("get_model_summary", { different: true }), true);
  assert.equal(events.length, count);
  const controller = new AbortController();
  controller.abort();
  assert.equal(await gate.request("get_model_summary", {}, controller.signal), false);
  const other = gate.request("delete_object", {});
  gate.cancelAll();
  assert.equal(await other, false);
  gate.revoke("get_model_summary");
  assert.throws(() => gate.revoke("get_model_summary"), /no active/);
  const again = gate.request("get_model_summary", {});
  const latest = events.filter((event) => event.type === "approval").at(-1);
  if (!latest || latest.type !== "approval") throw new Error("Missing approval.");
  gate.answer(latest.id, true, true);
  assert.equal(await again, true);
  gate.clearSession();
  const afterReset = gate.request("get_model_summary", {});
  assert.equal(events.at(-1)?.type, "approval");
  gate.cancelAll();
  assert.equal(await afterReset, false);
  assert.ok(events.some((event) => event.type === "permissions" && event.tools.includes("get_model_summary")));
  assert.ok(events.some((event) => event.type === "permissions" && event.tools.length === 0));
});

test("expired or denied requests cannot grant session permissions", async () => {
  const events: AgentEvent[] = [];
  const gate = new Approvals((event) => events.push(event));
  const request = gate.request("apply_measure", {});
  const event = events[0];
  if (event.type !== "approval") throw new Error("Missing approval.");
  assert.throws(() => gate.answer(event.id, false, true), /Only an allowed/);
  gate.cancelAll();
  assert.equal(await request, false);
  assert.throws(() => gate.answer(event.id, true, true), /expired/);
  assert.equal(events.filter((e) => e.type === "permissions").length, 0);
});
