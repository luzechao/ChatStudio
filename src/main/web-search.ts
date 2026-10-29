import { CallToolResultSchema, JSONRPCResponseSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Approvals } from "./approvals.js";

const ENDPOINT = "https://mcp.exa.ai/mcp?tools=web_search_exa";
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_RESULT_CHARACTERS = 16_000;

async function responseText(response: Response): Promise<string> {
  if (!response.body) throw new Error("Web search returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("Web search response exceeded the size limit.");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    try { await reader.cancel(); }
    finally { reader.releaseLock(); }
  }
}

function searchContent(body: string, eventStream: boolean): string {
  const payloads = eventStream
    ? body.replaceAll("\r\n", "\n").split("\n\n")
      .map((event) => event.split("\n").filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart()).join("\n")).filter(Boolean)
    : [body];
  for (const payload of payloads) {
    const message = JSONRPCResponseSchema.parse(JSON.parse(payload));
    if (message.id !== 1) continue;
    if ("error" in message) throw new Error(`Web search failed: ${message.error.message.slice(0, 500)}`);
    const result = CallToolResultSchema.parse(message.result);
    if (result._meta?.["ai.exa/rateLimited"] === true) {
      throw new Error("Exa web search rate limit reached. Try again later.");
    }
    const text = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n").trim();
    if (result.isError) throw new Error(`Web search failed: ${text.slice(0, 500)}`);
    if (!text) throw new Error("Web search returned no text results.");
    return JSON.stringify({
      provider: "Exa", untrusted: true,
      text: text.slice(0, MAX_RESULT_CHARACTERS), truncated: text.length > MAX_RESULT_CHARACTERS,
    });
  }
  throw new Error("Web search returned no matching response.");
}

export class WebSearch {
  private allowed = false;
  private lifetime = new AbortController();

  constructor(private approvals: Approvals, private request: typeof fetch = fetch) {}

  get enabled(): boolean { return this.allowed; }

  setEnabled(enabled: boolean): void {
    if (enabled === this.allowed) return;
    this.lifetime.abort();
    this.lifetime = new AbortController();
    this.allowed = enabled;
  }

  async search(query: string, numResults: number, signal?: AbortSignal): Promise<string> {
    if (!this.allowed) throw new Error("Internet access is off. Enable it in Settings to use web search.");
    if (!query.trim() || query.length > 500 || !Number.isInteger(numResults) || numResults < 1 || numResults > 5) {
      throw new Error("Web search requires a query of 1-500 characters and 1-5 results.");
    }
    const permissionSignal = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
    const approved = await this.approvals.request("web_search", { query, numResults, provider: "Exa" }, permissionSignal);
    permissionSignal.throwIfAborted();
    if (!this.allowed) throw new Error("Internet access is off.");
    if (!approved) throw new Error("Web search was not approved.");
    const requestSignal = AbortSignal.any([permissionSignal, AbortSignal.timeout(30_000)]);
    const response = await this.request(ENDPOINT, {
      method: "POST", redirect: "error", credentials: "omit", signal: requestSignal,
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "web_search_exa", arguments: { query, numResults, contextMaxCharacters: 12_000 } },
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(response.status === 429 ? "Exa web search rate limit reached. Try again later."
        : `Web search failed (HTTP ${response.status}).`);
    }
    const body = await responseText(response);
    requestSignal.throwIfAborted();
    return searchContent(body, response.headers.get("content-type")?.includes("text/event-stream") === true);
  }
}
