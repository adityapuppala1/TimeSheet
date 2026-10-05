/**
 * WHAT: the portfolio's projects as spheres in a slowly turning field — sized by open work,
 * coloured by each project's identity colour, named on hover, opened on click. An opt-in panel
 * on the Portfolio page (V12 7.6, the user's ask for one interactive three.js surface).
 *
 * WHY IT IS GATED, TWICE. three.js is ~600KB; the ship-feature rule is that it is a dynamic
 * import off every default path (the marketing pages chose `ogl` for that reason). So: the
 * component is only mounted behind a "Show 3D" toggle, and it imports three only once mounted —
 * the way `marketing/AuthScene.tsx` already does. Under `prefers-reduced-motion` the field does
 * not turn; hover and click still work. No WebGL, a failed chunk, or a lost context leaves the
 * table below exactly as it was — this panel adds a view, it never replaces one.
 *
 * WHY THE NUMBERS ARE THE TABLE'S: the spheres read `openCount` from the same rollup rows the
 * table renders, so the two can never disagree about a project.
 */
import { isSoftwareWebGl } from "../lib/webgl";
import { createRenderLoop, type RenderLoopHandle } from "../lib/render-loop";
import { useEffect, useRef, useState } from "react";
import { resolveIdentityColor } from "../lib/identity-colors";
import { currentTheme, subscribeTheme } from "../lib/theme";
import { useSyncExternalStore } from "react";

export interface SceneProject {
  id: string;
  code: string;
  name: string;
  color?: string | null;
  openCount: number;
  progressPct: number;
}

/** "204 80% 40%" → 0xRRGGBB, for three's Color. */
export function hslTripletToHex(triplet: string): number {
  const m = /^\s*(-?[\d.]+)\s+([\d.]+)%\s+([\d.]+)%/.exec(triplet);
  if (!m) return 0x888888;
  const h = ((Number(m[1]) % 360) + 360) % 360;
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m0 = l - c / 2;
  // The six hue sextants, as a table rather than a chain of reassignments.
  const sextants: Array<[number, number, number]> = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x]
  ];
  const [r, g, b] = sextants[Math.min(5, Math.floor(h / 60))];
  const to = (v: number) => Math.round((v + m0) * 255);
  return (to(r) << 16) | (to(g) << 8) | to(b);
}

/** Sphere radius from open work: a square root so a project with 100 open items is 10× a project
 *  with 1, not 100× — the eye reads area, and nothing should dwarf the field. Floor keeps an
 *  empty project visible. */
export function radiusFor(openCount: number): number {
  return 0.18 + Math.sqrt(Math.max(0, openCount)) * 0.06;
}

/** A pointer event's position as normalised device coordinates over `rect`. */
function toNdc(e: PointerEvent, rect: DOMRect): [number, number] {
  return [((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1];
}

/** Positions on a golden-angle spiral disc, so N projects spread evenly without clumping. */
export function spiralPosition(index: number, total: number): [number, number, number] {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const r = Math.sqrt((index + 0.5) / Math.max(1, total)) * 2.6;
  const theta = golden * index;
  return [Math.cos(theta) * r, Math.sin(theta) * r * 0.6, ((index % 5) - 2) * 0.25];
}

export function PortfolioScene({ projects, onOpen }: Readonly<{ projects: SceneProject[]; onOpen: (id: string) => void }>) {
  const hostRef = useRef<HTMLDivElement>(null);
  const theme = useSyncExternalStore(subscribeTheme, currentTheme, () => "light" as const);
  const [hover, setHover] = useState<SceneProject | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let teardown: (() => void) | undefined;
    let loop: RenderLoopHandle | undefined;

    // A CPU rasteriser (SwiftShader, llvmpipe, a VM, a remote desktop, CI) turns this scene into a
    // per-frame tax and gives nothing back — and this repo has already paid for that twice: the
    // marketing scenes starved the compositor badly enough to time Playwright out, and a software
    // WebGL request once threw through the router boundary so /login never rendered at all. Every
    // marketing scene has guarded this since; THIS one, the only 3D surface inside the app, never
    // did. The table beneath it says everything the spheres do.
    if (isSoftwareWebGl()) {
      setStatus("unavailable");
      return;
    }

    void (async () => {
      let THREE: typeof import("three");
      try {
        THREE = await import("three");
      } catch {
        setStatus("unavailable");
        return;
      }
      if (cancelled || !hostRef.current) return;
      const width = host.clientWidth || 1;
      const height = host.clientHeight || 1;
      let renderer: import("three").WebGLRenderer;
      try {
        renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
      } catch {
        setStatus("unavailable");
        return;
      }
      // 1.5: this is a slowly turning diagram, and a retina panel would otherwise have it filling
      // four times the pixels every frame.
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      renderer.setSize(width, height);
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      renderer.domElement.style.display = "block";
      host.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(40, width / height, 0.1, 100);
      // Back off on a narrow canvas (a phone) so the field's ±2.6 spread stays inside the frame.
      const fit = (aspect: number) => 7 * Math.max(1, 1.3 / Math.max(0.2, aspect));
      camera.position.set(0, 0.6, fit(width / height));
      camera.lookAt(0, 0, 0);
      scene.add(new THREE.AmbientLight(0xffffff, theme === "dark" ? 0.9 : 1.1));
      const key = new THREE.DirectionalLight(0xffffff, theme === "dark" ? 1.2 : 0.9);
      key.position.set(3, 4, 5);
      scene.add(key);

      const group = new THREE.Group();
      scene.add(group);
      const meshes: Array<{ mesh: import("three").Mesh; project: SceneProject }> = [];
      const geometry = new THREE.SphereGeometry(1, 28, 20);
      projects.forEach((project, i) => {
        const colour = resolveIdentityColor(project.id, project.color);
        const hex = hslTripletToHex(theme === "dark" ? colour.dark : colour.light);
        const material = new THREE.MeshStandardMaterial({ color: hex, roughness: 0.45, metalness: 0.05 });
        const mesh = new THREE.Mesh(geometry, material);
        const r = radiusFor(project.openCount);
        mesh.scale.setScalar(r);
        const [x, y, z] = spiralPosition(i, projects.length);
        mesh.position.set(x, y, z);
        group.add(mesh);
        meshes.push({ mesh, project });
      });

      const raycaster = new THREE.Raycaster();
      const pointer = new THREE.Vector2(-2, -2);
      let hovered: (typeof meshes)[number] | null = null;
      const meshList = meshes.map((m) => m.mesh);
      const byMesh = new Map(meshes.map((m) => [m.mesh, m]));
      const pick = () => {
        raycaster.setFromCamera(pointer, camera);
        const hit = raycaster.intersectObjects(meshList, false)[0];
        const next = hit ? (byMesh.get(hit.object as import("three").Mesh) ?? null) : null;
        if (next !== hovered) {
          if (hovered) (hovered.mesh.material as import("three").MeshStandardMaterial).emissive.setHex(0x000000);
          if (next) (next.mesh.material as import("three").MeshStandardMaterial).emissive.setHex(0x333333);
          hovered = next;
          setHover(next ? next.project : null);
          renderer.domElement.style.cursor = next ? "pointer" : "default";
        }
      };
      const onMove = (e: PointerEvent) => {
        const [nx, ny] = toNdc(e, renderer.domElement.getBoundingClientRect());
        pointer.set(nx, ny);
        pick();
      };
      const onLeave = () => {
        pointer.set(-2, -2);
        pick();
      };
      const onClick = () => {
        if (hovered) onOpenRef.current(hovered.project.id);
      };
      renderer.domElement.addEventListener("pointermove", onMove);
      renderer.domElement.addEventListener("pointerleave", onLeave);
      renderer.domElement.addEventListener("click", onClick);

      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      let last = performance.now();
      const renderOnce = () => renderer.render(scene, camera);
      // Under reduced motion one frame per interaction is enough; otherwise a slow turn through the
      // shared render loop, which pauses this scene off screen and in a background tab and holds it
      // to 30fps. It used to do none of those three — see lib/render-loop.ts for what that cost.
      if (reduced) {
        renderOnce();
        renderer.domElement.addEventListener("pointermove", renderOnce);
      } else {
        loop = createRenderLoop({
          host,
          fps: 30,
          render: () => {
            const now = performance.now();
            const dt = Math.min(0.05, (now - last) / 1000);
            last = now;
            group.rotation.y += dt * 0.12;
            renderer.render(scene, camera);
          }
        });
      }

      const onResize = () => {
        const w = host.clientWidth || 1;
        const h = host.clientHeight || 1;
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.position.z = fit(camera.aspect);
        camera.updateProjectionMatrix();
        renderer.render(scene, camera);
      };
      window.addEventListener("resize", onResize);
      setStatus("ready");

      teardown = () => {
        loop?.stop();
        window.removeEventListener("resize", onResize);
        renderer.domElement.removeEventListener("pointermove", onMove);
        renderer.domElement.removeEventListener("pointerleave", onLeave);
        renderer.domElement.removeEventListener("click", onClick);
        geometry.dispose();
        for (const { mesh } of meshes) (mesh.material as import("three").Material).dispose();
        renderer.dispose();
        renderer.domElement.remove();
      };
    })();

    return () => {
      cancelled = true;
      teardown?.();
    };
  }, [projects, theme]);

  return (
    <div className="relative" data-portfolio-scene data-scene-status={status}>
      <div ref={hostRef} className="h-[320px] w-full overflow-hidden rounded-lg border border-border bg-muted/20 sm:h-[420px]" aria-hidden="true" />
      {status === "loading" && <p className="absolute left-3 top-3 text-xs text-muted-foreground">Loading the 3D view…</p>}
      {status === "unavailable" && (
        <p className="absolute left-3 top-3 text-xs text-muted-foreground">3D is not available in this browser; the table below has everything.</p>
      )}
      {hover && (
        <div className="pointer-events-none absolute left-3 top-3 rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs shadow-xs" data-scene-hover>
          <span className="font-mono text-muted-foreground">{hover.code}</span> <span className="font-medium">{hover.name}</span>
          <span className="text-muted-foreground"> · {hover.openCount} open · {hover.progressPct}% done</span>
        </div>
      )}
      {/* The same information without a pointer or WebGL: one button per project. */}
      <ul className="sr-only" aria-label="Projects in the 3D view">
        {projects.map((p) => (
          <li key={p.id}>
            <button type="button" onClick={() => onOpen(p.id)}>{p.name}, {p.openCount} open</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
