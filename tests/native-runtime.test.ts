import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { bundledConfig } from "../src/main/native-runtime.js";
import { validateConfig } from "../src/main/config.js";

test("bundled settings derive relocatable paths and reject mismatched/incomplete runtimes", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "chatstudio-runtime-"));
  const root = path.join(base, "Native Runtime With Spaces");
  try {
    await mkdir(root);
    await writeFile(path.join(root, "manifest.json"), JSON.stringify({ schema: 1, platform: "invalid", arch: process.arch }));
    await assert.rejects(bundledConfig(root, path.join(base, "project")), /manifest/);
    await writeFile(path.join(root, "manifest.json"), JSON.stringify({ schema: 1, platform: process.platform, arch: process.arch }));
    await assert.rejects(bundledConfig(root, path.join(base, "project")), { code: "ENOENT" });
    for (const file of ["openstudio/bin/openstudio", "bin/openstudio-mcp", "python-runtime/bin/python3",
      "openstudio/EnergyPlus/energyplus", "Gemfile.lock"]) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), "");
    }
    const config = await bundledConfig(root, path.join(base, "project"));
    assert.equal(config.bundledRuntime, true);
    assert.equal(config.backend.command, path.join(root, "bin/openstudio-mcp"));
    assert.deepEqual(config.backend.readRoots, [root]);
    assert.equal(config.backend.environment.GEM_HOME, path.join(root, "gems/ruby/3.2.0"));
    assert.equal(validateConfig(config).bundledRuntime, true);
    assert.throws(() => validateConfig({ ...config, bundledRuntime: "true" }), /Invalid bundled/);
  } finally { await rm(base, { recursive: true, force: true }); }
});
