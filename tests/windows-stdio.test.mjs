import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

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
