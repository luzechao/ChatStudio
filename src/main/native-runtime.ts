import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../shared/contracts.js";
import { validateConfig } from "./config.js";

export async function bundledConfig(root: string, workspace: string): Promise<AppConfig> {
  const manifest: unknown = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  if (!manifest || typeof manifest !== "object" || !("schema" in manifest) || manifest.schema !== 1
    || !("platform" in manifest) || manifest.platform !== process.platform
    || !("arch" in manifest) || manifest.arch !== process.arch) {
    throw new Error("Native runtime manifest does not match this platform/architecture.");
  }
  const cli = path.join(root, "openstudio/bin/openstudio");
  const command = path.join(root, "bin/openstudio-mcp");
  for (const file of [cli, command, path.join(root, "python-runtime/bin/python3"),
    path.join(root, "openstudio/EnergyPlus/energyplus"), path.join(root, "Gemfile.lock")]) await access(file);
  await mkdir(workspace, { recursive: true });
  const gemHome = path.join(root, "gems/ruby/3.2.0");
  return validateConfig({
    workspace, bundledRuntime: true,
    backend: {
      command, args: [], readRoots: [root],
      environment: {
        OPENSTUDIO_CLI: cli,
        ENERGYPLUS_EXE_PATH: path.join(root, "openstudio/EnergyPlus/energyplus"),
        OSCLI_GEMFILE: path.join(root, "Gemfile"),
        OSCLI_GEM_PATH: path.join(root, "gems"),
        GEM_HOME: gemHome, GEM_PATH: gemHome,
        SKILLS_DIR: path.join(root, "skills"),
        COMMON_MEASURES_DIR: path.join(root, "measures/common"),
        COMSTOCK_MEASURES_DIR: path.join(root, "measures/comstock"),
        GBXML_MEASURES_DIR: path.join(root, "measures/gbxml"),
        GBXML_SEED_OSM: path.join(root, "seed_empty.osm"),
      },
    },
  });
}
