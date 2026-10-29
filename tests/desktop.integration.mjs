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
    await page.getByRole("button", { name: "Connect local engine" }).click();
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
    const internet = page.getByRole("switch", { name: "Internet access", exact: true });
    await internet.waitFor({ state: "visible" });
    await page.waitForFunction(() => !document.querySelector('[role="switch"]')?.disabled);
    assert.equal(await internet.isChecked(), false);
    await internet.click();
    await page.waitForFunction(() => document.querySelector('[role="switch"]')?.checked && !document.querySelector('[role="switch"]')?.disabled);
    assert.equal((await page.evaluate(() => window.chatstudio.loadConfig())).internetAccess, true);
    assert.equal(await page.locator("aside").getByLabel("Appearance", { exact: true }).count(), 0);
    assert.equal(await page.locator(".settings").getByLabel("Appearance", { exact: true }).count(), 1);
    assert.deepEqual(await page.getByRole("navigation", { name: "Main views" }).getByRole("button").allTextContents(), ["Chat", "Model", "Results"]);
    assert.equal(await page.getByText("Building assistant", { exact: true }).count(), 0);
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
    await page.waitForFunction(() => !document.querySelector('[role="switch"]')?.disabled);
    assert.equal(await page.getByRole("switch", { name: "Internet access", exact: true }).isChecked(), true);
    await page.getByRole("switch", { name: "Internet access", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[role="switch"]')?.checked && !document.querySelector('[role="switch"]')?.disabled);
    assert.equal((await page.evaluate(() => window.chatstudio.loadConfig())).internetAccess, false);
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
    const logo = page.getByRole("img", { name: "ChatStudio logo", exact: true });
    await logo.waitFor();
    assert.equal(await logo.evaluate((image) => image.complete && image.naturalWidth > 0), true);
    const key = page.getByLabel("API key", { exact: true });
    await key.fill("synthetic-desktop-test-key");
    await page.getByRole("button", { name: "Connect local engine" }).click();
    await page.getByText("206 native tools discovered").waitFor({ timeout: 45_000 });
    await page.getByRole("heading", { name: "What would you like to explore?" }).waitFor();
    await page.getByRole("navigation", { name: "Main views" }).getByRole("button", { name: "Model", exact: true }).click();
    await page.getByRole("heading", { name: "Model", exact: true }).waitFor();
    await page.getByRole("navigation", { name: "Main views" }).getByRole("button", { name: "Results", exact: true }).click();
    await page.getByRole("heading", { name: "Results", exact: true }).waitFor();
    await page.getByRole("navigation", { name: "Main views" }).getByRole("button", { name: "Chat", exact: true }).click();
    await page.getByRole("button", { name: "Summarize my building model" }).click();
    assert.equal(await page.getByRole("textbox", { name: "Message", exact: true }).inputValue(), "Summarize my building model");
    await mkdir(path.join(root, ".runtime"), { recursive: true });
    await page.screenshot({ path: path.join(root, ".runtime", "desktop-preview.png") });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("switch", { name: "Internet access", exact: true }).click();
    await page.getByText("Not connected", { exact: true }).waitFor({ timeout: 10_000 });
    await page.waitForFunction(() => document.querySelector('[role="switch"]')?.checked && !document.querySelector('[role="switch"]')?.disabled);
    await page.getByRole("button", { name: "Connect local engine", exact: true }).click();
    await page.getByText("206 native tools discovered").waitFor();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("switch", { name: "Internet access", exact: true }).click();
    await page.getByText("Not connected", { exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await electron.close();
    await rm(userData, { recursive: true, force: true });
  }
});
