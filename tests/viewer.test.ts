import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { projectFile } from "../src/main/inspection.js";
import { surfaceGeometry } from "../src/renderer/model-scene.js";
import { ResultsViewer } from "../src/renderer/ResultsViewer.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ModelSurface } from "../src/shared/inspection.js";
import { parseInspection } from "../src/shared/inspection.js";

test("viewer access rejects traversal, outside symlinks, unsupported files and directories", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "chatstudio-viewer-paths-"));
  const project = path.join(root, "project");
  try {
    await mkdir(project);
    await writeFile(path.join(project, "building.osm"), "");
    await writeFile(path.join(root, "outside.osm"), "");
    assert.ok((await projectFile(project, "building.osm", [".osm"])).endsWith("building.osm"));
    await assert.rejects(projectFile(project, "../outside.osm", [".osm"]), /inside/);
    await assert.rejects(projectFile(project, path.join(root, "outside.osm"), [".osm"]), /relative/);
    await assert.rejects(projectFile(project, "building.osm", [".sql"]), /Choose/);
    await mkdir(path.join(project, "directory.osm"));
    await assert.rejects(projectFile(project, "directory.osm", [".osm"]), /regular/);
    if (process.platform !== "win32") {
      await symlink(path.join(root, "outside.osm"), path.join(project, "escape.osm"));
      await assert.rejects(projectFile(project, "escape.osm", [".osm"]), /inside/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

function surface(vertices: ModelSurface["vertices"]): ModelSurface {
  return { id: "test", name: "test surface", type: "Wall", vertices, space: "Room", zone: "", boundary: "Outdoors", construction: "", parent: null };
}
function area(surface: ModelSurface, openings: ModelSurface[] = []): number {
  const geometry = surfaceGeometry(surface, openings);
  const position = geometry.getAttribute("position");
  const index = geometry.getIndex()!;
  let total = 0;
  for (let i = 0; i < index.count; i += 3) {
    const points = [0, 1, 2].map((j) => [position.getX(index.getX(i + j)), position.getY(index.getX(i + j)), position.getZ(index.getX(i + j))]);
    const a = points[1].map((v, j) => v - points[0][j]), b = points[2].map((v, j) => v - points[0][j]);
    total += Math.hypot(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]) / 2;
  }
  geometry.dispose(); return total;
}

test("surface triangulation handles concavity, world coordinates, vertical planes and window holes", () => {
  assert.equal(area(surface([[0, 0, 0], [3, 0, 0], [3, 1, 0], [1, 1, 0], [1, 3, 0], [0, 3, 0]])), 5);
  const wall = surface([[10, 4, 0], [14, 4, 0], [14, 4, 3], [10, 4, 3]]);
  const window = surface([[11, 4, 1], [12, 4, 1], [12, 4, 2], [11, 4, 2]]);
  assert.equal(area(wall, [window]), 11);
  assert.equal(area(surface([[0, 0, 0], [0, 4, 0], [0, 4, 3], [0, 0, 3]])), 12);
  assert.throws(() => area(surface([[0, 0, 0], [0, 0, 0], [0, 0, 0]])), /degenerate/);
});

test("native inspection data is validated before reaching the renderer", () => {
  assert.throws(() => parseInspection("model", { name: "broken", spaces: 1, zones: 1, surfaces: [surface([[NaN, 0, 0], [1, 0, 0], [0, 1, 0]])] }), /invalid/);
  assert.throws(() => parseInspection("results", { cells: [{}], environments: [], truncated: false }), /invalid/);
  assert.deepEqual(parseInspection("results", { cells: [], environments: [], truncated: false }), { cells: [], environments: [], truncated: false });
});

test("results rendering preserves reported units, distinguishes missing values and warns for design days", () => {
  const markup = renderToStaticMarkup(createElement(ResultsViewer, { results: {
    environments: [{ name: "Summer Design Day", type: "1" }], truncated: true,
    cells: [{ report: "AnnualBuildingUtilityPerformanceSummary", scope: "Entire Facility", table: "Site and Source Energy",
      row: "Total Site Energy", column: "Total Energy", units: "kBtu", value: " 12345.6" }],
  } }));
  assert.match(markup, /12345\.6 kBtu/);
  assert.match(markup, /Not reported/);
  assert.match(markup, /sizing\/design-day results, not annual/);
  assert.match(markup, /Only the first 20,000/);
  assert.ok(!markup.includes("12345.6 GJ"));
});
