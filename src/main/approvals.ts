import { randomUUID } from "node:crypto";
import type { AgentEvent } from "../shared/contracts.js";

export class Approvals {
  private pending = new Map<string, { name: string; finish: (allowed: boolean) => void }>();
  private trusted = new Set<string>();

  constructor(private emit: (event: AgentEvent) => void) {}

  request(name: string, args: unknown, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    if (this.trusted.has(name)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const id = randomUUID();
      const finish = (allowed: boolean) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.pending.delete(id);
        resolve(allowed);
      };
      const abort = () => finish(false);
      const timer = setTimeout(abort, 120_000);
      this.pending.set(id, { name, finish });
      signal?.addEventListener("abort", abort, { once: true });
      this.emit({ type: "approval", id, name, arguments: JSON.stringify(args, null, 2).slice(0, 16_000) });
    });
  }

  answer(id: string, allowed: boolean, session = false): void {
    const pending = this.pending.get(id);
    if (!pending) throw new Error("Approval expired or was already answered.");
    if (session && !allowed) throw new Error("Only an allowed tool can receive session permission.");
    if (session) {
      this.trusted.add(pending.name);
      this.publish();
    }
    pending.finish(allowed);
  }

  private publish(): void {
    this.emit({ type: "permissions", tools: [...this.trusted].sort() });
  }

  revoke(name: string): void {
    if (!this.trusted.delete(name)) throw new Error("Tool has no active session permission.");
    this.publish();
  }

  clearSession(): void {
    this.cancelAll();
    this.trusted.clear();
    this.publish();
  }

  cancelAll(): void {
    for (const { finish } of [...this.pending.values()]) finish(false);
  }
}
