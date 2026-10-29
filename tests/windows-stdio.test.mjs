import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { patchWindowsEventLoop, patchWindowsMcpChildren, patchWindowsMeasureSyntax } from "../scripts/native/patch-windows-stdio.mjs";

test("Windows Measure syntax checks launch direct interpreters with bounded timeouts", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "chatstudio-syntax-patch-"));
  const file = path.join(directory, "mcp_server/skills/measure_authoring/operations.py");
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `import subprocess
proc = subprocess.run(
    ["ruby", "-c", str(script_path)],
    capture_output=True, text=True, timeout=10, check=False,
)
proc = subprocess.run(
    ["python3", "-c", f"compile({code!r}, {str(script_path)!r}, 'exec')"],
    capture_output=True, text=True, timeout=10, check=False,
)
`.replaceAll("\n", "\r\n"));
    await patchWindowsMeasureSyntax(directory);
    const patched = await readFile(file, "utf8");
    assert.match(patched, /os\.environ\["OPENSTUDIO_CLI"\]/);
    assert.match(patched, /parents\[2\] \/ "ruby-driver.rb"/);
    assert.match(patched, /sys\.executable, "-I", "-c"/);
    assert.equal(patched.split("timeout=10").length, 3);
    assert.doesNotMatch(patched, /\["ruby"|\["python3"/);
    await patchWindowsMeasureSyntax(directory);
    assert.equal(await readFile(file, "utf8"), patched);
    await writeFile(file, patched.replaceAll("\n", "\r\n"));
    await patchWindowsMeasureSyntax(directory);
    assert.equal(await readFile(file, "utf8"), patched);
    await writeFile(file, "unexpected");
    await assert.rejects(patchWindowsMeasureSyntax(directory), /Unexpected pinned MCP Measure syntax source/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows native children close protocol stdin and preserve only required Windows environment", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "chatstudio-child-patch-"));
  const sites = [
    ["measure_authoring", "run", 5], ["measures", "run", 1], ["simulation", "Popen", 1],
    ["gbxml_import", "run", 1], ["python_ems/actuators", "run", 1],
    ["python_ems/packages", "run", 2], ["server_info", "check_output", 1],
  ];
  try {
    for (const [name, method, count] of sites) {
      const relative = name.startsWith("python_ems") ? `${name}.py` : `${name}/operations.py`;
      const file = path.join(directory, "mcp_server/skills", relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `subprocess.${method}(["command"], timeout=10)\r\n`.repeat(count));
    }
    const envFile = path.join(directory, "mcp_server/sandbox.py");
    await writeFile(envFile, '"PATH", "HOME", "USER",\n            env["TMPDIR"] = str(tmp)\n    return env\n');
    await patchWindowsMcpChildren(directory);
    for (const [name, method, count] of sites) {
      const relative = name.startsWith("python_ems") ? `${name}.py` : `${name}/operations.py`;
      const source = await readFile(path.join(directory, "mcp_server/skills", relative), "utf8");
      assert.equal(source.split(`subprocess.${method}(stdin=subprocess.DEVNULL, args=`).length, count + 1);
    }
    const environment = await readFile(envFile, "utf8");
    assert.match(environment, /"SYSTEMROOT", "WINDIR", "TEMP", "TMP"/);
    assert.match(environment, /env\["TEMP"\] = env\["TMP"\] = str\(tmp\)/);
    assert.match(environment, /env\["HOME"\] = env\["USERPROFILE"\] = str\(home\)/);
    assert.match(environment, /env\["HOMEDRIVE"\] = home\.drive/);
    assert.match(environment, /directory = home \/ "AppData" \/ name/);
    await patchWindowsMcpChildren(directory);
    assert.equal(await readFile(envFile, "utf8"), environment);
    await writeFile(envFile, "unexpected");
    await assert.rejects(patchWindowsMcpChildren(directory), /Unexpected pinned MCP Windows environment source/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Windows event-loop patch uses named pipes and checks pinned CPython source", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "chatstudio-event-loop-"));
  const file = path.join(directory, "asyncio/proactor_events.py");
  try {
    await mkdir(path.dirname(file));
    await writeFile(file, `        self._ssock, self._csock = socket.socketpair()
        self._ssock.setblocking(False)
        self._csock.setblocking(False)
        if threading.current_thread() is threading.main_thread():
            signal.set_wakeup_fd(self._csock.fileno())
        if threading.current_thread() is threading.main_thread():
            signal.set_wakeup_fd(-1)`);
    await patchWindowsEventLoop(directory);
    const patched = await readFile(file, "utf8");
    assert.match(patched, /from chatstudio_windows_self_pipe import pipe_pair/);
    assert.doesNotMatch(patched, /socket\.socketpair/);
    assert.equal(patched.split("and isinstance(self._csock, socket.socket)").length, 3);
    await patchWindowsEventLoop(directory);
    assert.equal(await readFile(file, "utf8"), patched);
    await writeFile(file, "unexpected");
    await assert.rejects(patchWindowsEventLoop(directory), /Unexpected pinned CPython proactor source/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows stdin patch preserves control framing and forwards only Exec input", async () => {
  const { patchWindowsStdio } = await import("../scripts/native/patch-windows-stdio.mjs");
  const directory = await mkdtemp(path.join(tmpdir(), "chatstudio-stdio-patch-"));
  const src = path.join(directory, "src");
  await mkdir(src);
  try {
    await writeFile(path.join(src, "runner.rs"), "let mut stdin = std::io::stdin().lock();");
    await writeFile(path.join(src, "logon.rs"), "    drop(stdin.broker);");
    await patchWindowsStdio(directory);
    const runner = await readFile(path.join(src, "runner.rs"), "utf8");
    const broker = await readFile(path.join(src, "logon.rs"), "utf8");
    assert.match(runner, /ManuallyDrop::new/);
    assert.match(runner, /File::from_raw_handle\(handle\)/);
    assert.doesNotMatch(runner, /stdin\(\)\.lock/);
    assert.match(broker, /matches!\(cmd, crate::runner::RunnerCmd::Exec\(_\)\)/);
    assert.match(broker, /pump\(src, dst\)/);
    assert.match(broker, /CloseHandle\(dst\)/);
    assert.match(broker, /else \{\s+drop\(stdin\.broker\)/);
    await assert.rejects(patchWindowsStdio(directory), /Unexpected pinned sandbox source/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
