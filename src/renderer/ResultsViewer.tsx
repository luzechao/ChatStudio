import { useMemo, useState } from "react";
import type { ResultCell, SimulationResults } from "../shared/inspection.js";

export function ResultsViewer({ results }: { results: SimulationResults }) {
  const tables = useMemo(() => [...new Set(results.cells.map((c) => JSON.stringify([c.report, c.scope, c.table])))], [results]);
  const [table, setTable] = useState(tables.find((key) => JSON.parse(key)[2] === "Site and Source Energy") ?? tables[0] ?? "");
  const [search, setSearch] = useState("");
  const all = results.cells.filter((cell) => JSON.stringify([cell.report, cell.scope, cell.table]) === table);
  const columns = [...new Set(all.map((c) => c.column))];
  const rows = [...new Set(all.map((c) => c.row))].filter((row) => row.toLowerCase().includes(search.toLowerCase()));
  const cells = new Map(all.map((cell) => [JSON.stringify([cell.row, cell.column]), cell]));
  const summary = results.cells.filter((c) => c.report === "AnnualBuildingUtilityPerformanceSummary" && c.scope === "Entire Facility");
  const metric = (table: string, row: string, column: string) => summary.find((c) => c.table === table && c.row === row && c.column === column);
  const metrics = [
    { label: "Total site energy", cell: metric("Site and Source Energy", "Total Site Energy", "Total Energy") },
    { label: "Site energy per floor area", cell: metric("Site and Source Energy", "Total Site Energy", "Energy Per Total Building Area") },
    { label: "Total building area", cell: metric("Building Area", "Total Building Area", "Area") },
  ];
  const endUses = summary.filter((c) => c.table === "End Uses");
  const fuels = [...new Set(endUses.map((c) => c.column))];
  const [fuel, setFuel] = useState(fuels[0] ?? "");
  const breakdown = endUses.filter((c) => c.column === fuel && c.row.trim() && c.row !== "Total End Uses");
  const max = Math.max(...breakdown.map((c) => Number(c.value.trim().replaceAll(",", ""))).filter(Number.isFinite), 0);
  const text = (cell?: ResultCell) => cell ? `${cell.value.trim() || "—"} ${cell.units}`.trim() : "Not reported";
  return <section aria-label="Results viewer">
    <h2>Simulation results</h2>
    <p>EnergyPlus SQL report values in their recorded units. Missing values are not treated as zero.</p>
    {results.environments.length > 0 && <p>Environments: {results.environments.map((env) => env.name).join(", ")}</p>}
    {!results.environments.some((env) => env.type === "3") && <p className="viewer-notice">No weather-run environment is recorded. These may be sizing/design-day results, not annual energy performance.</p>}
    {results.truncated && <p role="alert">This report exceeds 20,000 cells. Only the first 20,000 are displayed.</p>}
    <div className="result-metrics">{metrics.map(({ label, cell }) => <div key={label}><small>{label}</small><strong>{text(cell)}</strong></div>)}</div>
    {endUses.length > 0 && <>
      <h3>End-use breakdown</h3>
      <label>Fuel / resource<select aria-label="Fuel / resource" value={fuel} onChange={(e) => setFuel(e.target.value)}>{fuels.map((name) => <option key={name}>{name}</option>)}</select></label>
      <div className="end-use-chart" aria-label="End-use breakdown">{breakdown.map((cell) => {
        const value = Number(cell.value.trim().replaceAll(",", ""));
        return <div key={`${cell.row}:${cell.units}`}><span>{cell.row}</span><div className="bar-track"><div style={{ width: `${max > 0 && Number.isFinite(value) ? Math.max(0, value / max * 100) : 0}%` }} /></div><strong>{text(cell)}</strong></div>;
      })}</div>
    </>}
    <h3>Report tables</h3>
    {tables.length ? <>
      <label>Report table<select aria-label="Report table" value={table} onChange={(e) => setTable(e.target.value)}>{tables.map((key) => {
        const [report, scope, name] = JSON.parse(key); return <option key={key} value={key}>{report} / {scope} / {name}</option>;
      })}</select></label>
      <label>Filter rows<input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Zone, component, or end use" /></label>
      <div className="project-files"><table><thead><tr><th>Item</th>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
        <tbody>{rows.map((row) => <tr key={row}><th>{row}</th>{columns.map((column) => <td key={column}>{text(cells.get(JSON.stringify([row, column])))}</td>)}</tr>)}</tbody>
      </table></div>
    </> : <p>No tabular report values were found. Enable EnergyPlus summary reports and SQLite SimpleAndTabular, then run the simulation again.</p>}
  </section>;
}
