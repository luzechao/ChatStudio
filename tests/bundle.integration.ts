import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SandboxManager } from "@carderne/sandbox-runtime";
import { bundledConfig } from "../src/main/native-runtime.js";
import { OpenStudioBackend } from "../src/main/mcp.js";
import { prepareSandbox } from "../src/main/sandbox.js";

const root = path.resolve(process.env.CHATSTUDIO_BUNDLE || ".runtime/bundle");

function payload(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object");
  assert.ok("content" in value && Array.isArray(value.content));
  assert.ok(!("isError" in value && value.isError), JSON.stringify(value));
  const text = value.content.map((item: unknown) => {
    assert.ok(item && typeof item === "object" && "text" in item);
    return String(item.text);
  }).join("\n");
  const result: unknown = JSON.parse(text);
  assert.ok(result && typeof result === "object");
  const record = Object.fromEntries(Object.entries(result));
  assert.notEqual(record.ok, false, JSON.stringify(record));
  return record;
}

async function run(command: string, args: string[], options: {
  cwd?: string; env?: NodeJS.ProcessEnv; input?: string; replyAfterOutput?: { marker: string; input: string };
} = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const { input, replyAfterOutput, ...launch } = options;
    const child = spawn(command, args, { ...launch, timeout: 60_000 });
    if (replyAfterOutput) child.stdin.write(input);
    else if (input !== undefined) child.stdin.end(input);
    let stdout = ""; let stderr = "";
    let replied = false;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (replyAfterOutput && !replied && stdout.includes(replyAfterOutput.marker)) {
        replied = true;
        child.stdin.end(replyAfterOutput.input);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`${command} exited ${code}\n${stdout}\n${stderr}`)));
  });
}

test("self-contained bundle runs Ruby/Python Measures and an EnergyPlus design-day workflow under the sandbox", { timeout: 240_000 }, async () => {
  const base = await realpath(await mkdtemp(path.join(process.platform === "win32" ? process.cwd() : tmpdir(), "chatstudio-bundle-")));
  const workspace = path.join(base, "workspace with spaces");
  const privateRoot = path.join(base, "private");
  const backend = new OpenStudioBackend(() => {});
  await mkdir(privateRoot);
  try {
    const config = await bundledConfig(root, workspace);
    assert.match(await run(path.join(root, `sandbox/rg${process.platform === "win32" ? ".exe" : ""}`), ["--version"]), /ripgrep 15\.2\.0/);
    await assert.rejects(readFile(path.join(root, "seed_empty.osm")), { code: "ENOENT" });
    const probe = path.join(workspace, "probe.rb");
    await writeFile(probe, 'require "openstudio-standards"\nrequire "minitest/autorun"\nputs "BUNDLED_RUBY=#{RUBY_VERSION}"\nputs Standard.build("90.1-2019").class\n');
    const { warnings: _warnings, ...launch } = await prepareSandbox({
      ...config, backend: { ...config.backend, command: path.join(root, `bin/ruby${process.platform === "win32" ? ".exe" : ""}`), args: ["-I", ".", probe] },
    }, privateRoot);
    const ruby = await run(launch.command, launch.args, launch);
    assert.match(ruby, /BUNDLED_RUBY=3\.2\.2/);
    assert.match(ruby, /ASHRAE9012019/);
    await SandboxManager.reset();

    if (process.platform === "win32") {
      const pythonProbe = path.join(workspace, "stdio-probe.py");
      await writeFile(pythonProbe, 'import asyncio, sys\nasync def wakeup():\n    return await asyncio.to_thread(lambda: "verified")\nprint("ASYNCIO_WAKEUP=" + asyncio.run(wakeup()), flush=True)\nprint("PYTHON_STDIO=" + sys.stdin.readline().strip(), flush=True)\nprint("REMAINING_STDIN=" + str(len(sys.stdin.read())), flush=True)\nprint(repr(sys.argv[1:]), flush=True)\n');
      const { warnings: _pythonWarnings, ...pythonLaunch } = await prepareSandbox({
        ...config, backend: { ...config.backend,
          command: path.join(root, "bin/python3.exe"),
          args: [pythonProbe, 'literal "quoted" value', "", "trailing\\"] },
      }, privateRoot);
      const python = await run(pythonLaunch.command, pythonLaunch.args, { ...pythonLaunch, input: "roundtrip\n",
        replyAfterOutput: { marker: "PYTHON_STDIO=roundtrip", input: `${"x".repeat(20000)}\n` } });
      assert.match(python, /PYTHON_STDIO=roundtrip/);
      assert.match(python, /ASYNCIO_WAKEUP=verified/);
      assert.match(python, /REMAINING_STDIN=20001/);
      assert.ok(python.includes(`['literal "quoted" value', '', 'trailing\\\\']`), python);
      console.log("Windows sandbox Python stdin/stdout roundtrip passed.");
      await SandboxManager.reset();
    }

    await backend.connect(process.platform === "win32"
      ? { ...config, backend: { ...config.backend, args: [...config.backend.args, "--chatstudio-startup-trace"] } } : config, privateRoot);
    assert.equal(backend.tools.length, 207);
    const call = async (name: string, args: Record<string, unknown>) => {
      console.log(`Calling ${name}${typeof args.language === "string" ? ` (${args.language})` : ""}`);
      return payload(await backend.call(name, args));
    };
    if (process.platform === "win32") {
      const syntax = await call("run_sandboxed_script", { language: "Python", code: [
        "import pathlib, shutil, subprocess, time",
        'ruby = shutil.which("ruby")',
        'print("RUBY_EXECUTABLE=" + str(ruby), flush=True)',
        `assert pathlib.Path(ruby).resolve() == pathlib.Path(${JSON.stringify(path.join(root, "bin/ruby.exe"))}).resolve()`,
        'source = pathlib.Path("tmp/syntax-probe.rb")',
        'for text, valid in [("puts 1", True), ("def (", False)]:',
        '    source.write_text(text)',
        '    start = time.monotonic()',
        '    result = subprocess.run([ruby, "-c", str(source)], capture_output=True, text=True, timeout=10)',
        '    print(f"RUBY_SYNTAX valid={valid} exit={result.returncode} seconds={time.monotonic()-start:.3f} {result.stdout} {result.stderr}", flush=True)',
        '    assert (result.returncode == 0) == valid',
      ].join("\n") });
      console.log("Windows Ruby syntax checks:", syntax.stdout);
    }
    const pythonScript = await call("run_sandboxed_script", { language: "Python",
      code: 'import openstudio\nfrom pathlib import Path\nPath("inputs/python-script.txt").write_text("Python sandbox verified")\nprint(openstudio.openStudioVersion())' });
    assert.match(String(pythonScript.stdout), /3\.11\.0/);
    const rubyScript = await call("run_sandboxed_script", { language: "Ruby",
      code: 'File.write("inputs/ruby-script.txt", "Ruby sandbox verified")\nputs OpenStudio.openStudioVersion' });
    assert.match(String(rubyScript.stdout), /3\.11\.0/);
    assert.equal(await readFile(path.join(workspace, "inputs/python-script.txt"), "utf8"), "Python sandbox verified");
    assert.equal(await readFile(path.join(workspace, "inputs/ruby-script.txt"), "utf8"), "Ruby sandbox verified");
    const secret = path.join(privateRoot, "script-secret.txt");
    await writeFile(secret, "must-not-read");
    for (const language of ["Python", "Ruby"]) {
      const source = JSON.stringify(secret.replaceAll("\\", "/"));
      const denied = await backend.call("run_sandboxed_script", { language,
        code: language === "Python" ? `from pathlib import Path\nprint(Path(${source}).read_text())` : `puts File.read(${source})` });
      assert.equal(denied.isError, true, `${language} must not read ChatStudio private files`);
      const failed = await backend.call("run_sandboxed_script", { language,
        code: language === "Python" ? "raise RuntimeError('script-failure-test')" : "raise 'script-failure-test'" });
      assert.equal(failed.isError, true, `${language} failures must reach the caller`);
      const timedOut = await backend.call("run_sandboxed_script", { language, timeout_seconds: 1,
        code: language === "Python" ? "import time; time.sleep(10)" : "sleep 10" });
      assert.equal(timedOut.isError, true, `${language} timeouts must reach the caller`);
    }
    const bounded = await call("run_sandboxed_script", { language: "Python", code: 'print("x" * 70000)' });
    assert.equal(bounded.truncated, true);
    assert.equal(Buffer.byteLength(String(bounded.stdout)), 65536);
    await call("create_example_osm", { name: "bundled-runtime" });
    const saved = await call("save_osm_model", { save_name: "bundle-model" });
    assert.equal(typeof saved.osm_path, "string");
    const measure = await call("create_measure", {
      name: "bundle_rename", description: "Verify bundled Ruby execution", language: "Ruby",
      run_body: '    model.getBuilding.setName("Bundled Ruby Verified")\n    true',
    });
    console.log("Created Measure:", JSON.stringify(measure));
    const measureDir = measure.measure_dir ?? measure.path;
    assert.equal(typeof measureDir, "string");
    const tested = await call("test_measure", { measure_dir: measureDir });
    assert.ok(typeof tested.passed === "number" && tested.passed > 0, JSON.stringify(tested));
    assert.equal(tested.failed, 0);
    assert.equal(tested.errors, 0);
    await call("apply_measure", { measure_dir: measureDir, arguments: {} });
    const summary = await call("get_model_summary", {});
    assert.match(JSON.stringify(summary), /Bundled Ruby Verified/);
    const pythonMeasure = await call("create_measure", {
      name: "bundle_python_rename", description: "Verify bundled Python execution", language: "Python",
      run_body: '        model.getBuilding().setName("Bundled Python Verified")\n        return True',
    });
    assert.equal(typeof pythonMeasure.measure_dir, "string");
    const pythonTests = await call("test_measure", { measure_dir: pythonMeasure.measure_dir });
    assert.ok(typeof pythonTests.passed === "number" && pythonTests.passed > 0, JSON.stringify(pythonTests));
    assert.equal(pythonTests.failed, 0);
    assert.equal(pythonTests.errors, 0);
    await call("apply_measure", { measure_dir: pythonMeasure.measure_dir, arguments: {} });
    assert.match(JSON.stringify(await call("get_model_summary", {})), /Bundled Python Verified/);
    for (const name of ["common", "comstock"]) {
      const measures = await call("list_local_measures", { root_dir: path.join(root, "measures", name), max_results: 5 });
      assert.match(JSON.stringify(measures), /measure\.rb|measure_dir/);
    }

    const fixture = path.join(workspace, "design-day.py");
    const osm = path.join(workspace, "inputs/design-day.osm");
    await writeFile(fixture, `
import openstudio
m = openstudio.model.exampleModel()
rc = m.getSimulationControl()
rc.setRunSimulationforSizingPeriods(True)
rc.setRunSimulationforWeatherFileRunPeriods(False)
if not m.getDesignDays():
    d = openstudio.model.DesignDay(m)
    d.setName("Summer Design Day")
    d.setMonth(7)
    d.setDayOfMonth(21)
    d.setDayType("SummerDesignDay")
    d.setMaximumDryBulbTemperature(32.0)
    d.setHumidityConditionType("Wetbulb")
    d.setWetbulbOrDewPointAtMaximumDryBulb(23.0)
m.save(openstudio.path(${JSON.stringify(osm)}), True)
`);
    await run(path.join(root, `bin/python3${process.platform === "win32" ? ".exe" : ""}`), [fixture]);
    const started = await call("run_simulation", { osm_path: osm, name: "bundle-design-day" });
    console.log("Simulation started:", JSON.stringify(started));
    const runId = started.run_id;
    assert.equal(typeof runId, "string");
    let status: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 4; attempt++) {
      status = await call("get_run_status", { run_id: runId, wait_seconds: 50 });
      const runInfo = status.run;
      assert.ok(runInfo && typeof runInfo === "object" && "status" in runInfo);
      if (["success", "failed", "cancelled", "error"].includes(String(runInfo.status))) break;
    }
    console.log("Simulation result:", JSON.stringify(status));
    assert.match(JSON.stringify(status), /"status":"success"/);
    const artifacts = await call("get_run_artifacts", { run_id: runId });
    assert.match(JSON.stringify(artifacts), /eplusout\.sql/);
    const logs = await call("get_run_logs", { run_id: runId, stream: "energyplus", tail: 40 });
    console.log("EnergyPlus log:", JSON.stringify(logs));
    assert.match(JSON.stringify(logs), /EnergyPlus Completed Successfully-- \d+ Warning; 0 Severe Errors/i);
    assert.match(await readFile(path.join(root, "python-requirements.txt"), "utf8"), /openstudio==3.11.0/);
  } catch (error) {
    console.error("Native bundle workflow failed:", error);
    throw error;
  } finally {
    await backend.disconnect();
    await SandboxManager.reset();
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
});
