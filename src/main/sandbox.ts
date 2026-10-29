import { mkdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { AppConfig } from "../shared/contracts.js";
import { validateConfig } from "./config.js";

export function sandboxPolicy(workspace: string, readRoots: string[], privateRoot: string): SandboxRuntimeConfig {
  return {
    network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true, allowLocalBinding: false },
    filesystem: {
      denyRead: [homedir(), privateRoot].map((p) => ({ path: p, literal: true })),
      allowRead: [workspace, ...readRoots].map((p) => ({ path: p, literal: true })),
      allowWrite: [{ path: workspace, literal: true }],
      denyWrite: [{ path: privateRoot, literal: true }],
    },
  };
}

export async function prepareSandbox(raw: AppConfig, privateRoot: string) {
  const config = validateConfig(raw, true);
  const workspace = await realpath(config.workspace);
  const privatePath = await realpath(privateRoot);
  const contains = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  };
  if (workspace === homedir() || workspace === path.parse(workspace).root || contains(workspace, privatePath)
    || contains(privatePath, workspace)) throw new Error("Workspace must be separate from ChatStudio's private data.");
  const command = await realpath(config.backend.command);
  if (!(await stat(command)).isFile()) throw new Error("MCP executable is not a regular file.");
  const resolvedRoots = await Promise.all(config.backend.readRoots.map((p) => realpath(p)));
  const readRoots = [...new Set([...config.backend.readRoots, ...resolvedRoots])];
  if ([path.dirname(command), ...readRoots].some((p) => p === homedir() || p === path.parse(p).root
    || contains(p, privatePath) || contains(privatePath, p))) {
    throw new Error("Runtime read paths must not expose home, filesystem root, or ChatStudio private data.");
  }
  for (const dir of ["runs", "measures", "inputs", "tmp", ".home"]) await mkdir(path.join(workspace, dir), { recursive: true });
  if (!SandboxManager.isSupportedPlatform()) throw new Error(`No sandbox backend for ${process.platform}. Execution refused.`);
  const dependencies = await SandboxManager.checkDependenciesAsync();
  if (dependencies.errors.length) throw new Error(`Sandbox unavailable: ${dependencies.errors.join("; ")}`);
  const policy = sandboxPolicy(workspace, [path.dirname(command), ...readRoots], privatePath);
  await SandboxManager.initialize(policy, undefined, false);
  const cli = config.backend.environment.OPENSTUDIO_CLI;
  if (cli && !path.isAbsolute(cli)) throw new Error("OPENSTUDIO_CLI must be an absolute executable path.");
  const env: Record<string, string> = {
    PATH: [path.dirname(command), ...(cli ? [path.dirname(cli)] : []), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(path.delimiter),
    LANG: "en_US.UTF-8",
    HOME: path.join(workspace, ".home"),
    TMPDIR: path.join(workspace, "tmp"),
    ...config.backend.environment,
    MCP_TRANSPORT: "stdio",
    OPENSTUDIO_MCP_RUN_ROOT: path.join(workspace, "runs"),
    OPENSTUDIO_MCP_MEASURES_DIR: path.join(workspace, "measures"),
    OPENSTUDIO_MCP_INPUT_ROOT: path.join(workspace, "inputs"),
    OSMCP_SANDBOX: "auto",
    OSMCP_ENABLE_CODE_TOOLS: "true",
  };
  if (process.platform === "win32") {
    throw new Error("Windows sandbox launch is not validated yet. Execution refused; no unsandboxed fallback.");
  }
  // Every token is literal shell data; never concatenate unquoted user arguments.
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  const wrapped = await SandboxManager.wrapWithSandboxArgv(
    [command, ...config.backend.args].map(quote).join(" "),
    "/bin/sh", undefined, undefined, workspace,
  );
  const [executable, ...args] = wrapped.argv;
  if (!executable) throw new Error("Sandbox did not return a launcher.");
  const proxyEnv: Record<string, string> = {};
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) {
    const val = wrapped.env[key];
    if (val) proxyEnv[key] = val;
  }
  return { command: executable, args, cwd: workspace, env: { ...env, ...proxyEnv }, warnings: dependencies.warnings };
}
