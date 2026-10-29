export type InspectionKind = "model" | "results";
export type Point3 = [number, number, number];
export interface ModelSurface {
  id: string;
  name: string;
  type: string;
  boundary: string;
  space: string;
  zone: string;
  construction: string;
  vertices: Point3[];
  parent: string | null;
}
export interface ModelGeometry {
  name: string;
  spaces: number;
  zones: number;
  surfaces: ModelSurface[];
}
export interface ResultCell {
  report: string;
  scope: string;
  table: string;
  row: string;
  column: string;
  units: string;
  value: string;
}
export interface SimulationResults {
  environments: { name: string; type: string }[];
  cells: ResultCell[];
  truncated: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function surface(value: unknown): value is ModelSurface {
  return record(value) && ["id", "name", "type", "boundary", "space", "zone", "construction"].every((key) => typeof value[key] === "string")
    && (value.parent === null || typeof value.parent === "string")
    && Array.isArray(value.vertices) && value.vertices.length >= 3 && value.vertices.length <= 10000
    && value.vertices.every((point: unknown) => Array.isArray(point) && point.length === 3 && point.every((coordinate: unknown) => typeof coordinate === "number" && Number.isFinite(coordinate)));
}
function cell(value: unknown): value is ResultCell {
  return record(value) && ["report", "scope", "table", "row", "column", "units", "value"].every((key) => typeof value[key] === "string");
}
function environment(value: unknown): value is SimulationResults["environments"][number] {
  return record(value) && typeof value.name === "string" && typeof value.type === "string";
}
export function parseInspection(kind: InspectionKind, value: unknown): ModelGeometry | SimulationResults {
  if (record(value)) {
    if (kind === "model" && typeof value.name === "string" && typeof value.spaces === "number" && Number.isInteger(value.spaces) && value.spaces >= 0
      && typeof value.zones === "number" && Number.isInteger(value.zones) && value.zones >= 0
      && Array.isArray(value.surfaces) && value.surfaces.length > 0 && value.surfaces.length <= 50000 && value.surfaces.every(surface)) {
      return { name: value.name, spaces: value.spaces, zones: value.zones, surfaces: value.surfaces };
    }
    if (kind === "results" && typeof value.truncated === "boolean" && Array.isArray(value.cells) && value.cells.length <= 20000 && value.cells.every(cell)
      && Array.isArray(value.environments) && value.environments.every(environment)) {
      return { environments: value.environments, cells: value.cells, truncated: value.truncated };
    }
  }
  throw new Error("Native viewer returned invalid inspection data.");
}
