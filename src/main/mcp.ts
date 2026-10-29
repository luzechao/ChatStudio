import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SandboxManager } from "@carderne/sandbox-runtime";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig, AgentEvent } from "../shared/contracts.js";
import { prepareSandbox } from "./sandbox.js";

export class OpenStudioBackend {
  private client?: Client;
  tools: Tool[] = [];

  constructor(private emit: (event: AgentEvent) => void) {}

  async connect(config: AppConfig, privateRoot: string): Promise<void> {
    await this.disconnect();
    try {
      const { warnings, ...launch } = await prepareSandbox(config, privateRoot);
      const transport = new StdioClientTransport({ ...launch, stderr: "pipe", maxBufferSize: 2 * 1024 * 1024 });
      let diagnostics = "";
      transport.stderr?.on("data", (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString()).slice(-4000); });
      const client = new Client({ name: "ChatStudio", version: "0.1.0" });
      this.client = client;
      client.onclose = () => {
        this.tools = [];
        this.emit({ type: "backend", connected: false, tools: 0, message: "Native backend disconnected." });
      };
      client.onerror = (error) => this.emit({ type: "error", message: `MCP transport: ${error.message}` });
      try {
        await client.connect(transport, { timeout: 30_000 });
        const names = new Set<string>();
        let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: 15_000 });
          for (const tool of page.tools) {
            if (names.has(tool.name)) throw new Error(`Duplicate backend tool: ${tool.name}`);
            names.add(tool.name);
            this.tools.push(tool);
          }
          cursor = page.nextCursor;
          if (this.tools.length > 1000) throw new Error("Backend advertised too many tools.");
        } while (cursor);
        if (!this.tools.length) throw new Error("Backend registered no tools. Check native SDK and Python dependencies.");
      } catch (error) {
        throw new Error(`Native MCP startup failed: ${error instanceof Error ? error.message : String(error)}${diagnostics ? `\n${diagnostics}` : ""}`);
      }
      this.emit({
        type: "backend", connected: true, tools: this.tools.length,
        message: `Sandboxed backend connected. Internet access ${config.internetAccess ? "enabled" : "disabled"}. ${warnings.join(" ")}`.trim(),
      });
    } catch (error) {
      await this.disconnect();
      throw error;
    }
  }

  search(query: string) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return this.tools.map((tool) => ({
      tool,
      score: terms.reduce((n, term) => n + (tool.name.toLowerCase().includes(term) ? 3 : 0)
        + (tool.description?.toLowerCase().includes(term) ? 1 : 0), 0),
    })).filter(({ score }) => score > 0 || !terms.length)
      .sort((a, b) => b.score - a.score).slice(0, 8).map(({ tool }) => tool);
  }

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    if (!this.client || !this.tools.some((tool) => tool.name === name)) throw new Error(`Tool is unavailable: ${name}`);
    return this.client.callTool({ name, arguments: args }, undefined, { signal, timeout: 120_000 });
  }

  async disconnect(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.tools = [];
    try {
      await client?.close();
    } finally {
      await SandboxManager.reset();
    }
  }
}
