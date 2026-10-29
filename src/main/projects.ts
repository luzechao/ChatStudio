import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { Conversation, ProjectFile, ProjectInfo, ProjectState, SavedMessage } from "../shared/contracts.js";
import { defaultConfig, validateConfig } from "./config.js";

async function readJson(file: string): Promise<unknown> {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try {
    try {
      await handle.writeFile(JSON.stringify(value, null, 2));
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temp, file);
  }
  finally { await rm(temp, { force: true }); }
}

function conversations(value: unknown): Conversation[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Invalid saved project conversations.");
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || !("id" in entry) || typeof entry.id !== "string"
      || !("title" in entry) || typeof entry.title !== "string"
      || !("updatedAt" in entry) || typeof entry.updatedAt !== "string"
      || !("messages" in entry) || !Array.isArray(entry.messages)) throw new Error("Invalid saved conversation.");
    const messages: SavedMessage[] = entry.messages.map((message: unknown) => {
      if (!message || typeof message !== "object" || !("role" in message) || !["user", "assistant"].includes(String(message.role))
        || !("text" in message) || typeof message.text !== "string") throw new Error("Invalid saved message.");
      return { role: message.role === "user" ? "user" : "assistant", text: message.text };
    });
    return { id: entry.id, title: entry.title, updatedAt: entry.updatedAt, messages };
  });
}

export class Projects {
  private current?: ProjectInfo;
  private history: Conversation[] = [];
  private conversationId?: string;
  private file = "";
  constructor(private privateRoot: string) {}

  get workspace(): string | undefined { return this.current?.path; }

  async recent(): Promise<ProjectInfo[]> {
    const value = await readJson(path.join(this.privateRoot, "projects.json"));
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every((item: unknown) => item && typeof item === "object"
      && "path" in item && typeof item.path === "string" && "name" in item && typeof item.name === "string")) {
      throw new Error("Invalid recent project registry.");
    }
    return value.map((item) => ({ path: String(item.path), name: String(item.name) }));
  }

  async load(workspace: string, activate?: (project: ProjectInfo) => Promise<void>): Promise<ProjectState> {
    validateConfig({ ...defaultConfig(), workspace });
    const resolved = await realpath(workspace);
    validateConfig({ ...defaultConfig(), workspace: resolved });
    if (!(await lstat(resolved)).isDirectory()) throw new Error("Project must be a folder.");
    const relative = path.relative(resolved, await realpath(this.privateRoot));
    const reverse = path.relative(await realpath(this.privateRoot), resolved);
    const inside = (value: string) => value === "" || (!value.startsWith(`..${path.sep}`) && value !== ".." && !path.isAbsolute(value));
    if (inside(relative) || inside(reverse)) throw new Error("Project folder must be separate from ChatStudio private data.");
    const project = { path: resolved, name: path.basename(resolved) };
    const directory = path.join(this.privateRoot, "conversations");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `${createHash("sha256").update(resolved).digest("hex")}.json`);
    const history = conversations(await readJson(file));
    const recent = await this.recent();
    const state = await this.snapshot(project, history);
    await writeJson(path.join(this.privateRoot, "projects.json"), [project, ...recent.filter((p) => p.path !== resolved)].slice(0, 20));
    await activate?.(project);
    this.current = project; this.file = file; this.history = history; this.conversationId = undefined;
    return state;
  }

  newConversation(): void { this.conversationId = undefined; }

  async append(message: SavedMessage): Promise<void> {
    if (!this.current) return;
    const next = structuredClone(this.history);
    let conversation = next.find((item) => item.id === this.conversationId);
    if (!conversation) {
      conversation = { id: randomUUID(), title: message.text.replace(/\s+/g, " ").slice(0, 80) || "Conversation",
        updatedAt: new Date().toISOString(), messages: [] };
      next.unshift(conversation);
    }
    conversation.messages.push(message);
    conversation.updatedAt = new Date().toISOString();
    await writeJson(this.file, next);
    this.conversationId = conversation.id; this.history = next;
  }

  async state(): Promise<ProjectState> {
    if (!this.current) throw new Error("Choose a project folder first.");
    return this.snapshot(this.current, this.history);
  }

  private async snapshot(project: ProjectInfo, history: Conversation[]): Promise<ProjectState> {
    const files: ProjectFile[] = [];
    let truncated = false;
    let visited = 0;
    const root = project.path;
    async function walk(directory: string, depth: number): Promise<void> {
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (++visited > 2000 || files.length >= 400) { truncated = true; return; }
        if (entry.name.startsWith(".") || ["node_modules", "venv", "__pycache__"].includes(entry.name) || entry.isSymbolicLink()) continue;
        const absolute = path.join(directory, entry.name);
        const stat = await lstat(absolute);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) {
          if (depth < 5) await walk(absolute, depth + 1);
          else truncated = true;
        } else if (stat.isFile()) files.push({ path: path.relative(root, absolute), size: stat.size });
      }
    }
    await walk(root, 0);
    return { project: { ...project }, conversations: structuredClone(history), files, truncated };
  }
}
