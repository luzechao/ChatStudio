import { spawn } from "node:child_process";
import { rename } from "node:fs/promises";
import path from "node:path";

if (!process.env.CHATSTUDIO_BUNDLE) throw new Error("Set CHATSTUDIO_BUNDLE to packaged native resources.");
const original = path.resolve(process.env.CHATSTUDIO_BUNDLE);
const relocated = `${original} With Spaces`;
await rename(original, relocated);
try {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), "--test", "tests/bundle.integration.ts"], {
      stdio: "inherit",
      env: { ...process.env, CHATSTUDIO_BUNDLE: relocated,
        CHATSTUDIO_SANDBOX_HELPERS: path.join(relocated, "sandbox") },
    });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`Relocated native runtime test exited ${code}`)));
  });
} finally {
  await rename(relocated, original);
}
