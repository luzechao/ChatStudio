import { homedir } from "node:os";
import path from "node:path";
import { validateCustomEndpoint, type AppConfig } from "../shared/contracts.js";

const ENV_KEYS = new Set([
  "OPENSTUDIO_CLI", "ENERGYPLUS_EXE_PATH", "OSCLI_GEMFILE", "OSCLI_GEM_PATH",
  "COMSTOCK_MEASURES_DIR", "COMMON_MEASURES_DIR", "GBXML_MEASURES_DIR", "GBXML_SEED_OSM",
  "SKILLS_DIR", "GEM_HOME", "GEM_PATH", "RUBYLIB",
]);

export function defaultConfig(): AppConfig {
  return { workspace: "", backend: { command: "", args: [], readRoots: [], environment: {} } };
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 100 && value.every((v) => typeof v === "string" && v.length <= 8192);
}

export function validateConfig(value: unknown, requireRuntime = false): AppConfig {
  if (!value || typeof value !== "object" || !("workspace" in value) || !("backend" in value)) {
    throw new Error("Invalid ChatStudio configuration.");
  }
  const { workspace, backend } = value;
  if (typeof workspace !== "string" || (workspace && !path.isAbsolute(workspace))) {
    throw new Error("Workspace must be an absolute path.");
  }
  if (workspace && [path.parse(workspace).root, homedir()].includes(path.resolve(workspace))) {
    throw new Error("Choose a dedicated project folder, not your home or filesystem root.");
  }
  if (!backend || typeof backend !== "object" || !("command" in backend) || !("args" in backend)
    || !("readRoots" in backend) || !("environment" in backend)) throw new Error("Invalid backend configuration.");
  const { command, args, readRoots, environment } = backend;
  if (typeof command !== "string" || (command && !path.isAbsolute(command)) || !strings(args) || !strings(readRoots)
    || readRoots.some((p) => !path.isAbsolute(p))) throw new Error("Use an absolute executable and absolute read-only dependency paths.");
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) throw new Error("Environment must be an object.");
  const env: Record<string, string> = {};
  for (const [key, val] of Object.entries(environment)) {
    if (!ENV_KEYS.has(key) || typeof val !== "string" || val.length > 8192) {
      throw new Error(`Unsupported runtime environment setting: ${key}`);
    }
    env[key] = val;
  }
  if (readRoots.some((p) => [path.parse(p).root, homedir()].includes(path.resolve(p)))) {
    throw new Error("Read access must name specific dependency folders, not your home or filesystem root.");
  }
  if (requireRuntime && (!workspace || !command)) throw new Error("Select a workspace and configure a native MCP executable first.");
  const customEndpoint = "customEndpoint" in value && value.customEndpoint !== undefined
    ? validateCustomEndpoint(value.customEndpoint) : undefined;
  if ("bundledRuntime" in value && typeof value.bundledRuntime !== "boolean") throw new Error("Invalid bundled runtime setting.");
  if ("internetAccess" in value && typeof value.internetAccess !== "boolean") throw new Error("Invalid internet access setting.");
  return { workspace, backend: { command, args, readRoots, environment: env },
    ...(customEndpoint ? { customEndpoint } : {}),
    ...("bundledRuntime" in value ? { bundledRuntime: value.bundledRuntime === true } : {}),
    ...("internetAccess" in value ? { internetAccess: value.internetAccess === true } : {}) };
}
