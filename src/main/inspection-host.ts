import { inspectProject } from "./inspection.js";
import type { AppConfig } from "../shared/contracts.js";
import type { InspectionKind } from "../shared/inspection.js";

if (!process.parentPort) throw new Error("Viewer host requires an Electron utility process.");
const port = process.parentPort;
let running = false;
const controller = new AbortController();
port.on("message", async ({ data }: { data: { type: "cancel" } | { config: AppConfig; privateRoot: string; kind: InspectionKind; file: string } }) => {
  if ("type" in data) { controller.abort(); return; }
  if (running) { port.postMessage({ error: "Viewer is busy." }); return; }
  running = true;
  try { port.postMessage({ value: await inspectProject(data.config, data.privateRoot, data.kind, data.file, controller.signal) }); }
  catch (error) { port.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
});
