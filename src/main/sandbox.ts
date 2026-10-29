import { mkdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SandboxManager, type SandboxRuntimeConfig } from "@carderne/sandbox-runtime";
import type { AppConfig } from "../shared/contracts.js";
import { validateConfig } from "./config.js";
import { protectPrivateData } from "./private-data.js";

export function sandboxPolicy(workspace: string, readRoots: string[], privateRoot: string, internetAccess = false): SandboxRuntimeConfig {
  return {
    network: { allowedDomains: [], deniedDomains: [], strictAllowlist: !internetAccess, allowLocalBinding: false },
    filesystem: {
      denyRead: [homedir(), privateRoot],
      allowRead: [workspace, ...readRoots],
      allowWrite: [workspace],
      denyWrite: [privateRoot],
    },
  };
}

export function windowsSandboxArgv(argv: string[], command: string, environment: Record<string, string>): string[] {
  if (argv.at(-1) !== "") throw new Error("Unexpected Windows sandbox command argument.");
  const separator = argv.indexOf("--");
  if (separator < 0 || argv[separator + 1] !== command) throw new Error("Unexpected Windows sandbox launcher arguments.");
  const controlled = new Set(Object.keys(environment).map((key) => key.toUpperCase()));
  const prefix: string[] = [];
  for (let i = 0; i < separator; i++) {
    if (argv[i] !== "--env") {
      prefix.push(argv[i]);
      continue;
    }
    const entry = argv[++i];
    if (i >= separator || !entry.includes("=")) throw new Error("Unexpected Windows sandbox environment argument.");
    if (!controlled.has(entry.slice(0, entry.indexOf("=")).toUpperCase())) prefix.push("--env", entry);
  }
  return [...prefix, ...Object.entries(environment).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    "--", ...argv.slice(separator + 1, -1)];
}

export async function prepareSandbox(raw: AppConfig, privateRoot: string) {
  const config = validateConfig(raw, true);
  const workspace = await realpath(config.workspace);
  const privatePath = await realpath(privateRoot);
  const contains = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  };
  if (contains(privatePath, homedir()) || privatePath === path.parse(privatePath).root) {
    throw new Error("ChatStudio private data must use a dedicated directory, not home or a filesystem root.");
  }
  if (workspace === homedir() || workspace === path.parse(workspace).root || contains(workspace, privatePath)
    || contains(privatePath, workspace)) throw new Error("Workspace must be separate from ChatStudio's private data.");
  const command = await realpath(config.backend.command);
  if (!(await stat(command)).isFile()) throw new Error("MCP executable is not a regular file.");
  const resolvedRoots = await Promise.all(config.backend.readRoots.map((p) => realpath(p)));
  const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.resolve("@carderne/sandbox-runtime"))), "..");
  const seccompRoot = path.join(runtimeRoot, "vendor/seccomp");
  const helperRoot = process.env.CHATSTUDIO_SANDBOX_HELPERS
    ? await realpath(process.env.CHATSTUDIO_SANDBOX_HELPERS) : undefined;
  const readRoots = [...new Set([...config.backend.readRoots, ...resolvedRoots,
    ...(helperRoot ? [helperRoot] : []), ...(process.platform === "linux" ? [seccompRoot] : [])])];
  if (process.platform === "win32" && [workspace, command, ...readRoots].some((p) => contains(homedir(), p))) {
    throw new Error("The experimental Windows sandbox requires projects and runtime installations outside your user profile. Use C:\\ChatStudio Projects and the machine-wide installer; home-directory protection remains enabled.");
  }
  if ([path.dirname(command), ...readRoots].some((p) => p === homedir() || p === path.parse(p).root
    || contains(p, privatePath) || contains(privatePath, p))) {
    throw new Error("Runtime read paths must not expose home, filesystem root, or ChatStudio private data.");
  }
  for (const dir of ["runs", "measures", "inputs", "tmp", ".home"]) await mkdir(path.join(workspace, dir), { recursive: true });
  for (const dir of [workspace, privatePath, homedir(), ...readRoots, path.dirname(command)]) {
    if (/[*?[\]{}!]/.test(dir)) throw new Error("Sandbox paths must not contain glob metacharacters.");
  }
  if (!SandboxManager.isSupportedPlatform()) throw new Error(`No sandbox backend for ${process.platform}. Execution refused.`);
  const rg = helperRoot ? path.join(helperRoot, process.platform === "win32" ? "rg.exe" : "rg") : "rg";
  const policy = sandboxPolicy(workspace, [path.dirname(command), ...readRoots], privatePath, config.internetAccess);
  if (process.platform === "win32") {
    await protectPrivateData(privatePath);
    // Keep this owner-only ACL protected; the alpha runtime recomposes denies as unprotected ACLs.
    policy.filesystem.denyRead = [homedir()];
    policy.filesystem.denyWrite = [];
  }
  policy.ripgrep = { command: rg };
  if (helperRoot && process.platform === "linux") {
    policy.bwrapPath = path.join(helperRoot, "bwrap");
    policy.socatPath = path.join(helperRoot, "socat");
  }
  await SandboxManager.initialize(policy, config.internetAccess ? async () => true : undefined, false);
  const dependencies = SandboxManager.checkDependencies();
  const cli = config.backend.environment.OPENSTUDIO_CLI;
  if (cli && !path.isAbsolute(cli)) throw new Error("OPENSTUDIO_CLI must be an absolute executable path.");
  const env: Record<string, string> = {
    PATH: [...(config.bundledRuntime && cli ? [path.resolve(path.dirname(cli), "../../bin")] : []),
      path.dirname(command), ...(cli ? [path.dirname(cli)] : []),
      ...(process.platform === "win32" ? [path.join(process.env.SystemRoot || "C:\\Windows", "System32"),
        path.join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0")] : ["/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(path.delimiter),
    LANG: "en_US.UTF-8",
    PYTHONUTF8: "1",
    HOME: path.join(workspace, ".home"),
    TMPDIR: path.join(workspace, "tmp"),
    ...config.backend.environment,
    MCP_TRANSPORT: "stdio",
    OPENSTUDIO_MCP_RUN_ROOT: path.join(workspace, "runs"),
    OPENSTUDIO_MCP_MEASURES_DIR: path.join(workspace, "measures"),
    OPENSTUDIO_MCP_INPUT_ROOT: path.join(workspace, "inputs"),
    // The outer OS sandbox enforces project boundaries; upstream Landlock assumes Docker-only runtime paths.
    OSMCP_SANDBOX: process.platform === "linux" ? "posix" : "auto",
    OSMCP_ENABLE_CODE_TOOLS: "true",
  };
  // Every token is literal shell data; never concatenate unquoted user arguments.
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  const windows = process.platform === "win32";
  const expression = [command, ...config.backend.args].map(quote).join(" ");
  const wrapped = await SandboxManager.wrapWithSandboxArgv(
    windows ? "" : expression,
    windows ? { exe: command, args: config.backend.args } : "/bin/sh", undefined, undefined, workspace,
  );
  // Replace runtime defaults instead of appending duplicate Windows environment keys.
  const argv = windows ? windowsSandboxArgv(wrapped.argv, command, env) : wrapped.argv;
  const [executable, ...args] = argv;
  if (!executable) throw new Error("Sandbox did not return a launcher.");
  const proxyEnv: Record<string, string> = {};
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) {
    const val = wrapped.env[key];
    if (val) proxyEnv[key] = val;
  }
  const brokerEnv: Record<string, string> = {};
  if (windows) for (const key of ["SystemRoot", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"]) {
    if (process.env[key]) brokerEnv[key] = process.env[key];
  }
  return { command: executable, args, cwd: workspace, env: { ...brokerEnv, ...env, ...proxyEnv }, warnings: dependencies.warnings };
}
