import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { _electron } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scope = { provider: "chatstudio-custom", baseUrl: "https://company.example/v1" };
const key = "synthetic-encrypted-integration-key";

async function assertForgotten(directory) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await readdir(directory)).length === 0) return;
    await delay(50);
  }
  assert.deepEqual(await readdir(directory), []);
}

test("Electron secure key storage is opt-in, encrypted on disk, restored and forgotten", { timeout: 90_000 }, async () => {
  const userData = await mkdtemp(path.join(tmpdir(), "chatstudio-secure-key-"));
  const launch = () => _electron.launch(process.env.CHATSTUDIO_EXECUTABLE
    ? { executablePath: path.resolve(process.env.CHATSTUDIO_EXECUTABLE), args: [`--user-data-dir=${userData}`] }
    : { args: [root, `--user-data-dir=${userData}`], cwd: root });
  let electron;
  try {
    electron = await launch();
    let page = await electron.firstWindow();
    await page.getByLabel("Provider", { exact: true }).selectOption(scope.provider);
    await page.getByLabel("Model / deployment name", { exact: true }).fill("test-model");
    await page.getByLabel("API base URL", { exact: true }).fill(scope.baseUrl);
    await page.getByLabel("API key", { exact: true }).fill(key);
    const remember = page.getByLabel("Remember API key on this device", { exact: true });
    assert.equal(await remember.isChecked(), false);
    const directory = await electron.evaluate(({ app }) => `${app.getPath("userData")}/credentials`);
    await assert.rejects(readdir(directory), { code: "ENOENT" });
    const state = await page.evaluate((scope) => window.chatstudio.loadCredential(scope), scope);
    if (process.platform !== "linux") assert.equal(state.available, true, "This platform must provide secure OS encryption");
    if (!state.available) {
      assert.equal(await remember.isDisabled(), true);
      await assert.rejects(page.evaluate(({ scope, key }) => window.chatstudio.saveCredential(scope, key), { scope, key }),
        /encryption is unavailable/);
      await assert.rejects(readdir(directory), { code: "ENOENT" });
      return;
    }
    await remember.click();
    await page.getByText("API key saved with OS encryption for this provider/endpoint.", { exact: false }).waitFor();
    const [file] = await readdir(directory);
    assert.match(file, /^[a-f0-9]{64}\.bin$/);
    const encrypted = await readFile(path.join(directory, file));
    assert.ok(!encrypted.includes(key));
    if (process.platform !== "win32") assert.equal((await lstat(path.join(directory, file))).mode & 0o777, 0o600);
    const decrypted = await electron.evaluate(({ safeStorage }, bytes) => safeStorage.decryptString(Buffer.from(bytes)), [...encrypted]);
    assert.equal(decrypted, key, "The file must use actual Electron OS-backed encryption");
    await page.getByLabel("API base URL", { exact: true }).fill("https://other.example/v1");
    await page.getByLabel("API key", { exact: true }).fill("temporary-other-key");
    assert.equal(await remember.isChecked(), false);
    await page.getByLabel("API base URL", { exact: true }).fill(scope.baseUrl);
    await page.getByText("API key saved with OS encryption for this provider/endpoint.", { exact: false }).waitFor();
    assert.equal(await page.getByLabel("API key", { exact: true }).inputValue(), key);
    await page.getByLabel("API key", { exact: true }).fill(`${key}-updated`);
    await page.getByRole("button", { name: "Update saved key", exact: true }).click();
    await page.getByText("API key saved with OS encryption for this provider/endpoint.", { exact: false }).waitFor();
    await page.getByRole("button", { name: "Open chat", exact: true }).click();
    await page.getByRole("textbox", { name: "Message", exact: true }).waitFor();
    const config = await readFile(path.join(path.dirname(directory), "config.json"), "utf8");
    assert.ok(!config.includes(key));
    await electron.close();
    electron = await launch();
    page = await electron.firstWindow();
    await page.getByText("API key saved with OS encryption for this provider/endpoint.", { exact: false }).waitFor();
    assert.equal(await page.getByLabel("API key", { exact: true }).inputValue(), `${key}-updated`);
    assert.equal(await page.getByLabel("Remember API key on this device", { exact: true }).isChecked(), true);
    await page.getByLabel("Remember API key on this device", { exact: true }).click();
    await page.getByText("Optional: save with OS encryption.", { exact: false }).waitFor();
    await assertForgotten(directory);
    assert.equal(await page.getByLabel("API key", { exact: true }).inputValue(), `${key}-updated`, "Forget keeps the current session usable");
    await electron.close();
    electron = await launch();
    page = await electron.firstWindow();
    await page.getByText("Optional: save with OS encryption.", { exact: false }).waitFor();
    assert.equal(await page.getByLabel("API key", { exact: true }).inputValue(), "");
    await page.getByLabel("API key", { exact: true }).fill(key);
    await page.getByLabel("Remember API key on this device", { exact: true }).click();
    await page.getByText("API key saved with OS encryption for this provider/endpoint.", { exact: false }).waitFor();
    const [corrupted] = await readdir(directory);
    await writeFile(path.join(directory, corrupted), "invalid encrypted bytes");
    await page.reload();
    await page.getByRole("alert").filter({ hasText: "Could not decrypt" }).waitFor();
    await page.getByRole("button", { name: "Forget saved key", exact: true }).click();
    await page.getByText("Optional: save with OS encryption.", { exact: false }).waitFor();
    await assertForgotten(directory);
    await page.getByLabel("API key", { exact: true }).fill(key);
    assert.equal(await page.getByLabel("Remember API key on this device", { exact: true }).isEnabled(), true);
  } finally {
    await electron?.close();
    await rm(userData, { recursive: true, force: true });
  }
});
