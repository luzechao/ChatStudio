import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { bundledConfig } from "../src/main/native-runtime.js";
import { inspectProject } from "../src/main/inspection.js";
import type { ModelGeometry, SimulationResults } from "../src/shared/inspection.js";

test("native viewers extract real OSM geometry and annual EnergyPlus results without changing sources", { timeout: 180_000 }, async () => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "chatstudio-viewer-native-")));
  const workspace = path.join(base, "project with spaces");
  const privateRoot = path.join(base, "private");
  try {
    const osm = process.env.CHATSTUDIO_VIEWER_OSM;
    const sql = process.env.CHATSTUDIO_VIEWER_SQL;
    assert.ok(osm && sql, "Set CHATSTUDIO_VIEWER_OSM and CHATSTUDIO_VIEWER_SQL to real model/simulation fixtures.");
    await mkdir(privateRoot); await mkdir(path.join(workspace, "inputs"), { recursive: true });
    await copyFile(osm, path.join(workspace, "inputs/building.osm")); await copyFile(sql, path.join(workspace, "inputs/eplusout.sql"));
    const config = await bundledConfig(path.resolve(".runtime/bundle"), workspace);
    const hash = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex");
    const before = await Promise.all(["building.osm", "eplusout.sql"].map((file) => hash(path.join(workspace, "inputs", file))));
    const model = await inspectProject(config, privateRoot, "model", "inputs/building.osm") as ModelGeometry;
    assert.equal(model.spaces, 19);
    assert.equal(model.zones, 19);
    assert.ok(model.surfaces.length > 100);
    assert.ok(model.surfaces.some((surface) => surface.parent && surface.vertices.length >= 3));
    assert.ok(model.surfaces.every((surface) => surface.vertices.flat().every(Number.isFinite)));
    const results = await inspectProject(config, privateRoot, "results", "inputs/eplusout.sql") as SimulationResults;
    assert.ok(results.cells.length > 100);
    assert.ok(results.environments.some((env) => env.type === "3"), JSON.stringify(results.environments));
    const energy = results.cells.find((cell) => cell.table === "Site and Source Energy" && cell.row === "Total Site Energy" && cell.column === "Total Energy");
    assert.ok(energy && Number(energy.value) > 0, JSON.stringify(energy));
    console.log("VIEWER_NATIVE", JSON.stringify({ surfaces: model.surfaces.length, cells: results.cells.length, energy, environments: results.environments }));
    assert.deepEqual(await Promise.all(["building.osm", "eplusout.sql"].map((file) => hash(path.join(workspace, "inputs", file)))), before);
  } finally { await rm(base, { recursive: true, force: true }); }
});
