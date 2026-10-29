import assert from "node:assert/strict";
import test from "node:test";
import { Approvals } from "../src/main/approvals.js";
import { WebSearch } from "../src/main/web-search.js";
import type { AgentEvent } from "../src/shared/contracts.js";

const reply = (text = "Title: OpenStudio\nURL: https://openstudio.net\nText: SDK documentation") =>
  ({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } });

function fixture(request: typeof fetch) {
  const events: AgentEvent[] = [];
  const approvals = new Approvals((event) => events.push(event));
  const search = new WebSearch(approvals, request);
  const answer = (allowed: boolean, session = false) => {
    const event = [...events].reverse().find((event) => event.type === "approval");
    assert.ok(event?.type === "approval");
    approvals.answer(event.id, allowed, session);
  };
  return { search, approvals, events, answer };
}

test("web search is off by default, approval gated, and disabled again after permission changes", async () => {
  const requests: { url: string; options?: RequestInit }[] = [];
  const { search, answer, events } = fixture(async (url, options) => {
    requests.push({ url: String(url), options });
    return Response.json(reply());
  });
  await assert.rejects(search.search("OpenStudio docs", 2), /Internet access is off/);
  search.setEnabled(true);
  const denied = search.search("OpenStudio docs", 2);
  assert.equal(requests.length, 0);
  answer(false);
  await assert.rejects(denied, /not approved/);
  assert.equal(requests.length, 0);
  const allowed = search.search("OpenStudio docs", 2);
  answer(true, true);
  const result = JSON.parse(await allowed);
  assert.equal(result.provider, "Exa");
  assert.equal(result.untrusted, true);
  assert.match(result.text, /https:\/\/openstudio.net/);
  assert.equal(result.truncated, false);
  assert.equal(requests[0].url, "https://mcp.exa.ai/mcp?tools=web_search_exa");
  assert.equal(requests[0].options?.redirect, "error");
  assert.equal(requests[0].options?.credentials, "omit");
  assert.deepEqual(requests[0].options?.headers, {
    "Content-Type": "application/json", Accept: "application/json, text/event-stream",
  });
  assert.deepEqual(JSON.parse(String(requests[0].options?.body)), {
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "web_search_exa", arguments: { query: "OpenStudio docs", numResults: 2, contextMaxCharacters: 12_000 } },
  });
  const approval = events.find((event) => event.type === "approval");
  assert.ok(approval?.type === "approval");
  assert.deepEqual(JSON.parse(approval.arguments), { query: "OpenStudio docs", numResults: 2, provider: "Exa" });
  search.setEnabled(false);
  await assert.rejects(search.search("OpenStudio docs", 2), /Internet access is off/);
  assert.equal(requests.length, 1);
});

test("web search validates arguments and cancels pending approval when internet access is disabled", async () => {
  const { search, events } = fixture(async () => { throw new Error("Must not fetch"); });
  search.setEnabled(true);
  for (const [query, count] of [[" ", 1], ["x".repeat(501), 1], ["query", 0], ["query", 6], ["query", 1.5]] as const) {
    await assert.rejects(search.search(query, count), /requires a query/);
  }
  assert.deepEqual(events, []);
  const pending = search.search("public query", 1);
  search.setEnabled(false);
  await assert.rejects(pending, /abort/i);
});

test("web search cancels in-flight requests on Stop or permission revocation", async () => {
  for (const disable of [false, true]) {
    let started!: () => void;
    const fetching = new Promise<void>((resolve) => { started = resolve; });
    const { search, answer } = fixture(async (_url, options) => {
      started();
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      });
    });
    search.setEnabled(true);
    const controller = new AbortController();
    const pending = search.search("public query", 1, controller.signal);
    answer(true);
    await fetching;
    if (disable) search.setEnabled(false);
    else controller.abort();
    await assert.rejects(pending, /abort/i);
  }
});

test("web search handles SSE, bounds results, and surfaces provider/protocol failures", async () => {
  const cases = [
    { response: () => new Response(`event: message\r\ndata: ${JSON.stringify(reply("x".repeat(20_000)))}\r\n\r\n`,
      { headers: { "content-type": "text/event-stream" } }) },
    { response: () => new Response("", { status: 429 }), error: /rate limit/ },
    { response: () => new Response("private diagnostics", { status: 503 }), error: /HTTP 503/ },
    { response: () => Response.json({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "provider unavailable" } }), error: /provider unavailable/ },
    { response: () => Response.json({ ...reply(), result: { ...reply().result, _meta: { "ai.exa/rateLimited": true } } }), error: /rate limit/ },
    { response: () => Response.json({ ...reply(), result: { isError: true, content: [{ type: "text", text: "service failed" }] } }), error: /service failed/ },
    { response: () => Response.json(reply("")), error: /no text/ },
    { response: () => Response.json({ ...reply(), id: 2 }), error: /no matching response/ },
    { response: () => new Response("not JSON"), error: /JSON/ },
    { response: () => Response.json({ jsonrpc: "2.0", id: 1, result: {} }), error: /no text/ },
    { response: () => new Response("x".repeat(256 * 1024 + 1)), error: /size limit/ },
  ];
  for (const scenario of cases) {
    const { search, answer } = fixture(async () => scenario.response());
    search.setEnabled(true);
    const pending = search.search("public query", 5);
    answer(true);
    if (scenario.error) await assert.rejects(pending, scenario.error);
    else {
      const result = JSON.parse(await pending);
      assert.equal(result.text.length, 16_000);
      assert.equal(result.truncated, true);
    }
  }
});
