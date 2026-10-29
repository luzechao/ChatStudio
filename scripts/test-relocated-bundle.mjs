import { spawn } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("This gate targets the macOS ARM64 native bundle.");
const staging = await mkdtemp(path.join(tmpdir(), "chatstudio-relocated-"));
const app = path.join(staging, "Installed Apps", "ChatStudio Local.app");
const native = path.join(app, "Contents/Resources/native");
const run = (command, args, env = process.env) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: "inherit", env });
  child.on("error", reject);
  child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
});
let copied = false;
try {
  await cp(path.resolve("release-native/mac-arm64/ChatStudio.app"), app, { recursive: true, verbatimSymlinks: true });
  copied = true;
  await run("/bin/chmod", ["-R", "a-w", native]);
  const env = {
    ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    CHATSTUDIO_BUNDLE: native,
    CHATSTUDIO_EXPECT_BUNDLE: "1",
    CHATSTUDIO_EXECUTABLE: path.join(app, "Contents/MacOS/ChatStudio"),
  };
  await run(process.execPath, ["--test", "tests/package.integration.mjs"], env);
  await run(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), "--test", "tests/bundle.integration.ts"], env);
} finally {
  if (copied) await run("/bin/chmod", ["-R", "u+w", native]);
  await rm(staging, { recursive: true, force: true });
}
