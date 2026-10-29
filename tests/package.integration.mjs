import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { _electron } from "playwright";

test("packaged desktop loads its isolated renderer and agent catalog without development files", { timeout: 60_000 }, async () => {
  const executablePath = process.env.CHATSTUDIO_EXECUTABLE;
  assert.ok(executablePath, "Set CHATSTUDIO_EXECUTABLE to the packaged executable.");
  const userData = await mkdtemp(path.join(tmpdir(), "chatstudio-package-"));
  let electron;
  try {
    electron = await _electron.launch({ executablePath: path.resolve(executablePath), args: [`--user-data-dir=${userData}`] });
    const page = await electron.firstWindow();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("heading", { name: "Set up your workspace" }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll("select option").length > 20);
    assert.equal(await page.evaluate(() => typeof window.require), "undefined");
    const config = await page.evaluate(() => window.chatstudio.loadConfig());
    assert.equal(config.backend.command, "");
    const appPath = await electron.evaluate(({ app }) => {
      if (!app.isPackaged) throw new Error("Expected packaged application.");
      return app.getAppPath();
    });
    for (const excluded of [".runtime", "projects", ".env", "tests", ".git"]) {
      await assert.rejects(access(path.join(appPath, excluded)), { code: "ENOENT" });
    }
    assert.deepEqual(errors, []);
  } finally {
    await electron?.close();
    await rm(userData, { recursive: true, force: true });
  }
});
