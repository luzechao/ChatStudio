import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Credentials } from "../src/main/credentials.js";
import { CUSTOM_PROVIDER } from "../src/shared/contracts.js";

function encryption() {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString(value: string) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decryptString(value: Buffer) {
      const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12), { authTagLength: 16 });
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString("utf8");
    },
  };
}

test("API keys are opt-in, encrypted, provider/endpoint scoped, replaceable and removable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "chatstudio-credentials-"));
  try {
    const crypto = encryption();
    const keys = new Credentials(root, crypto);
    const provider = { provider: "openrouter" };
    const custom = { provider: CUSTOM_PROVIDER, baseUrl: " https://company.example/v1/ " };
    assert.deepEqual(await keys.load(provider), { available: true, saved: false, apiKey: null });
    await assert.rejects(readdir(path.join(root, "credentials")), { code: "ENOENT" });
    await keys.save(provider, "synthetic-provider-key");
    await keys.save(custom, "synthetic-company-key");
    const directory = path.join(root, "credentials");
    for (const file of await readdir(directory)) {
      const bytes = await readFile(path.join(directory, file));
      assert.ok(!bytes.includes("synthetic-"));
      if (process.platform !== "win32") assert.equal((await lstat(path.join(directory, file))).mode & 0o777, 0o600);
    }
    if (process.platform !== "win32") assert.equal((await lstat(directory)).mode & 0o777, 0o700);
    assert.equal((await new Credentials(root, crypto).load(provider)).apiKey, "synthetic-provider-key");
    assert.equal((await keys.load({ ...custom, baseUrl: "https://company.example/v1" })).apiKey, "synthetic-company-key");
    assert.equal((await keys.load({ ...custom, baseUrl: "https://different.example/v1" })).saved, false);
    assert.equal((await keys.load({ provider: "anthropic" })).saved, false);
    await keys.save(provider, "replacement-key");
    assert.equal((await keys.load(provider)).apiKey, "replacement-key");
    await Promise.all([keys.save(provider, "racing-save"), keys.forget(provider)]);
    assert.equal((await keys.load(provider)).saved, false, "Forget must win over an earlier in-flight save");
    await keys.forget(provider); await keys.forget(provider);
    assert.equal((await keys.load(provider)).saved, false);
    assert.equal((await keys.load(custom)).saved, true);
    const [file] = await readdir(directory);
    await writeFile(path.join(directory, file), "corrupted ciphertext");
    await assert.rejects(keys.load(custom), /Could not decrypt/);
    await keys.forget(custom);
    assert.deepEqual(await readdir(directory), []);
    for (const scope of [{ provider: "../escape" }, { provider: "" }, { provider: CUSTOM_PROVIDER },
      { provider: CUSTOM_PROVIDER, baseUrl: "https://example.com/v1?key=secret" }]) {
      await assert.rejects(keys.save(scope, "synthetic-key"));
    }
    await assert.rejects(keys.save(provider, " "), /Enter an API key/);
    await assert.rejects(keys.save(provider, "x".repeat(8193)), /Enter an API key/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unavailable or insecure OS encryption never writes plaintext and still allows forgetting keys", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "chatstudio-locked-credentials-"));
  try {
    const crypto = encryption();
    const scope = { provider: "openrouter" };
    await new Credentials(root, crypto).save(scope, "synthetic-key");
    for (const storage of [
      { ...crypto, isEncryptionAvailable: () => false },
      { ...crypto, getSelectedStorageBackend: () => "basic_text" },
      { ...crypto, getSelectedStorageBackend: () => "unknown" },
    ]) {
      const keys = new Credentials(root, storage, "linux");
      assert.deepEqual(await keys.load(scope), { available: false, saved: true, apiKey: null });
      await assert.rejects(keys.save(scope, "do-not-save"), /encryption is unavailable/);
    }
    const failing = new Credentials(root, { ...crypto, encryptString() { throw new Error("sensitive exception"); } });
    await assert.rejects(failing.save(scope, "do-not-save"), /^Error: Could not encrypt the API key. No key was saved.$/);
    assert.equal((await new Credentials(root, crypto).load(scope)).apiKey, "synthetic-key");
    await new Credentials(root, { ...crypto, isEncryptionAvailable: () => false }).forget(scope);
    assert.deepEqual(await readdir(path.join(root, "credentials")), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
