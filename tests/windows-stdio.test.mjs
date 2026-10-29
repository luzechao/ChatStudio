import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { patchWindowsEventLoop } from "../scripts/native/patch-windows-stdio.mjs";

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
