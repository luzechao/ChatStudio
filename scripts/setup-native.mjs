import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, readlink, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtime = path.join(root, ".runtime");
const source = path.join(runtime, "openstudio-mcp");
const revision = "e0a47a9c50aa6c52f77ba63540118bb816d12726";

function run(command, args, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit" });
    let output = "";
    if (capture) child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(output.trim()) : reject(new Error(`${command} exited ${code}`)));
  });
}

await mkdir(runtime, { recursive: true });
let exists = true;
try { await readFile(path.join(source, "pyproject.toml")); }
catch (error) {
  if (error.code !== "ENOENT") throw error;
  exists = false;
}
if (!exists) {
  await run("git", ["clone", "https://github.com/NatLabRockies/openstudio-mcp.git", source]);
  await run("git", ["-C", source, "checkout", "--detach", revision]);
}
if (await run("git", ["-C", source, "rev-parse", "HEAD"], true) !== revision) {
  throw new Error("Existing MCP checkout differs from the pinned revision; it was not modified.");
}
const venv = path.join(runtime, "venv");
const bin = path.join(venv, process.platform === "win32" ? "Scripts" : "bin");
const python = path.join(bin, process.platform === "win32" ? "python.exe" : "python");
try { await realpath(python); }
catch (error) {
  if (error.code !== "ENOENT") throw error;
  await run(process.env.CHATSTUDIO_PYTHON || (process.platform === "win32" ? "python" : "python3"), ["-m", "venv", venv]);
}
await run(python, ["-m", "pip", "install", "-r", path.join(root, "requirements-native.txt")]);
const prefix = await run(python, ["-c", "import sys; print(sys.base_prefix)"], true);
const baseExecutable = await run(python, ["-c", "import sys; print(sys._base_executable)"], true);
const interpreterRoots = new Set([prefix, path.dirname(baseExecutable)]);
if (prefix.includes("/Frameworks/Python.framework/")) {
  interpreterRoots.add(prefix.split("/Frameworks/Python.framework/")[0]);
}
let interpreter = python;
for (let depth = 0; depth < 16; depth++) {
  interpreterRoots.add(path.dirname(interpreter));
  try { interpreter = path.resolve(path.dirname(interpreter), await readlink(interpreter)); }
  catch (error) {
    if (error.code !== "EINVAL") throw error;
    break;
  }
  if (process.platform === "darwin") {
    const dynload = await run(python, ["-c", "import sysconfig; print(sysconfig.get_config_var('DESTSHARED'))"], true);
    const modules = (await readdir(dynload)).filter((name) => name.endsWith(".so")).map((name) => path.join(dynload, name));
    const links = await run("/usr/bin/otool", ["-L", ...modules], true);
    for (const match of links.matchAll(/^\s+(\/.+?) \(/gm)) {
      const library = match[1];
      const opt = library.lastIndexOf("/opt/");
      const cellar = library.lastIndexOf("/Cellar/");
      if (opt >= 0) interpreterRoots.add(library.slice(0, opt + 5) + library.slice(opt + 5).split("/")[0]);
      else if (cellar >= 0) interpreterRoots.add(library.slice(0, cellar + 8) + library.slice(cellar + 8).split("/").slice(0, 2).join("/"));
    }
  }
}
const workspace = path.join(root, "projects", "first-building");
await mkdir(workspace, { recursive: true });
const config = {
  workspace,
  backend: {
    command: path.join(bin, process.platform === "win32" ? "openstudio-mcp.exe" : "openstudio-mcp"),
    args: [],
    readRoots: [runtime, ...interpreterRoots],
    environment: { SKILLS_DIR: path.join(source, ".claude", "skills") },
  },
};
await writeFile(path.join(runtime, "backend.json"), JSON.stringify(config, null, 2), { mode: 0o600 });
console.log(`\nNative SDK/MCP installed. Configuration: ${path.join(runtime, "backend.json")}`);
console.log("Full CLI simulations and Ruby Measures still require the matching native OpenStudio distribution and Measure/gem assets.");
