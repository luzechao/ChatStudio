import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, realpath, writeFile, chmod, rm } from "node:fs/promises";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { patchWindowsEventLoop, patchWindowsMcpChildren, patchWindowsMeasureSyntax, patchWindowsStdio } from "./native/patch-windows-stdio.mjs";

const platform = `${process.platform}-${process.arch}`;
const platforms = {
  "darwin-arm64": {
    os: "Darwin-arm64", python: "aarch64-apple-darwin",
    osHash: "b7f859038e2962371ff1e12ffe509235f01a7d54f631f04b458dfb5d7be36464",
    pythonHash: "8392b6ea51d94391befb2c31ebe75463f045d0b69dfcf5e1bb3234e1f5fa3405",
    rg: "aarch64-apple-darwin", rgHash: "3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4",
  },
  "linux-x64": {
    os: "Ubuntu-24.04-x86_64", python: "x86_64-unknown-linux-gnu",
    osHash: "69456da262a4c2c11e6d12b554e27d4fb1947850bb219f987d7b2d0d84893fc7",
    pythonHash: "df15fe60d3ff55bf9dcf25824b5572756bb8816ff93865a273d3301d7066a8b7",
    rg: "x86_64-unknown-linux-musl", rgHash: "33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c",
  },
  "win32-x64": {
    os: "Windows", python: "x86_64-pc-windows-msvc",
    osHash: "d87f737ef44fc38aa96600dd2d8a329b39ffbd9865fc7952f93dcd191b84fc46",
    pythonHash: "7369f7a35f261222a6ac8b3a87c1c88eeebee8af945d85346202591a64038dd3",
    rg: "x86_64-pc-windows-msvc", rgHash: "71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5",
  },
};
const target = platforms[platform];
if (!target) throw new Error(`Unsupported native bundle target: ${platform}`);
const windows = process.platform === "win32";
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

async function archive(name, url, sha256, target, strip = 1) {
  const file = path.join(downloads, name);
  if (!await exists(file)) {
    await run("curl", ["-fL", "--retry", "3", url, "-o", file]);
  }
  const { createReadStream } = await import("node:fs");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  const digest = hash.digest("hex");
  if (digest !== sha256) throw new Error(`Checksum mismatch for ${name}; refusing extraction.`);
  const marker = path.join(target, ".archive-sha256");
  if (await exists(marker) && (await readFile(marker, "utf8")) !== sha256) {
    throw new Error(`Existing archive provenance differs in ${target}.`);
  }
  if (!await exists(marker)) {
    await mkdir(target, { recursive: true });
    if (file.endsWith(".zip")) {
      await run("tar", ["-xf", file, "-C", target, `--strip-components=${strip}`]);
    } else await run("tar", ["-xzf", file, "-C", target, `--strip-components=${strip}`]);
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
const sandboxRevision = "0d653440a1089d1ad71aa0a37d621dc677c26651";
if (windows) {
  const sandbox = await checkout("sandbox-runtime", "carderne/sandbox-runtime", sandboxRevision, ["vendor/srt-win-src", "LICENSE"]);
  const build = path.join(downloads, "srt-win-src");
  await cp(path.join(sandbox, "vendor/srt-win-src"), build, { recursive: true });
  await patchWindowsStdio(build);
  await run("cargo", ["build", "--release", "--locked", "--manifest-path", path.join(build, "Cargo.toml")]);
  // All runtime entry points (including UAC provisioning) resolve this same helper.
  await cp(path.join(build, "target/release/srt-win.exe"),
    path.join(root, `node_modules/@carderne/sandbox-runtime/vendor/srt-win/${process.arch}/srt-win.exe`));
  await mkdir(path.join(bundle, "licenses"), { recursive: true });
  await cp(path.join(sandbox, "LICENSE"), path.join(bundle, "licenses/sandbox-runtime-LICENSE"));
  await cp(path.join(scriptDir, "patch-windows-stdio.mjs"), path.join(bundle, "licenses/sandbox-runtime-stdio-patch.mjs"));
}
archives.push(await archive(`openstudio-3.11.0-${platform}.tar.gz`,
  `https://github.com/NatLabRockies/OpenStudio/releases/download/v3.11.0/OpenStudio-3.11.0%2B241b8abb4d-${target.os}.tar.gz`,
  target.osHash, path.join(bundle, "openstudio"), process.platform === "linux" ? 4 : 1));
archives.push(await archive(`python-3.13.18-${platform}.tar.gz`,
  `https://github.com/astral-sh/python-build-standalone/releases/download/20261026/cpython-3.13.18%2B20261026-${target.python}-install_only_stripped.tar.gz`,
  target.pythonHash, path.join(bundle, "python-runtime")));
if (windows) {
  const stdlib = path.join(bundle, "python-runtime/Lib");
  await cp(path.join(scriptDir, "windows-self-pipe.py"), path.join(stdlib, "chatstudio_windows_self_pipe.py"));
  await patchWindowsEventLoop(stdlib);
}
await rm(path.join(bundle, "openstudio/Radiance"), { recursive: true, force: true });

const mcpRevision = "e0a47a9c50aa6c52f77ba63540118bb816d12726";
const mcp = await checkout("mcp", "NatLabRockies/openstudio-mcp", mcpRevision);
const python = path.join(bundle, windows ? "python-runtime/python.exe" : "python-runtime/bin/python3");
const wheels = path.join(downloads, "wheels");
await mkdir(wheels, { recursive: true });
await run(python, ["-m", "pip", "wheel", "--no-deps", "--wheel-dir", wheels, mcp]);
const lock = path.join(scriptDir, "requirements-macos-arm64.txt");
if (await exists(lock)) await run(python, ["-m", "pip", "install", "-r", lock]);
await run(python, ["-m", "pip", "install", "--no-index", "--no-deps", "--find-links", wheels, "openstudio-mcp==1.2.1"]);
await run(python, ["-m", "pip", "install", "--find-links", wheels, "openstudio-mcp==1.2.1", "pytest==8.4.2"]);
await run(python, ["-m", "pip", "check"]);
if (windows) {
  const sitePackages = path.join(bundle, "python-runtime/Lib/site-packages");
  await patchWindowsMeasureSyntax(sitePackages);
  await patchWindowsMcpChildren(sitePackages);
}
const frozen = await run(python, ["-m", "pip", "freeze"], { capture: true });
await writeFile(path.join(bundle, "python-requirements.txt"), `${frozen}\n`);
await cp(path.join(mcp, ".claude/skills"), path.join(bundle, "skills"), { recursive: true });
await rm(path.join(bundle, "measures/gbxml"), { recursive: true, force: true });
await rm(path.join(bundle, "seed_empty.osm"), { force: true });
await rm(path.join(bundle, "skills/gbxml-import"), { recursive: true, force: true });
await mkdir(path.join(bundle, "licenses"), { recursive: true });
await cp(path.join(mcp, "LICENSE.txt"), path.join(bundle, "licenses/openstudio-mcp.txt"));

const measures = [
  { name: "comstock", repo: "NatLabRockies/ComStock", revision: "b77c60d341c9b68c58c5d51e51b06f08f293d3cb", directory: "resources/measures" },
  { name: "common", repo: "NatLabRockies/openstudio-common-measures-gem", revision: "9339294327cad7b810772ca7e3f3561a69beada7", directory: "lib/measures" },
];
for (const measure of measures) {
  const source = await checkout(measure.name, measure.repo, measure.revision, [measure.directory, ...(measure.name === "gbxml" ? ["seeds"] : [])]);
  await cp(path.join(source, measure.directory), path.join(bundle, "measures", measure.name), { recursive: true });
  if (measure.name === "gbxml") await cp(path.join(source, "seeds/seed_empty.osm"), path.join(bundle, "seed_empty.osm"));
  for (const license of ["LICENSE", "LICENSE.md", "LICENSE.txt"]) {
    if (await exists(path.join(source, license))) await cp(path.join(source, license), path.join(bundle, "licenses", `${measure.name}-${license}`));
  }
}

const cli = path.join(bundle, `openstudio/bin/openstudio${windows ? ".exe" : ""}`);
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
await cp(path.join(scriptDir, "script-tool.py"), path.join(bundle, "script-tool.py"));
if (windows) {
  await run("cl", ["/nologo", "/MT", "/O2", path.join(scriptDir, "windows-launcher.c"),
    `/Fe:${path.join(bundle, "bin/openstudio-mcp.exe")}`, `/Fo:${path.join(downloads, "windows-launcher.obj")}`]);
}
for (const command of ["openstudio-mcp", "ruby", "python3"]) {
  if (windows) {
    if (command !== "openstudio-mcp") await cp(path.join(bundle, "bin/openstudio-mcp.exe"), path.join(bundle, `bin/${command}.exe`));
    continue;
  }
  const file = path.join(bundle, "bin", command);
  await writeFile(file, `#!/bin/sh\nbase="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"\nexec "$base/python-runtime/bin/python3" -I "$base/launch.py" "${command}" "$@"\n`);
  await chmod(file, 0o755);
}
const helpers = path.join(bundle, "sandbox");
const rgSource = path.join(downloads, `ripgrep-${platform}`);
archives.push(await archive(`ripgrep-${platform}.${windows ? "zip" : "tar.gz"}`,
  `https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-${target.rg}.${windows ? "zip" : "tar.gz"}`,
  target.rgHash, rgSource));
await mkdir(helpers, { recursive: true });
await cp(path.join(rgSource, windows ? "rg.exe" : "rg"), path.join(helpers, windows ? "rg.exe" : "rg"));
for (const license of ["LICENSE-MIT", "UNLICENSE", "COPYING"]) {
  if (await exists(path.join(rgSource, license))) await cp(path.join(rgSource, license), path.join(bundle, "licenses", `ripgrep-${license}`));
}
if (process.platform === "linux") {
  const lib = path.join(helpers, "lib");
  await mkdir(lib, { recursive: true });
  for (const name of ["bwrap", "socat"]) {
    const binary = `/usr/bin/${name}`;
    await cp(binary, path.join(helpers, name), { dereference: true });
    await chmod(path.join(helpers, name), 0o755);
    const linkage = await run("ldd", [binary], { capture: true });
    for (const match of linkage.matchAll(/=> (\/\S+)/g)) {
      if (/\/libc\.so|\/libm\.so|\/libpthread\.so|\/libdl\.so/.test(match[1])) continue;
      await cp(match[1], path.join(lib, path.basename(match[1])), { dereference: true });
    }
    await run("patchelf", ["--set-rpath", "$ORIGIN/lib", path.join(helpers, name)]);
  }
  for (const pkg of ["bubblewrap", "socat", "libcap2", "libwrap0", "libssl3t64", "libc6"]) {
    const notice = `/usr/share/doc/${pkg}/copyright`;
    if (await exists(notice)) await cp(notice, path.join(bundle, "licenses", `${pkg}-copyright`));
  }
  const sourceDir = path.join(downloads, "sandbox-sources");
  await mkdir(sourceDir, { recursive: true });
  await run("apt-get", ["source", "--download-only", "bubblewrap", "socat", "libcap2", "tcp-wrappers", "openssl"],
    { cwd: sourceDir });
  await cp(sourceDir, path.join(bundle, "licenses/sources"), { recursive: true });
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
  schema: 1, platform: process.platform, arch: process.arch, openstudio: "3.11.0", energyplus: "25.2.0",
  python: "3.13.18", ruby: "3.2.2", mcpRevision, archives, measures,
  ...(windows ? { sandboxRevision, sandboxStdinPatch: 1, pythonNamedPipeWakeupPatch: 1, mcpMeasureSyntaxPatch: 1, mcpChildEnvironmentPatch: 1, mcpRubyMetadataPatch: 1 } : {}),
}, null, 2));
await writeFile(path.join(bundle, "licenses/README.txt"),
  "Third-party components retain their upstream licenses. OpenStudio(R), EnergyPlus, Python, Ruby/gems and Python packages retain license files in their respective directories. ComStock/Common and ripgrep notices are in this directory. gbXML assets are not distributed. Linux socat is GPL-2.0-or-later; corresponding source is available from Ubuntu's source archive (apt source socat). Bubblewrap source is available from Ubuntu's source archive (apt source bubblewrap).\n");
console.log(`Native bundle ready: ${bundle}`);
