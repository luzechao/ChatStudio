import { useEffect, useRef, useState } from "react";
import {
  AmbientLight, Box3, BufferGeometry, Color, DirectionalLight, DoubleSide, Float32BufferAttribute,
  GridHelper, LineBasicMaterial, LineSegments, Mesh, MeshStandardMaterial, PerspectiveCamera,
  Raycaster, Scene, Vector2, Vector3, WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { ModelGeometry, ModelSurface } from "../shared/inspection.js";
import { errorMessage } from "../shared/contracts.js";
import { groupColor, surfaceGeometry, SURFACE_COLORS } from "./model-scene.js";

export function ModelViewer({ model }: { model: ModelGeometry }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const fit = useRef<() => void>(() => {});
  const [selected, setSelected] = useState<ModelSurface | null>(null);
  const [space, setSpace] = useState("");
  const [colorBy, setColorBy] = useState("type");
  const [hideRoof, setHideRoof] = useState(false);
  const [error, setError] = useState("");
  const spaces = [...new Set(model.surfaces.map((s) => s.space))].sort();
  useEffect(() => {
    if (!canvas.current) return;
    const element = canvas.current;
    let renderer: WebGLRenderer;
    try { renderer = new WebGLRenderer({ canvas: element, antialias: true }); }
    catch (e) { setError(`3D rendering is unavailable: ${errorMessage(e)}`); return; }
    setError(""); setSelected(null);
    const scene = new Scene();
    scene.background = new Color("#e8eeed");
    scene.add(new AmbientLight(0xffffff, 1.8));
    const light = new DirectionalLight(0xffffff, 3); light.position.set(70, -100, 150); scene.add(light);
    const camera = new PerspectiveCamera(45, 1, 0.1, 100000);
    camera.up.set(0, 0, 1);
    const controls = new OrbitControls(camera, element);
    controls.enableDamping = true;
    const meshes: Mesh<BufferGeometry, MeshStandardMaterial>[] = [];
    const outlines: LineSegments<BufferGeometry, LineBasicMaterial>[] = [];
    const byId = new Map(model.surfaces.map((surface) => [surface.id, surface]));
    const openings = new Map<string, ModelSurface[]>();
    for (const surface of model.surfaces) if (surface.parent) {
      const children = openings.get(surface.parent) ?? []; children.push(surface); openings.set(surface.parent, children);
    }
    try {
      for (const surface of model.surfaces) {
        const base = surface.parent ? byId.get(surface.parent) : surface;
        if ((space && surface.space !== space) || (hideRoof && base?.type === "RoofCeiling")) continue;
        const geometry = surfaceGeometry(surface, openings.get(surface.id) ?? []);
        const glass = /window|skylight|glass/i.test(surface.type);
        const material = new MeshStandardMaterial({
          color: colorBy === "zone" ? groupColor(surface.zone || "(Unassigned)") : SURFACE_COLORS[surface.type] ?? 0xa0b0aa,
          side: DoubleSide, transparent: glass, opacity: glass ? 0.6 : 1, roughness: 0.8,
        });
        const mesh = new Mesh(geometry, material);
        mesh.userData.surface = surface; meshes.push(mesh); scene.add(mesh);
        const segments: number[] = [];
        for (let i = 0; i < surface.vertices.length; i++) segments.push(...surface.vertices[i], ...surface.vertices[(i + 1) % surface.vertices.length]);
        const outline = new LineSegments(
          new BufferGeometry().setAttribute("position", new Float32BufferAttribute(segments, 3)),
          new LineBasicMaterial({ color: 0x3e4b50 }),
        );
        outlines.push(outline); scene.add(outline);
      }
    } catch (e) { setError(errorMessage(e)); }
    const bounds = new Box3();
    for (const mesh of meshes) bounds.expandByObject(mesh);
    const center = bounds.isEmpty() ? new Vector3() : bounds.getCenter(new Vector3());
    const size = bounds.isEmpty() ? 10 : Math.max(bounds.getSize(new Vector3()).length(), 1);
    const grid = new GridHelper(size * 1.5, 20, 0x92a19b, 0xc4cfca);
    grid.rotation.x = Math.PI / 2; grid.position.set(center.x, center.y, bounds.isEmpty() ? -0.02 : bounds.min.z - 0.02); scene.add(grid);
    fit.current = () => {
      const distance = size / (2 * Math.tan(camera.fov * Math.PI / 360) * Math.min(camera.aspect, 1)) * 1.25;
      controls.target.copy(center);
      camera.position.copy(center).add(new Vector3(1, -1.3, 0.9).normalize().multiplyScalar(distance));
      camera.near = Math.max(size / 10000, 0.001); camera.far = Math.max(size * 100, distance * 10);
      camera.updateProjectionMatrix(); controls.update();
    };
    const resize = () => {
      const { width, height } = element.getBoundingClientRect();
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); renderer.setSize(width, height, false);
      camera.aspect = width / Math.max(height, 1); camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize); observer.observe(element);
    resize(); fit.current();
    const raycaster = new Raycaster();
    let start = new Vector2();
    const down = (event: PointerEvent) => { start = new Vector2(event.clientX, event.clientY); };
    const pick = (event: PointerEvent) => {
      if (start.distanceTo(new Vector2(event.clientX, event.clientY)) > 5) return;
      const rect = element.getBoundingClientRect();
      raycaster.setFromCamera(new Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), camera);
      const hit = raycaster.intersectObjects(meshes)[0]?.object;
      for (const mesh of meshes) mesh.material.emissive.setHex(mesh === hit ? 0x285e36 : 0);
      setSelected(hit ? hit.userData.surface : null);
    };
    element.addEventListener("pointerdown", down); element.addEventListener("pointerup", pick);
    const contextLost = (event: Event) => { event.preventDefault(); setError("The GPU context was lost. Reload the model to restore the 3D view."); };
    element.addEventListener("webglcontextlost", contextLost);
    let frame = 0;
    const render = () => { frame = requestAnimationFrame(render); controls.update(); renderer.render(scene, camera); };
    render();
    return () => {
      cancelAnimationFrame(frame); observer.disconnect(); controls.dispose();
      element.removeEventListener("pointerdown", down); element.removeEventListener("pointerup", pick);
      element.removeEventListener("webglcontextlost", contextLost);
      for (const object of [...meshes, ...outlines]) { object.geometry.dispose(); object.material.dispose(); }
      grid.geometry.dispose();
      for (const material of Array.isArray(grid.material) ? grid.material : [grid.material]) material.dispose();
      renderer.dispose(); fit.current = () => {};
    };
  }, [model, space, colorBy, hideRoof]);

  return <section aria-label="Model viewer" className="model-viewer">
    <h2>{model.name || "Building model"}</h2>
    <p>{model.spaces} spaces / {model.zones} zones / {model.surfaces.length} surfaces and openings. Saved OSM, read-only.</p>
    <div className="viewer-controls">
      <label>Show space<select aria-label="Show space" value={space} onChange={(e) => setSpace(e.target.value)}>
        <option value="">All spaces</option>{spaces.map((name) => <option key={name}>{name}</option>)}
      </select></label>
      <label>Color by<select aria-label="Color by" value={colorBy} onChange={(e) => setColorBy(e.target.value)}><option value="type">Surface type</option><option value="zone">Thermal zone</option></select></label>
      <label className="remember-key"><input type="checkbox" checked={hideRoof} onChange={(e) => setHideRoof(e.target.checked)} />Hide roofs</label>
      <button onClick={() => fit.current()}>Fit model</button>
    </div>
    {error && <p role="alert" className="error">{error}</p>}
    <canvas ref={canvas} className="model-canvas" aria-label="3D building model" />
    <small>Drag to orbit / scroll to zoom / right-drag to pan / click a surface to inspect. Coordinates in metres, Z-up.</small>
    <div className="surface-legend">{Object.entries(SURFACE_COLORS).slice(0, 6).map(([name, color]) => <span key={name}><i style={{ background: `#${color.toString(16).padStart(6, "0")}` }} />{name}</span>)}</div>
    {selected ? <dl aria-label="Selected surface" className="surface-details">
      {Object.entries({ Name: selected.name, Type: selected.type, Space: selected.space, Zone: selected.zone || "Unassigned",
        Boundary: selected.boundary, Construction: selected.construction || "Unassigned" }).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl> : <p>Select a surface to see its space, zone, boundary condition, and construction.</p>}
  </section>;
}
