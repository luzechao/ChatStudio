import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { _electron } from "playwright";

test("packaged desktop loads its isolated renderer and agent catalog without development files", { timeout: 90_000 }, async () => {
  const executablePath = process.env.CHATSTUDIO_EXECUTABLE;
  assert.ok(executablePath, "Set CHATSTUDIO_EXECUTABLE to the packaged executable.");
  const userData = await mkdtemp(path.join(tmpdir(), "chatstudio-package-"));
  const workspace = await mkdtemp(path.join(process.platform === "win32" ? process.cwd() : tmpdir(), "chatstudio-package-project-"));
  let electron;
  try {
    electron = await _electron.launch({ executablePath: path.resolve(executablePath), args: [`--user-data-dir=${userData}`] });
    const page = await electron.firstWindow();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("heading", { name: "Set up your workspace" }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll("select option").length > 20);
    assert.equal(await page.evaluate(() => typeof window.require), "undefined");
    assert.equal(await page.getByRole("img", { name: "ChatStudio logo", exact: true })
      .evaluate((image) => image.complete && image.naturalWidth > 0), true);
    const config = await page.evaluate(() => window.chatstudio.loadConfig());
    if (process.env.CHATSTUDIO_EXPECT_BUNDLE === "1") {
      assert.equal(config.bundledRuntime, true);
      assert.ok(config.backend.command.includes(`${path.sep}native${path.sep}`));
      await page.evaluate(async (input) => {
        const config = await window.chatstudio.loadConfig();
        await window.chatstudio.saveConfig({ ...config, workspace: input,
          backend: { ...config.backend, command: "/old-install/native/bin/openstudio-mcp" } });
      }, workspace);
      const restored = await page.evaluate(() => window.chatstudio.loadConfig());
      assert.equal(restored.backend.command, config.backend.command);
      assert.equal(restored.workspace, workspace);
      await page.reload();
      await page.getByRole("button", { name: "Configure external runtime", exact: true }).click();
      await page.getByRole("button", { name: "Use included native runtime", exact: true }).waitFor();
      assert.equal(await page.getByLabel("MCP executable (absolute path)", { exact: true }).isEnabled(), true);
      await page.getByRole("button", { name: "Use included native runtime", exact: true }).click();
      await page.getByRole("button", { name: "Configure external runtime", exact: true }).waitFor();
      assert.equal(await page.getByLabel("MCP executable (absolute path)", { exact: true }).isDisabled(), true);
      await page.getByRole("button", { name: "Connect local engine", exact: true }).click();
      await page.waitForFunction(() => document.body.textContent.includes("207 native tools discovered")
        || document.querySelector('[role="alert"]'), undefined, { timeout: 60_000 });
      assert.deepEqual(await page.getByRole("alert").allTextContents(), [], "Packaged native connection failed");
      await page.getByText("207 native tools discovered").waitFor();
      await page.evaluate(() => window.chatstudio.disconnect());
    } else assert.equal(config.backend.command, "");
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
    await rm(workspace, { recursive: true, force: true });
  }
});
