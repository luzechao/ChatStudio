import { BufferGeometry, Float32BufferAttribute, ShapeUtils, Vector2, Vector3 } from "three";
import type { ModelSurface } from "../shared/inspection.js";

export function surfaceGeometry(surface: ModelSurface, openings: ModelSurface[]): BufferGeometry {
  const normal = new Vector3();
  for (let i = 0; i < surface.vertices.length; i++) {
    const a = surface.vertices[i], b = surface.vertices[(i + 1) % surface.vertices.length];
    normal.x += (a[1] - b[1]) * (a[2] + b[2]);
    normal.y += (a[2] - b[2]) * (a[0] + b[0]);
    normal.z += (a[0] - b[0]) * (a[1] + b[1]);
  }
  if (normal.lengthSq() < 1e-16) throw new Error(`Surface "${surface.name}" has a degenerate polygon.`);
  const axis = [Math.abs(normal.x), Math.abs(normal.y), Math.abs(normal.z)].indexOf(Math.max(Math.abs(normal.x), Math.abs(normal.y), Math.abs(normal.z)));
  const project = ([x, y, z]: [number, number, number]) => axis === 0 ? new Vector2(y, z) : axis === 1 ? new Vector2(x, z) : new Vector2(x, y);
  const rings = [surface.vertices, ...openings.map((item) => item.vertices)];
  const triangles = ShapeUtils.triangulateShape(rings[0].map(project), rings.slice(1).map((ring) => ring.map(project)));
  if (!triangles.length) throw new Error(`Surface "${surface.name}" could not be triangulated.`);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(rings.flat().flat(), 3));
  geometry.setIndex(triangles.flat());
  geometry.computeVertexNormals();
  return geometry;
}

export const SURFACE_COLORS: Record<string, number> = {
  Wall: 0xc3ac88, RoofCeiling: 0xb0634b, Floor: 0x7d8b98,
  FixedWindow: 0x58aaca, OperableWindow: 0x58aaca, Skylight: 0x58aaca,
  Door: 0x9b713f, GlassDoor: 0x58aaca,
};

export function groupColor(name: string): number {
  let hash = 0;
  for (const char of name) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return (Math.abs(hash) % 0x7f7f7f) + 0x606060;
}
