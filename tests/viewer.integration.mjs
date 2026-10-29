import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { _electron } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
test("project viewers render real OSM geometry, EnergyPlus results and isolated HTML reports", { timeout: 120_000 }, async () => {
  const osm = process.env.CHATSTUDIO_VIEWER_OSM, sql = process.env.CHATSTUDIO_VIEWER_SQL;
  assert.ok(osm && sql, "Set CHATSTUDIO_VIEWER_OSM and CHATSTUDIO_VIEWER_SQL to real model/result fixtures.");
  const base = await mkdtemp(path.join(tmpdir(), "chatstudio-viewer-ui-"));
  const workspace = path.join(base, "project");
  await mkdir(path.join(workspace, "inputs"), { recursive: true });
  await copyFile(osm, path.join(workspace, "inputs/building.osm")); await copyFile(sql, path.join(workspace, "inputs/eplusout.sql"));
  await copyFile(path.join(path.dirname(sql), "eplustbl.htm"), path.join(workspace, "inputs/energyplus.htm"));
  await writeFile(path.join(workspace, "inputs/report.html"), `<!doctype html><html><head>
    <meta http-equiv="refresh" content="0;url=https://example.com/escape"></head><body>
    <h1>Local simulation report</h1><table><tr><td>Annual energy</td><td>56074.74 GJ</td></tr></table>
    <script>parent.reportExecuted=true;document.body.innerHTML='UNSAFE'</script>
    <a href="https://example.com/escape">External link</a><img src="https://example.com/track">
    <iframe src="https://example.com/frame"></iframe></body></html>`);
  const electron = await _electron.launch(process.env.CHATSTUDIO_EXECUTABLE
    ? { executablePath: path.resolve(process.env.CHATSTUDIO_EXECUTABLE), args: [`--user-data-dir=${path.join(base, "private")}`] }
    : { args: [root, `--user-data-dir=${path.join(base, "private")}`], cwd: root });
  try {
    const page = await electron.firstWindow();
    const errors = [], remoteRequests = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (req) => { if (/^https?:/.test(req.url())) remoteRequests.push(req.url()); });
    await page.waitForFunction(() => document.querySelectorAll("select option").length > 20);
    await electron.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, workspace);
    await page.getByRole("button", { name: "Open project folder", exact: true }).click();
    await page.getByRole("navigation", { name: "Main views" }).getByRole("button", { name: "Model", exact: true }).click();
    await page.getByRole("region", { name: "Model and results", exact: true }).waitFor();
    const checkToolbarAlignment = async () => {
      for (const width of [1320, 980]) {
        await page.setViewportSize({ width, height: 900 });
        const button = await page.getByRole("button", { name: "Load viewer", exact: true }).boundingBox();
        const file = await page.getByLabel("Project file", { exact: true }).boundingBox();
        assert.ok(button && file);
        assert.ok(Math.abs(button.y - file.y) <= 1, `Load viewer and file control tops must align at ${width}px`);
        assert.ok(Math.abs(button.y + button.height - file.y - file.height) <= 1, `Load viewer and file control bottoms must align at ${width}px`);
        const viewer = page.getByLabel("Viewer", { exact: true });
        if (await viewer.count()) {
          const box = await viewer.boundingBox();
          assert.ok(box && Math.abs(box.y - button.y) <= 1, `Viewer type control must align at ${width}px`);
        }
      }
      await page.setViewportSize({ width: 1320, height: 900 });
    };
    await checkToolbarAlignment();
    if (!process.env.CHATSTUDIO_EXECUTABLE) {
      await page.evaluate(async (bundle) => {
        const config = await window.chatstudio.loadConfig();
        await window.chatstudio.saveConfig({ ...config, bundledRuntime: false, backend: {
          command: `${bundle}/bin/openstudio-mcp`, args: [], readRoots: [bundle], environment: { OPENSTUDIO_CLI: `${bundle}/openstudio/bin/openstudio` },
        } });
      }, path.join(root, ".runtime/bundle"));
    }
    await page.evaluate(async () => window.chatstudio.connect(await window.chatstudio.loadConfig()));
    await page.getByText("206 native tools discovered", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Load viewer", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".model-viewer") || document.querySelector('.project-viewer [role="alert"]'));
    assert.deepEqual(await page.locator('.project-viewer [role="alert"]').allTextContents(), []);
    await page.getByRole("region", { name: "Model viewer", exact: true }).waitFor();
    await page.getByText("19 spaces / 19 zones / 142 surfaces and openings.", { exact: false }).waitFor();
    const canvas = page.getByLabel("3D building model", { exact: true });
    await canvas.waitFor();
    await canvas.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    assert.equal(await page.getByRole("alert").count(), 0, await page.getByRole("alert").allTextContents());
    await mkdir(path.join(root, ".runtime"), { recursive: true });
    await canvas.screenshot({ path: path.join(root, ".runtime/viewer-model.png") });
    const box = await canvas.boundingBox();
    for (const [x, y] of [[0.5, 0.5], [0.45, 0.55], [0.55, 0.6]]) {
      await canvas.click({ position: { x: box.width * x, y: box.height * y } });
      if (await page.getByLabel("Selected surface", { exact: true }).count()) break;
    }
    assert.equal(await page.getByLabel("Selected surface", { exact: true }).count(), 1);
    await page.getByLabel("Color by", { exact: true }).selectOption("zone");
    await page.getByLabel("Hide roofs", { exact: true }).check();
    await page.getByLabel("Show space", { exact: true }).selectOption({ label: "Core_bottom" });
    await page.getByRole("button", { name: "Fit model", exact: true }).click();
    await page.getByRole("navigation", { name: "Main views" }).getByRole("button", { name: "Results", exact: true }).click();
    await checkToolbarAlignment();
    await page.getByRole("button", { name: "Load viewer", exact: true }).click();
    await page.getByRole("region", { name: "Results viewer", exact: true }).waitFor();
    await page.getByText("56074.74 GJ", { exact: true }).first().waitFor();
    assert.equal(await page.getByText("No weather-run environment", { exact: false }).count(), 0);
    await page.getByLabel("Fuel / resource", { exact: true }).selectOption("Electricity");
    assert.ok(await page.getByLabel("End-use breakdown", { exact: true }).locator(".bar-track").count() > 5);
    await page.getByLabel("Filter rows", { exact: true }).fill("Total Site");
    assert.equal(await page.locator(".project-viewer tbody tr").count(), 1);
    await page.getByRole("region", { name: "Results viewer", exact: true }).screenshot({ path: path.join(root, ".runtime/viewer-results.png") });
    await page.getByLabel("Viewer", { exact: true }).selectOption("report");
    await page.getByLabel("Project file", { exact: true }).selectOption("inputs/energyplus.htm");
    await page.getByRole("button", { name: "Load viewer", exact: true }).click();
    const report = page.frameLocator('iframe[title="Simulation report"]');
    await report.getByText("Site and Source Energy", { exact: true }).first().waitFor();
    assert.ok(await report.locator("table").count() > 5);
    await page.getByLabel("Project file", { exact: true }).selectOption("inputs/report.html");
    await page.getByRole("button", { name: "Load viewer", exact: true }).click();
    await report.getByRole("heading", { name: "Local simulation report", exact: true }).waitFor();
    assert.equal(await report.locator("script,iframe,meta[http-equiv=refresh],[href],[src]").count(), 0);
    assert.equal(await page.evaluate(() => window.reportExecuted), undefined);
    assert.deepEqual(remoteRequests, []);
    await assert.rejects(page.evaluate(() => window.chatstudio.readReport("../outside.html")));
    await assert.rejects(page.evaluate(() => window.chatstudio.inspectModel("../outside.osm")));
    await page.getByText("206 native tools discovered", { exact: true }).waitFor();
    assert.equal(await page.getByRole("dialog", { name: "Approve tool execution" }).count(), 0);
    assert.deepEqual(errors, []);
  } finally { await electron.close(); await rm(base, { recursive: true, force: true }); }
});
