import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { AppConfig } from "../shared/contracts.js";
import type { InspectionKind, ModelGeometry, SimulationResults } from "../shared/inspection.js";
import { parseInspection } from "../shared/inspection.js";
import { prepareSandbox } from "./sandbox.js";

export async function projectFile(workspace: string, value: unknown, extensions: string[]): Promise<string> {
  if (typeof value !== "string" || !value || value.length > 8192 || path.isAbsolute(value)) throw new Error("Choose a relative project file.");
  const root = await realpath(workspace);
  const file = await realpath(path.resolve(root, value));
  const relative = path.relative(root, file);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Viewer files must stay inside the current project.");
  }
  if (!extensions.includes(path.extname(file).toLowerCase())) throw new Error(`Choose a ${extensions.join(" or ")} file.`);
  const info = await stat(file);
  if (!info.isFile() || info.size > 512 * 1024 * 1024) throw new Error("Viewer input must be a regular file no larger than 512 MB.");
  return file;
}

const modelScript = `
require "json"
translator = OpenStudio::OSVersion::VersionTranslator.new
loaded = translator.loadModel(OpenStudio::Path.new(source))
raise "OpenStudio could not load this OSM. Check its version and validity." if loaded.empty?
model = loaded.get
surfaces = []
model.getSpaces.each do |space|
  zone = space.thermalZone
  transform = space.siteTransformation
  space.surfaces.each do |surface|
    ([surface] + surface.subSurfaces.to_a).each do |item|
      raise "Model exceeds the viewer limit of 50000 surfaces." if surfaces.length >= 50000
      vertices = (transform * item.vertices).map { |v| [v.x, v.y, v.z] }
      raise "Invalid or oversized surface polygon." if vertices.length < 3 || vertices.length > 10000 || !vertices.flatten.all?(&:finite?)
      construction = item.construction
      surfaces << {
        id: item.handle.to_s, name: item.nameString,
        type: item == surface ? surface.surfaceType : item.subSurfaceType,
        boundary: surface.outsideBoundaryCondition, space: space.nameString,
        zone: zone.empty? ? "" : zone.get.nameString,
        construction: construction.empty? ? "" : construction.get.nameString,
        vertices: vertices, parent: item == surface ? nil : surface.handle.to_s
      }
    end
  end
end
raise "This model contains no space surfaces to display." if surfaces.empty?
result = {name: model.getBuilding.nameString, spaces: model.getSpaces.length, zones: model.getThermalZones.length, surfaces: surfaces}
`;

const resultsScript = `
require "json"
require "fileutils"
require "tmpdir"
Dir.mktmpdir("viewer-sql-", File.join(root, "tmp")) do |temp|
  copy = File.join(temp, "results.sql")
  FileUtils.cp(source, copy)
  sql = OpenStudio::SqlFile.new(OpenStudio::Path.new(copy))
  raise "Cannot open this EnergyPlus SQL database." unless sql.connectionOpen
  begin
    names = sql.execAndReturnVectorOfString("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
    raise "Missing EnergyPlus tabular results. Enable Output:SQLite with SimpleAndTabular." if names.empty? || !names.get.to_a.include?("TabularDataWithStrings")
    columns = ["ReportName", "ReportForString", "TableName", "RowName", "ColumnName", "Units", "Value"]
    values = columns.map do |column|
      data = sql.execAndReturnVectorOfString("SELECT COALESCE(CAST(" + column + " AS TEXT), '') FROM TabularDataWithStrings ORDER BY TabularDataIndex LIMIT 20001")
      data.empty? ? [] : data.get.to_a
    end
    rows = values.transpose
    cells = rows.first(20000).map { |row| Hash[["report", "scope", "table", "row", "column", "units", "value"].zip(row)] }
    envs = []
    if names.get.to_a.include?("EnvironmentPeriods")
      env_names = sql.execAndReturnVectorOfString("SELECT EnvironmentName FROM EnvironmentPeriods ORDER BY EnvironmentPeriodIndex")
      env_types = sql.execAndReturnVectorOfInt("SELECT EnvironmentType FROM EnvironmentPeriods ORDER BY EnvironmentPeriodIndex")
      if !env_names.empty? && !env_types.empty?
        envs = env_names.get.to_a.zip(env_types.get.to_a).map { |name, type| {name: name, type: type.to_s} }
      end
    end
    result = {environments: envs, cells: cells, truncated: rows.length > 20000}
  ensure
    sql.close
  end
end
`;

export async function inspectProject(config: AppConfig, privateRoot: string, kind: InspectionKind, relative: string, signal?: AbortSignal): Promise<ModelGeometry | SimulationResults> {
  const source = await projectFile(config.workspace, relative, [kind === "model" ? ".osm" : ".sql"]);
  const cli = config.backend.environment.OPENSTUDIO_CLI;
  if (!cli || !path.isAbsolute(cli)) throw new Error("Configure the included native runtime or an absolute OPENSTUDIO_CLI in Settings to use viewers.");
  const encode = (value: string) => `"${Buffer.from(value).toString("base64")}".unpack1("m0")`;
  const header = `source = ${encode(source)}; root = ${encode(await realpath(config.workspace))}\n`
    + `raise "Viewer file escaped the project." unless File.realpath(source).start_with?(root + File::SEPARATOR)\n`;
  const script = header + "result = nil\n" + (kind === "model" ? modelScript : resultsScript)
    + '\nputs; puts "CHATSTUDIO_INSPECTION=" + JSON.generate(result)\n';
  try {
    const { warnings: _warnings, ...launch } = await prepareSandbox({
      ...config, internetAccess: false, backend: { ...config.backend, command: cli, args: ["-e", script] },
    }, privateRoot);
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(launch.command, launch.args, { ...launch, signal });
      let stdout = ""; let stderr = ""; let size = 0;
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Native viewer extraction timed out.")); }, 90_000);
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        size += Buffer.byteLength(chunk);
        if (size > 24 * 1024 * 1024) { child.kill("SIGKILL"); reject(new Error("Viewer data exceeds the 24 MB limit. Choose a smaller model or report.")); }
        else stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0 && stdout.includes("CHATSTUDIO_INSPECTION=")) resolve(stdout);
        else if (code === 0) reject(new Error(`Native viewer returned no inspection data. ${stderr || stdout.slice(-4000)}`));
        else reject(new Error(`Native viewer extraction failed (${code}). ${stderr || stdout.slice(-4000)}`));
      });
    });
    const json = output.split("\n").reverse().find((line) => line.startsWith("CHATSTUDIO_INSPECTION="));
    if (!json) throw new Error("Native viewer returned no inspection data.");
    return parseInspection(kind, JSON.parse(json.slice("CHATSTUDIO_INSPECTION=".length)));
  } finally { await SandboxManager.reset(); }
}
