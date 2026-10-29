import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { _electron } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const markdownReply = [
  "## Building summary", "", "This is **important** with `inline_code`.", "",
  "- First item", "- Second item", "", "> Review assumptions.", "",
  "| Space | Area |", "| --- | --- |", "| Office | 100 m² |", "",
  "- [x] Model loaded", "", "```python", "print('hello')", "```", "",
  "[Documentation](https://example.com/docs)", "", "![Hidden image](https://example.com/hidden.png)", "",
  "[Unsafe](javascript:alert(1))", "", "<script>window.markdownExecuted = true</script>",
  '<img src="https://example.com/unsafe.png" onerror="window.markdownExecuted = true">',
].join("\n");

test("Electron agent streams from a local OpenAI-compatible host and reports provider/connection errors", { timeout: 90_000 }, async () => {
  const userData = await mkdtemp(path.join(tmpdir(), "chatstudio-provider-"));
  const projectBase = await realpath(await mkdtemp(path.join(tmpdir(), "chatstudio-history-")));
  const projectA = path.join(projectBase, "Project A");
  const projectB = path.join(projectBase, "Project B");
  await mkdir(path.join(projectA, "inputs"), { recursive: true });
  await mkdir(projectB);
  await writeFile(path.join(projectA, "inputs/example.osm"), "example model");
  const requests = [];
  let mode = "success";
  let releaseResponse;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(body) });
    if (mode === "disconnect") { req.socket.destroy(); return; }
    if (mode === "unauthorized" || mode === "rate-limit") {
      res.writeHead(mode === "unauthorized" ? 401 : 429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: {
        message: mode === "unauthorized" ? "Invalid diagnostic key" : "Diagnostic quota exceeded",
        type: mode === "unauthorized" ? "authentication_error" : "rate_limit_error",
      } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({
      id: "chatcmpl-local", object: "chat.completion.chunk", created: 1, model: "diagnostic",
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`;
    if (mode.startsWith("web-") && requests.at(-1).body.messages.at(-1).role !== "tool") {
      const query = mode === "web-secret" ? "synthetic-local-key" : "OpenStudio documentation";
      res.write(chunk({ role: "assistant", tool_calls: [{
        index: 0, id: "search-1", type: "function",
        function: { name: "web_search", arguments: JSON.stringify({ query, numResults: 2 }) },
      }] }));
      res.end(`${chunk({}, "tool_calls")}data: [DONE]\n\n`);
      return;
    }
    const text = mode === "markdown" ? markdownReply : mode === "hold" ? "Partial response. synthetic-local-key" : "Hello from the local host.";
    const split = mode === "markdown" ? text.indexOf("```python") + 5 : 11;
    res.write(chunk({ role: "assistant", content: text.slice(0, split) }));
    if (mode === "hold") await new Promise((resolve) => { releaseResponse = resolve; });
    res.write(chunk({ content: text.slice(split) }));
    res.end(`${chunk({}, "stop")}data: [DONE]\n\n`);
  });
  let electron;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    electron = await _electron.launch({ args: [root, `--user-data-dir=${userData}`], cwd: root });
    for (const scenario of [
      { mode: "success", provider: "chatstudio-custom" },
      { mode: "unauthorized", provider: "chatstudio-custom" },
      { mode: "rate-limit", provider: "chatstudio-custom" },
      { mode: "disconnect", provider: "chatstudio-custom" },
      { mode: "success", provider: "openrouter" },
    ]) {
      mode = scenario.mode;
      const result = await electron.evaluate(async ({ utilityProcess }, input) => {
        const env = {};
        for (const key of ["PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot", "TEMP", "TMP", "LANG"]) {
          if (process.env[key]) env[key] = process.env[key];
        }
        const child = utilityProcess.fork(input.entry, [input.baseUrl, input.privateRoot, input.provider], { env, stdio: "pipe" });
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { child.kill(); reject(new Error("Local provider test timed out.")); }, 20_000);
          let stderr = "";
          child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-4000); });
          child.on("message", (data) => { clearTimeout(timer); child.kill(); resolve(data); });
          child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`Provider host exited (${code}): ${stderr}`)); });
        });
      }, { entry: path.join(root, "tests/provider-host.mjs"), baseUrl, privateRoot: userData, provider: scenario.provider });
      assert.equal(result.failure, undefined);
      assert.deepEqual(result.credentials, []);
      const errors = result.events.filter((event) => event.type === "error").map((event) => event.message);
      if (mode === "success") {
        assert.deepEqual(errors, []);
        assert.equal(result.events.filter((event) => event.type === "text").map((event) => event.text).join(""), "Hello from the local host.");
      } else {
        assert.equal(errors.length, 1, JSON.stringify(result));
        assert.match(errors[0], mode === "unauthorized" ? /401.*Invalid diagnostic key/s
          : mode === "rate-limit" ? /429.*Diagnostic quota exceeded/s : /connection|fetch failed|socket/i);
      }
    }
    assert.equal(requests.length, 5);
    for (const [index, request] of requests.entries()) {
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.authorization, "Bearer synthetic-local-key");
      assert.equal(request.body.model, index === 4 ? "~anthropic/claude-haiku-latest" : "diagnostic");
      assert.equal(request.body.stream, true);
      assert.ok(request.body.messages.some((message) => message.role === "user"
        && (typeof message.content === "string" ? message.content
          : message.content.filter((part) => part.type === "text").map((part) => part.text).join("")) === "Say hello."));
      assert.deepEqual(request.body.tools.map((tool) => tool.function.name).sort(), ["call_openstudio_tool", "search_openstudio_tools"]);
    }
    mode = "success";
    let page = await electron.firstWindow();
    await page.waitForFunction(() => document.querySelectorAll("select option").length > 20);
    await electron.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, projectA);
    await page.getByRole("button", { name: "Open project folder", exact: true }).click();
    await page.getByRole("heading", { name: "Project A", exact: true }).waitFor();
    await page.getByRole("cell", { name: path.join("inputs", "example.osm"), exact: true }).waitFor();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Close Settings", exact: true }).waitFor();
    await page.getByLabel("Provider", { exact: true }).selectOption("chatstudio-custom");
    await page.getByLabel("Model / deployment name", { exact: true }).fill("diagnostic");
    await page.getByLabel("API base URL", { exact: true }).fill("invalid");
    await page.getByLabel("API key", { exact: true }).fill("synthetic-local-key");
    await page.getByRole("button", { name: "Open chat", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "valid HTTP or HTTPS URL" }).waitFor();
    await page.getByLabel("API base URL", { exact: true }).fill(baseUrl);
    await page.getByLabel("API base URL", { exact: true }).press("Tab");
    await page.getByText(/^(Optional: save with OS encryption|Secure OS encryption is unavailable)/).waitFor();
    await page.getByLabel("API key", { exact: true }).fill("synthetic-local-key");
    await page.getByRole("button", { name: "Open chat", exact: true }).click();
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Say hello.");
    for (const width of [1200, 800]) {
      await page.setViewportSize({ width, height: 900 });
      for (const height of [76, 150]) {
        const alignment = await page.evaluate((height) => {
          const textarea = document.querySelector("footer textarea");
          textarea.style.height = `${height}px`;
          const input = textarea.getBoundingClientRect();
          const button = document.querySelector("footer form button").getBoundingClientRect();
          const newChat = document.querySelector(".new-chat");
          const text = document.createRange();
          text.selectNodeContents(newChat);
          const textBox = text.getBoundingClientRect();
          const newChatBox = newChat.getBoundingClientRect();
          return {
            composerOffset: Math.abs(input.y + input.height / 2 - button.y - button.height / 2),
            newChatOffset: Math.abs(newChatBox.x + newChatBox.width / 2 - textBox.x - textBox.width / 2),
          };
        }, height);
        assert.ok(alignment.composerOffset < 1, JSON.stringify(alignment));
        assert.ok(alignment.newChatOffset < 1, JSON.stringify(alignment));
      }
    }
    await page.locator("footer textarea").evaluate((element) => { element.style.removeProperty("height"); });
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByText("Hello from the local host.", { exact: true }).waitFor();
    assert.equal(requests.length, 6);
    assert.equal(requests.at(-1).url, "/v1/chat/completions");
    assert.equal(requests.at(-1).body.model, "diagnostic");
    assert.equal(requests.at(-1).authorization, "Bearer synthetic-local-key");
    const savedPath = await electron.evaluate(({ app }) => `${app.getPath("userData")}/config.json`);
    const saved = await readFile(savedPath, "utf8");
    assert.deepEqual(JSON.parse(saved).customEndpoint, { baseUrl, model: "diagnostic" });
    assert.ok(!saved.includes("synthetic-local-key"));
    mode = "markdown";
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("**My question**\nKeep this plain text.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const reply = page.getByRole("article", { name: "ChatStudio reply", exact: true }).last();
    await reply.getByRole("heading", { name: "Building summary" }).waitFor();
    await page.getByRole("button", { name: "Send", exact: true }).waitFor();
    assert.equal(await reply.locator("strong").innerText(), "important");
    assert.equal(await reply.locator("pre code").innerText(), "print('hello')\n");
    assert.equal(await reply.getByRole("table").count(), 1);
    assert.equal(await reply.locator("tbody td").first().innerText(), "Office");
    assert.equal(await reply.locator('input[type="checkbox"]:checked:disabled').count(), 1);
    assert.equal(await reply.locator("blockquote").innerText(), "Review assumptions.");
    assert.equal(await reply.locator(".message-text").locator("a, img, script").count(), 0);
    assert.equal(await reply.locator(".speaker").innerText(), "ChatStudio");
    assert.equal(await reply.locator(".speaker").locator("img, .message-avatar").count(), 0);
    assert.equal(await page.evaluate(() => window.markdownExecuted), undefined);
    const user = page.getByRole("article", { name: "Your message", exact: true }).last();
    assert.equal(await user.locator(".speaker").innerText(), "You");
    assert.equal(await user.locator(".speaker").locator("img, .message-avatar").count(), 0);
    assert.equal(await user.locator(".message-text").innerText(), "**My question**\nKeep this plain text.");
    assert.equal(await user.locator("strong").count(), 0);
    const visual = () => page.evaluate(() => {
      const users = document.querySelectorAll(".message.user");
      const assistants = document.querySelectorAll(".message.assistant");
      const user = users[users.length - 1];
      const assistant = assistants[assistants.length - 1];
      return {
        userColor: getComputedStyle(user.querySelector(".message-text")).backgroundColor,
        assistantColor: getComputedStyle(assistant.querySelector(".message-text")).backgroundColor,
        userLeft: user.getBoundingClientRect().left,
        assistantLeft: assistant.getBoundingClientRect().left,
        overflow: document.documentElement.scrollWidth > window.innerWidth,
      };
    });
    await mkdir(path.join(root, ".runtime"), { recursive: true });
    for (const theme of ["light", "dark"]) {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByLabel("Appearance", { exact: true }).selectOption(theme);
      await page.getByRole("navigation", { name: "Main views" }).getByRole("button", { name: "Chat", exact: true }).click();
      await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, theme);
      const styles = await visual();
      assert.notEqual(styles.userColor, styles.assistantColor);
      assert.ok(styles.userLeft > styles.assistantLeft);
      assert.equal(styles.overflow, false);
      await page.screenshot({ path: path.join(root, ".runtime", `chat-markdown-${theme}.png`) });
    }
    await page.getByRole("region", { name: "Project conversation history" })
      .getByRole("button", { name: /Say hello/ }).waitFor();
    await page.getByRole("region", { name: "Project conversation history" }).getByRole("button", { name: /Say hello/ }).click();
    await page.getByText("Saved conversation", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Back to current chat", exact: true }).click();
    await page.getByRole("textbox", { name: "Message", exact: true }).waitFor();
    assert.equal(await page.getByRole("article", { name: "Your message", exact: true }).count(), 2);
    await electron.close();
    electron = await _electron.launch({ args: [root, `--user-data-dir=${userData}`], cwd: root });
    page = await electron.firstWindow();
    await page.getByLabel("API base URL", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("Provider", { exact: true }).inputValue(), "chatstudio-custom");
    assert.equal(await page.getByLabel("API base URL", { exact: true }).inputValue(), baseUrl);
    assert.equal(await page.getByLabel("Model / deployment name", { exact: true }).inputValue(), "diagnostic");
    assert.equal(await page.getByLabel("API key", { exact: true }).inputValue(), "");
    await page.getByRole("region", { name: "Project conversation history" }).getByRole("button", { name: /Say hello/ }).click();
    await page.getByText("Saved conversation", { exact: true }).waitFor();
    await page.getByRole("heading", { name: "Building summary", exact: true }).waitFor();
    assert.equal(await page.getByRole("textbox", { name: "Message", exact: true }).count(), 0);
    assert.equal(requests.length, 7, "Viewing history must not replay requests");
    const savedHistory = JSON.stringify(await page.evaluate(() => window.chatstudio.projectState()));
    assert.ok(!savedHistory.includes("synthetic-local-key"));
    await electron.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, projectB);
    await page.getByRole("button", { name: "Open project folder", exact: true }).click();
    await page.getByRole("heading", { name: "Project B", exact: true }).waitFor();
    assert.equal(await page.getByRole("region", { name: "Project conversation history" }).getByRole("button").count(), 0);
    await page.getByLabel("Recent projects", { exact: true }).selectOption(projectA);
    await page.getByRole("heading", { name: "Project A", exact: true }).waitFor();
    await page.getByRole("region", { name: "Project conversation history" }).getByRole("button", { name: /Say hello/ }).click();
    await page.getByRole("heading", { name: "Building summary", exact: true }).waitFor();
    assert.equal(await page.getByText("OS sandbox required", { exact: true }).count(), 0);
    assert.equal(await page.getByText("Network denied.", { exact: false }).count(), 0);
    await page.getByRole("button", { name: "Back to current chat", exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByLabel("API key", { exact: true }).fill("synthetic-local-key");
    await page.getByRole("button", { name: "Open chat", exact: true }).click();
    mode = "hold";
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Keep this key private: synthetic-local-key");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByText("Partial res", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Open project folder", exact: true }).isDisabled(), true);
    await assert.rejects(page.evaluate((folder) => window.chatstudio.openProject(folder), projectB), /Wait for the current operation/);
    assert.equal((await page.evaluate(() => window.chatstudio.projectState())).project.path, projectA);
    releaseResponse();
    await page.getByRole("button", { name: "Send", exact: true }).waitFor();
    let history = await page.evaluate(() => window.chatstudio.projectState());
    assert.ok(!JSON.stringify(history).includes("synthetic-local-key"));
    assert.ok(history.conversations[0].messages.every((message) => message.text.includes("[redacted]")));
    await page.getByRole("button", { name: "+ New conversation", exact: true }).click();
    await page.getByRole("heading", { name: /What would you like/ }).waitFor();
    mode = "unauthorized";
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Failed request");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByRole("button", { name: "Send", exact: true }).waitFor();
    history = await page.evaluate(() => window.chatstudio.projectState());
    assert.equal(history.conversations.length, 3);
    assert.match(history.conversations[0].messages[1].text, /Request error:.*401.*Invalid diagnostic key/s);
    assert.ok(!JSON.stringify(history).includes("synthetic-local-key"));
    mode = "success";
    for (const enabled of [true, false]) {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("switch", { name: "Internet access", exact: true }).click();
      await page.waitForFunction((enabled) =>
        document.querySelector('[aria-label="Internet access"]').checked === enabled, enabled);
      await page.getByRole("button", { name: "Open chat", exact: true }).click();
      await page.getByRole("textbox", { name: "Message", exact: true }).fill("Check internet tool availability.");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await page.getByRole("button", { name: "Send", exact: true }).waitFor();
      assert.equal(requests.at(-1).body.tools.some((tool) => tool.function.name === "web_search"), enabled);
      assert.equal(JSON.parse(await readFile(savedPath, "utf8")).internetAccess, enabled);
    }
    for (const webMode of ["allow", "deny", "secret"]) {
      mode = `web-${webMode}`;
      const result = await electron.evaluate(async ({ utilityProcess }, input) => {
        const child = utilityProcess.fork(input.entry,
          [input.baseUrl, input.privateRoot, "chatstudio-custom", input.webMode], { stdio: "pipe" });
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { child.kill(); reject(new Error("Web-search agent test timed out.")); }, 20_000);
          child.on("message", (data) => { clearTimeout(timer); child.kill(); resolve(data); });
          child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`Web-search agent exited (${code}).`)); });
        });
      }, { entry: path.join(root, "tests/provider-host.mjs"), baseUrl, privateRoot: userData, webMode });
      assert.equal(result.failure, undefined);
      assert.deepEqual(result.credentials, []);
      assert.equal(result.webRequests.length, webMode === "allow" ? 1 : 0);
      assert.ok(!JSON.stringify(result.webRequests).includes("synthetic-local-key"));
      assert.ok(result.events.some((event) => event.type === "tool" && event.name === "web_search"
        && event.phase === "end" && event.error === (webMode !== "allow")));
      const toolReply = requests.at(-1).body.messages.find((message) => message.role === "tool");
      assert.ok(toolReply);
      assert.match(JSON.stringify(toolReply), webMode === "allow" ? /https:\/\/openstudio.net/
        : webMode === "deny" ? /not approved/ : /credentials/);
    }
  } finally {
    releaseResponse?.();
    await electron?.close();
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(userData, { recursive: true, force: true });
    await rm(projectBase, { recursive: true, force: true });
  }
});
