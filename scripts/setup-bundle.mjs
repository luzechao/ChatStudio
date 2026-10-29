import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, realpath, writeFile, chmod } from "node:fs/promises";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("The native bundle is currently verified only on macOS Apple Silicon.");
}
setDefaultCACertificates([...getCACertificates("default"), ...getCACertificates("system")]);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = path.join(root, ".runtime/bundle");
const downloads = path.join(root, ".runtime/downloads");
const sources = path.join(root, ".runtime/bundle-sources");
const scriptDir = path.join(root, "scripts/native");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, ...options, stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit" });
    let output = "";
    if (options.capture) child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(output.trim()) : reject(new Error(`${command} exited ${code}`)));
  });
}

async function exists(file) {
  try { await realpath(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function archive(name, url, sha256, target) {
  const file = path.join(downloads, name);
  if (!await exists(file)) {
    await run("curl", ["-fL", "--retry", "3", url, "-o", file]);
  }
  const digest = createHash("sha256").update(await readFile(file)).digest("hex");
  if (digest !== sha256) throw new Error(`Checksum mismatch for ${name}; refusing extraction.`);
  const marker = path.join(target, ".archive-sha256");
  if (await exists(marker) && (await readFile(marker, "utf8")) !== sha256) {
    throw new Error(`Existing archive provenance differs in ${target}.`);
  }
  if (!await exists(marker)) {
    await mkdir(target, { recursive: true });
    await run("tar", ["-xzf", file, "-C", target, "--strip-components=1"]);
    await writeFile(marker, sha256);
  }
  return { name, url, sha256 };
}

async function checkout(name, repo, revision, paths) {
  const directory = path.join(sources, name);
  if (!await exists(directory)) {
    await run("git", ["clone", "--filter=blob:none", "--no-checkout", `https://github.com/${repo}.git`, directory]);
    if (paths) await run("git", ["-C", directory, "sparse-checkout", "set", ...paths]);
    await run("git", ["-C", directory, "checkout", "--detach", revision]);
  }
  if (await run("git", ["-C", directory, "rev-parse", "HEAD"], { capture: true }) !== revision) {
    throw new Error(`Unexpected revision in ${directory}; existing files were not overwritten.`);
  }
  if (await run("git", ["-C", directory, "status", "--porcelain"], { capture: true })) {
    throw new Error(`Source checkout has local modifications: ${directory}`);
  }
  return directory;
}

await mkdir(downloads, { recursive: true });
await mkdir(sources, { recursive: true });
await mkdir(bundle, { recursive: true });
const archives = [];
archives.push(await archive("openstudio-3.11.0-darwin-arm64.tar.gz",
  "https://github.com/NatLabRockies/OpenStudio/releases/download/v3.11.0/OpenStudio-3.11.0%2B241b8abb4d-Darwin-arm64.tar.gz",
  "b7f859038e2962371ff1e12ffe509235f01a7d54f631f04b458dfb5d7be36464", path.join(bundle, "openstudio")));
archives.push(await archive("python-3.13.18-darwin-arm64.tar.gz",
  "https://github.com/astral-sh/python-build-standalone/releases/download/20261026/cpython-3.13.18%2B20261026-aarch64-apple-darwin-install_only_stripped.tar.gz",
  "8392b6ea51d94391befb2c31ebe75463f045d0b69dfcf5e1bb3234e1f5fa3405", path.join(bundle, "python-runtime")));

const mcpRevision = "e0a47a9c50aa6c52f77ba63540118bb816d12726";
const mcp = await checkout("mcp", "NatLabRockies/openstudio-mcp", mcpRevision);
const python = path.join(bundle, "python-runtime/bin/python3");
const wheels = path.join(downloads, "wheels");
await mkdir(wheels, { recursive: true });
await run(python, ["-m", "pip", "wheel", "--no-deps", "--wheel-dir", wheels, mcp]);
const lock = path.join(scriptDir, "requirements-macos-arm64.txt");
if (await exists(lock)) await run(python, ["-m", "pip", "install", "-r", lock]);
await run(python, ["-m", "pip", "install", "--no-index", "--no-deps", "--find-links", wheels, "openstudio-mcp==1.2.1"]);
await run(python, ["-m", "pip", "install", "--find-links", wheels, "openstudio-mcp==1.2.1", "pytest==8.4.2"]);
await run(python, ["-m", "pip", "check"]);
const frozen = await run(python, ["-m", "pip", "freeze"], { capture: true });
await writeFile(path.join(bundle, "python-requirements.txt"), `${frozen}\n`);
if (!await exists(lock)) await writeFile(lock, `${frozen.split("\n").filter((line) => !line.startsWith("openstudio-mcp")).join("\n")}\n`);
await cp(path.join(mcp, ".claude/skills"), path.join(bundle, "skills"), { recursive: true });
await mkdir(path.join(bundle, "licenses"), { recursive: true });
await cp(path.join(mcp, "LICENSE.txt"), path.join(bundle, "licenses/openstudio-mcp.txt"));

const measures = [
  { name: "comstock", repo: "NatLabRockies/ComStock", revision: "b77c60d341c9b68c58c5d51e51b06f08f293d3cb", directory: "resources/measures" },
  { name: "common", repo: "NatLabRockies/openstudio-common-measures-gem", revision: "9339294327cad7b810772ca7e3f3561a69beada7", directory: "lib/measures" },
  { name: "gbxml", repo: "NatLabRockies/gbxml-to-openstudio", revision: "d219e499dd34a582b9596243f6fb0d05f8c94c9d", directory: "measures" },
];
for (const measure of measures) {
  const source = await checkout(measure.name, measure.repo, measure.revision, [measure.directory, ...(measure.name === "gbxml" ? ["seeds"] : [])]);
  await cp(path.join(source, measure.directory), path.join(bundle, "measures", measure.name), { recursive: true });
  if (measure.name === "gbxml") await cp(path.join(source, "seeds/seed_empty.osm"), path.join(bundle, "seed_empty.osm"));
  for (const license of ["LICENSE", "LICENSE.md", "LICENSE.txt"]) {
    if (await exists(path.join(source, license))) await cp(path.join(source, license), path.join(bundle, "licenses", `${measure.name}-${license}`));
  }
}

const cli = path.join(bundle, "openstudio/bin/openstudio");
const gemHome = path.join(bundle, "gems/ruby/3.2.0");
await mkdir(gemHome, { recursive: true });
await run(cli, [path.join(scriptDir, "extract-gems.rb"), gemHome]);
await cp(path.join(scriptDir, "Gemfile"), path.join(bundle, "Gemfile"));
if (await exists(path.join(scriptDir, "Gemfile.lock"))) {
  await cp(path.join(scriptDir, "Gemfile.lock"), path.join(bundle, "Gemfile.lock"));
}
await run(cli, ["--bundle", path.join(bundle, "Gemfile"), "--bundle_path", path.join(bundle, "gems"),
  "-e", 'require "openstudio-standards"; require "openstudio-extension"; puts Standard.build("90.1-2019").class'],
{ env: { ...process.env, GEM_HOME: gemHome, GEM_PATH: gemHome } });
await mkdir(path.join(bundle, "bin"), { recursive: true });
await cp(path.join(scriptDir, "launch.py"), path.join(bundle, "launch.py"));
await cp(path.join(scriptDir, "ruby-driver.rb"), path.join(bundle, "ruby-driver.rb"));
for (const command of ["openstudio-mcp", "ruby", "python3"]) {
  const file = path.join(bundle, "bin", command);
  await writeFile(file, `#!/bin/sh\nbase="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"\nexec "$base/python-runtime/bin/python3" -I "$base/launch.py" "${command}" "$@"\n`);
  await chmod(file, 0o755);
}
async function checkLinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const target = await realpath(file);
      const relative = path.relative(bundle, target);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Bundled symlink points outside the runtime: ${file}`);
      }
    } else if (entry.isDirectory()) await checkLinks(file);
  }
}
for (const directory of ["openstudio", "python-runtime", "measures", "gems"]) await checkLinks(path.join(bundle, directory));
await writeFile(path.join(bundle, "manifest.json"), JSON.stringify({
  schema: 1, platform: "darwin", arch: "arm64", openstudio: "3.11.0", energyplus: "25.2.0",
  python: "3.13.18", ruby: "3.2.2", mcpRevision, archives, measures,
}, null, 2));
console.log(`Native bundle ready: ${bundle}`);
