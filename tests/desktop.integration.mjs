import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { _electron } from "playwright";
import { createServer } from "node:http";
import { once } from "node:events";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("session approval UI skips repeated prompts and revokes through IPC", { timeout: 90_000 }, async () => {
  const userData = await mkdtemp(path.join(tmpdir(), "chatstudio-permissions-"));
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    const toolResult = request.messages.at(-1).role === "tool";
    const delta = toolResult ? { content: "Tool finished." } : {
      tool_calls: [{ index: 0, id: `call-${Date.now()}`, type: "function",
        function: { name: "call_openstudio_tool", arguments: JSON.stringify({ name: "get_model_summary", arguments: {} }) } }],
    };
    const chunk = (value, reason) => `data: ${JSON.stringify({
      id: "permissions-test", object: "chat.completion.chunk", created: 1, model: "test",
      choices: [{ index: 0, delta: value, finish_reason: reason }],
    })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(chunk(delta, null) + chunk({}, toolResult ? "stop" : "tool_calls") + "data: [DONE]\n\n");
  });
  let electron;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    electron = await _electron.launch({ args: [root, `--user-data-dir=${userData}`], cwd: root });
    const page = await electron.firstWindow();
    await page.waitForFunction(() => document.querySelectorAll("select option").length > 20);
    await page.getByLabel("Provider", { exact: true }).selectOption("chatstudio-custom");
    await page.getByLabel("Model / deployment name", { exact: true }).fill("test");
    await page.getByLabel("API base URL", { exact: true }).fill(`http://127.0.0.1:${server.address().port}/v1`);
    await page.getByLabel("API key", { exact: true }).fill("synthetic-local-key");
    await page.getByRole("button", { name: "Connect sandboxed backend" }).click();
    await page.getByText("206 native tools discovered").waitFor();
    const send = async () => {
      await page.getByRole("textbox", { name: "Message", exact: true }).fill("Inspect model.");
      await page.getByRole("button", { name: "Send", exact: true }).click();
    };
    await send();
    await page.getByRole("button", { name: "Allow this tool for this session", exact: true }).click();
    await page.getByRole("button", { name: "Revoke get_model_summary", exact: true }).waitFor();
    await page.getByText("Tool finished.", { exact: true }).waitFor();
    await send();
    await page.waitForFunction(() => [...document.querySelectorAll(".message-text")]
      .filter((element) => element.textContent === "Tool finished.").length === 2);
    assert.equal(await page.getByRole("dialog", { name: "Approve tool execution" }).count(), 0);
    await page.getByRole("button", { name: "Revoke get_model_summary", exact: true }).click();
    await page.getByRole("button", { name: "Revoke get_model_summary", exact: true }).waitFor({ state: "detached" });
    await send();
    await page.getByRole("dialog", { name: "Approve tool execution" }).waitFor();
    await page.getByRole("button", { name: "Allow this tool for this session", exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll(".message-text")]
      .filter((element) => element.textContent === "Tool finished.").length === 3);
    await page.getByRole("button", { name: "+ New conversation", exact: true }).click();
    await page.getByRole("button", { name: "Revoke get_model_summary", exact: true }).waitFor({ state: "detached" });
    await send();
    await page.getByRole("dialog", { name: "Approve tool execution" }).waitFor();
    await page.getByRole("button", { name: "Deny", exact: true }).click();
    await page.getByText("Tool finished.", { exact: true }).waitFor();
  } finally {
    await electron?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(userData, { recursive: true, force: true });
  }
});

test("appearance follows system live, honors overrides, and persists across app restarts", { timeout: 60_000 }, async () => {
  const userData = await mkdtemp(path.join(tmpdir(), "chatstudio-theme-"));
  let electron;
  try {
    electron = await _electron.launch({ args: [root, `--user-data-dir=${userData}`], cwd: root });
    let page = await electron.firstWindow();
    const appearance = page.getByLabel("Appearance", { exact: true });
    await appearance.waitFor();
    assert.equal(await appearance.inputValue(), "system");
    const check = async (theme) => {
      await page.waitForFunction((expected) => document.documentElement.dataset.theme === expected, theme);
      return page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
    };
    await page.emulateMedia({ colorScheme: "light" });
    const light = await check("light");
    await page.emulateMedia({ colorScheme: "dark" });
    const dark = await check("dark");
    assert.notEqual(light, dark);
    await appearance.selectOption("light");
    assert.equal(await check("light"), light);
    await page.emulateMedia({ colorScheme: "light" });
    await appearance.selectOption("dark");
    assert.equal(await check("dark"), dark);
    await electron.close();
    electron = await _electron.launch({ args: [root, `--user-data-dir=${userData}`], cwd: root });
    page = await electron.firstWindow();
    await page.waitForFunction(() => document.querySelector(".appearance select")?.value === "dark");
    await page.emulateMedia({ colorScheme: "light" });
    assert.equal(await check("dark"), dark);
    await page.getByLabel("Appearance", { exact: true }).selectOption("system");
    assert.equal(await check("light"), light);
    await page.emulateMedia({ colorScheme: "dark" });
    assert.equal(await check("dark"), dark);
  } finally {
    await electron?.close();
    await rm(userData, { recursive: true, force: true });
  }
});

test("desktop renderer, isolated preload, Pi host, and native sandboxed MCP connect", { timeout: 90_000 }, async () => {
  const userData = await mkdtemp(path.join(tmpdir(), "chatstudio-desktop-"));
  const electron = await _electron.launch({ args: [root, `--user-data-dir=${userData}`], cwd: root });
  try {
    const page = await electron.firstWindow();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.getByRole("heading", { name: "Set up your workspace" }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll("select option").length > 20);
    assert.equal(await page.evaluate(() => typeof window.require), "undefined");
    const key = page.getByLabel("API key");
    await key.fill("synthetic-desktop-test-key");
    await page.getByRole("button", { name: "Connect sandboxed backend" }).click();
    await page.getByText("206 native tools discovered").waitFor({ timeout: 45_000 });
    await page.getByRole("heading", { name: "What would you like to explore?" }).waitFor();
    await page.getByRole("button", { name: "Summarize my building model" }).click();
    assert.equal(await page.getByRole("textbox", { name: "Message", exact: true }).inputValue(), "Summarize my building model");
    await mkdir(path.join(root, ".runtime"), { recursive: true });
    await page.screenshot({ path: path.join(root, ".runtime", "desktop-preview.png") });
    await page.getByRole("button", { name: "Settings & runtime" }).click();
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    await page.getByText("Not connected", { exact: true }).waitFor({ timeout: 10_000 });
    assert.deepEqual(errors, []);
  } finally {
    await electron.close();
    await rm(userData, { recursive: true, force: true });
  }
});
