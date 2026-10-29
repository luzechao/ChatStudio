import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { _electron } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Electron agent streams from a local OpenAI-compatible host and reports provider/connection errors", { timeout: 90_000 }, async () => {
  const userData = await mkdtemp(path.join(tmpdir(), "chatstudio-provider-"));
  const requests = [];
  let mode = "success";
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
    res.write(chunk({ role: "assistant", content: "Hello from " }));
    res.write(chunk({ content: "the local host." }));
    res.end(`${chunk({}, "stop")}data: [DONE]\n\n`);
  });
  let electron;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    electron = await _electron.launch({ args: [root, `--user-data-dir=${userData}`], cwd: root });
    for (mode of ["success", "unauthorized", "rate-limit", "disconnect"]) {
      const result = await electron.evaluate(async ({ utilityProcess }, input) => {
        const env = {};
        for (const key of ["PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot", "TEMP", "TMP", "LANG"]) {
          if (process.env[key]) env[key] = process.env[key];
        }
        const child = utilityProcess.fork(input.entry, [input.baseUrl, input.privateRoot], { env, stdio: "pipe" });
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { child.kill(); reject(new Error("Local provider test timed out.")); }, 20_000);
          let stderr = "";
          child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-4000); });
          child.on("message", (data) => { clearTimeout(timer); child.kill(); resolve(data); });
          child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`Provider host exited (${code}): ${stderr}`)); });
        });
      }, { entry: path.join(root, "tests/provider-host.mjs"), baseUrl, privateRoot: userData });
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
    assert.equal(requests.length, 4);
    for (const request of requests) {
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.authorization, "Bearer synthetic-local-key");
      assert.equal(request.body.model, "diagnostic");
      assert.equal(request.body.stream, true);
      assert.ok(request.body.messages.some((message) => message.role === "user"
        && (typeof message.content === "string" ? message.content
          : message.content.filter((part) => part.type === "text").map((part) => part.text).join("")) === "Say hello."));
      assert.deepEqual(request.body.tools.map((tool) => tool.function.name).sort(), ["call_openstudio_tool", "search_openstudio_tools"]);
    }
    mode = "success";
    let page = await electron.firstWindow();
    await page.waitForFunction(() => document.querySelectorAll("select option").length > 20);
    await page.getByLabel("Provider", { exact: true }).selectOption("chatstudio-custom");
    await page.getByLabel("Model / deployment name", { exact: true }).fill("diagnostic");
    await page.getByLabel("API base URL", { exact: true }).fill("invalid");
    await page.getByLabel("API key", { exact: true }).fill("synthetic-local-key");
    await page.getByRole("button", { name: "Open chat", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "valid HTTP or HTTPS URL" }).waitFor();
    await page.getByLabel("API base URL", { exact: true }).fill(baseUrl);
    await page.getByRole("button", { name: "Open chat", exact: true }).click();
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Say hello.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByText("Hello from the local host.", { exact: true }).waitFor();
    assert.equal(requests.length, 5);
    assert.equal(requests.at(-1).url, "/v1/chat/completions");
    assert.equal(requests.at(-1).body.model, "diagnostic");
    assert.equal(requests.at(-1).authorization, "Bearer synthetic-local-key");
    const savedPath = await electron.evaluate(({ app }) => `${app.getPath("userData")}/config.json`);
    const saved = await readFile(savedPath, "utf8");
    assert.deepEqual(JSON.parse(saved).customEndpoint, { baseUrl, model: "diagnostic" });
    assert.ok(!saved.includes("synthetic-local-key"));
    await electron.close();
    electron = await _electron.launch({ args: [root, `--user-data-dir=${userData}`], cwd: root });
    page = await electron.firstWindow();
    await page.getByLabel("API base URL", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("Provider", { exact: true }).inputValue(), "chatstudio-custom");
    assert.equal(await page.getByLabel("API base URL", { exact: true }).inputValue(), baseUrl);
    assert.equal(await page.getByLabel("Model / deployment name", { exact: true }).inputValue(), "diagnostic");
    assert.equal(await page.getByLabel("API key", { exact: true }).inputValue(), "");
  } finally {
    await electron?.close();
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(userData, { recursive: true, force: true });
  }
});
