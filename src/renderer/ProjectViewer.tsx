import { lazy, Suspense, useState } from "react";
import type { ProjectState } from "../shared/contracts.js";
import { errorMessage } from "../shared/contracts.js";
import type { ModelGeometry, SimulationResults } from "../shared/inspection.js";
import { ResultsViewer } from "./ResultsViewer.js";
const ModelViewer = lazy(() => import("./ModelViewer.js").then((module) => ({ default: module.ModelViewer })));

type View = { kind: "model"; data: ModelGeometry } | { kind: "results"; data: SimulationResults } | { kind: "report"; html: string };
const reportPolicy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none';"><style>body{font-family:system-ui;padding:20px}table{border-collapse:collapse}td,th{padding:5px;border:1px solid #ccc}</style>`;

function reportDocument(html: string): string {
  const document = new DOMParser().parseFromString(html, "text/html");
  document.querySelectorAll("script,meta,base,iframe,frame,frameset,object,embed,form").forEach((element) => element.remove());
  for (const element of document.querySelectorAll("*")) for (const attribute of [...element.attributes]) {
    if (/^on/i.test(attribute.name) || ["href", "xlink:href", "src", "srcset", "srcdoc", "action", "formaction", "ping", "data"].includes(attribute.name.toLowerCase())) {
      element.removeAttribute(attribute.name);
    }
  }
  return `<!doctype html><html><head>${reportPolicy}${document.head.innerHTML}</head><body>${document.body.innerHTML}</body></html>`;
}

export function ProjectViewer({ project, initialMode, disabled, onBusy }: { project: ProjectState; initialMode: "model" | "results"; disabled: boolean; onBusy: (busy: boolean) => void }) {
  const [mode, setMode] = useState<"model" | "results" | "report">(initialMode);
  const [file, setFile] = useState("");
  const [manualFile, setManualFile] = useState("");
  const [view, setView] = useState<View | null>(null);
  const [loadedFile, setLoadedFile] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const files = project.files.filter((item) => mode === "model" ? /\.osm$/i.test(item.path) : mode === "results" ? /\.sql$/i.test(item.path) : /\.html?$/i.test(item.path));
  const chosen = manualFile.trim() || file || files[0]?.path || "";
  async function load() {
    setBusy(true); onBusy(true); setError(""); setView(null);
    try {
      if (mode === "model") setView({ kind: mode, data: await window.chatstudio.inspectModel(chosen) });
      else if (mode === "results") setView({ kind: mode, data: await window.chatstudio.inspectResults(chosen) });
      else setView({ kind: mode, html: reportDocument(await window.chatstudio.readReport(chosen)) });
      setLoadedFile(chosen);
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); onBusy(false); }
  }
  return <section className="project-viewer" aria-label="Model and results">
    <h2>{initialMode === "model" ? "3D model" : "Simulation outputs"}</h2>
    <div className="viewer-controls">
      {initialMode === "results" && <label>Viewer<select aria-label="Viewer" value={mode} disabled={busy || disabled} onChange={(e) => {
        const next = e.target.value;
        if (next === "model" || next === "results" || next === "report") { setMode(next); setFile(""); setManualFile(""); setError(""); setView(null); }
      }}><option value="results">Simulation results (SQL)</option><option value="report">HTML report</option></select></label>}
      <label>Project file<select aria-label="Project file" value={file || files[0]?.path || ""} disabled={busy || disabled} onChange={(e) => { setFile(e.target.value); setManualFile(""); }}>
        {!files.length && <option value="">No matching files listed</option>}
        {files.map((item) => <option key={item.path}>{item.path}</option>)}
      </select></label>
      <button className="primary" disabled={busy || disabled || !chosen} onClick={() => void load()}>{busy ? "Loading viewer..." : "Load viewer"}</button>
    </div>
    <details><summary>File not listed?</summary><label>Relative viewer file path<input value={manualFile} disabled={busy || disabled}
      onChange={(e) => setManualFile(e.target.value)} placeholder={mode === "model" ? "inputs/building.osm" : mode === "results" ? "runs/my-run/run/eplusout.sql" : "runs/my-run/reports/report.html"} /></label>
      <small>The file must be inside this project. Use this for files beyond the workspace listing limit.</small></details>
    {error && <div role="alert" className="error">{error}</div>}
    {view && <p className="viewer-source">Source: {loadedFile}. Reload to pick up saved changes.</p>}
    {view?.kind === "model" && <Suspense fallback={<p>Loading 3D renderer...</p>}><ModelViewer model={view.data} /></Suspense>}
    {view?.kind === "results" && <ResultsViewer results={view.data} />}
    {view?.kind === "report" && <section><h2>Report preview</h2><p>Read-only HTML. Scripts, remote resources, forms, and navigation are disabled; interactive reports may be incomplete.</p>
      <iframe title="Simulation report" sandbox="" referrerPolicy="no-referrer" srcDoc={view.html} className="report-frame" /></section>}
    {!view && !busy && <p>Choose a saved OSM, an EnergyPlus SQL output, or an HTML report. Viewing does not modify the agent’s loaded model and requires no API key.</p>}
  </section>;
}
