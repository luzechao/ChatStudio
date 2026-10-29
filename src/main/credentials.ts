import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { CUSTOM_PROVIDER, validateCustomEndpoint, type CredentialScope, type CredentialState } from "../shared/contracts.js";

interface Encryption {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export class Credentials {
  private writes: Promise<void> = Promise.resolve();
  constructor(private root: string, private encryption: Encryption, private platform = process.platform) {}

  private update(action: () => Promise<void>): Promise<void> {
    const result = this.writes.then(action);
    // Keep later operations usable after a failure; the caller receives the original rejection.
    this.writes = result.then(() => {}, () => {});
    return result;
  }

  private available(): boolean {
    return this.encryption.isEncryptionAvailable()
      && (this.platform !== "linux"
        || ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"].includes(this.encryption.getSelectedStorageBackend()));
  }

  private file(value: unknown): string {
    if (!value || typeof value !== "object" || !("provider" in value) || typeof value.provider !== "string"
      || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,149}$/.test(value.provider)) throw new Error("Invalid API key provider.");
    const scope: CredentialScope = { provider: value.provider };
    if (scope.provider === CUSTOM_PROVIDER) {
      scope.baseUrl = validateCustomEndpoint({ baseUrl: "baseUrl" in value ? value.baseUrl : undefined, model: "credential" }).baseUrl;
    }
    return path.join(this.root, "credentials", `${createHash("sha256").update(JSON.stringify(scope)).digest("hex")}.bin`);
  }

  async load(scope: unknown): Promise<CredentialState> {
    const file = this.file(scope);
    await this.writes;
    const available = this.available();
    let encrypted: Buffer;
    try { encrypted = await readFile(file); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return { available, saved: false, apiKey: null };
      }
      throw new Error("Could not read the saved API key. Check ChatStudio's private data permissions.");
    }
    if (!available) return { available, saved: true, apiKey: null };
    try { return { available, saved: true, apiKey: this.encryption.decryptString(encrypted) }; }
    catch { throw new Error("Could not decrypt the saved API key. Unlock your OS credential store, or forget the saved key and enter it again."); }
  }

  async save(scope: unknown, apiKey: unknown): Promise<void> {
    const file = this.file(scope);
    if (typeof apiKey !== "string" || !apiKey.trim() || apiKey.length > 8192) throw new Error("Enter an API key before saving it.");
    if (!this.available()) throw new Error("Secure OS encryption is unavailable. API keys will not be saved.");
    let encrypted: Buffer;
    try { encrypted = this.encryption.encryptString(apiKey); }
    catch { throw new Error("Could not encrypt the API key. No key was saved."); }
    return this.update(async () => {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.${randomUUID()}.tmp`;
      const handle = await open(temp, "wx", 0o600);
      try {
        try { await handle.writeFile(encrypted); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temp, file);
      } finally { await rm(temp, { force: true }); }
    });
  }

  async forget(scope: unknown): Promise<void> {
    const file = this.file(scope);
    return this.update(() => rm(file, { force: true }));
  }
}
