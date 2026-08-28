/**
 * WHAT: the three.js half of the sign-in screen — a slowly turning lattice of work items, wired to
 * their neighbours, leaning toward the pointer.
 *
 * THREE.JS, DELIBERATELY, AND HOW ITS COST IS PAID FOR.
 * This file's predecessor was a 2D canvas, and its header argued at length that three.js is ~600KB
 * for what is decoratively a moving gradient behind some dots. That argument was about the DEFAULT
 * path, and it still holds — so the library is not on the default path any more:
 *
 *   - It is a DYNAMIC import inside an effect, so three.js lands in its own chunk that Vite never
 *     bundles into the login route. The form paints from the ordinary bundle and is typeable before
 *     any of this exists.
 *   - The import only runs once BOTH media queries pass: a desktop-width viewport (below `lg` this
 *     panel is `hidden`) and no `prefers-reduced-motion`. A phone and a reduced-motion visitor
 *     therefore never download it at all — not a smaller version, none of it.
 *   - Both queries are WATCHED rather than sampled once, because a laptop meeting an external
 *     monitor crosses the width breakpoint without remounting. That exact bug shipped in the 2D
 *     version, which ran a full loop against a 0×0 canvas on every phone while three comments
 *     claimed it cost a phone nothing. The `hidden lg:block` class is CSS; React mounts regardless.
 *
 * WHAT IT DEPICTS, because a login backdrop that means nothing is just a screensaver. Points on a
 * sphere are work items; the short lines are the links between ones that sit close together; three
 * inclined rings sweep through them. It is the same metaphor the 2D constellation carried — items
 * connecting into a system — with the depth, parallax and lighting that were the reason to reach
 * for a 3D library at all.
 *
 * COLOURS COME FROM `--primary` / `--info`, read at mount, so this follows the workspace's own
 * theme rather than freezing a brand into a shader.
 *
 * TEARDOWN IS NOT OPTIONAL. Every geometry, material and the renderer itself are disposed, the
 * canvas removed, and the WebGL context explicitly released — browsers cap live contexts, and
 * `/login` is a route people re-enter.
 */
import { useEffect, useRef, useState } from "react";

/** Points on the sphere. Modest on purpose: this runs behind a form, not as a demo reel. */
const NODE_COUNT = 150;
/** Two nodes closer than this get a line. Tuned against NODE_COUNT — raising one without the other
 *  either produces a hairball or nothing at all. */
const LINK_DISTANCE = 0.62;

/** Reads a `--token` HSL triple into a hex number three.js accepts. The tokens are stored as bare
 *  `H S% L%`, which nothing parses directly, so the browser does the conversion via a probe. */
function tokenHex(name: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!raw) return fallback;
  const probe = document.createElement("span");
  probe.style.color = `hsl(${raw})`;
  probe.style.display = "none";
  document.body.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(computed);
  if (!match) return fallback;
  return (Number(match[1]) << 16) | (Number(match[2]) << 8) | Number(match[3]);
}

/** Watches a media query rather than sampling it, so a resize or an OS setting change is picked up
 *  without a remount. See the header for the bug this exists to prevent. */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : false
  );
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/**
 * Which theme token the lattice is lit with. The workspace sign-in uses the product's own
 * `--primary`; the platform-admin console uses `--accent` — the amber that says "control plane"
 * everywhere else in that console — against the same `--info` so the depth cue survives.
 *
 * A prop rather than a second copy of this file: the geometry, the teardown and the media-query
 * gating are the hard parts and they are identical. Only one colour differs.
 */
export type AuthSceneTone = "primary" | "accent";

export function AuthScene({ className, tone = "primary" }: { className?: string; tone?: AuthSceneTone }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const shouldRun = isDesktop && !prefersReducedMotion;

  useEffect(() => {
    if (!shouldRun) return;
    const host = hostRef.current;
    if (!host) return;

    // `cancelled` guards the async gap: the import below takes a moment, and a visitor who signs in
    // or resizes during it would otherwise get a scene attached to a unmounted node.
    let cancelled = false;
    let teardown: (() => void) | undefined;

    void (async () => {
      let THREE: typeof import("three");
      try {
        THREE = await import("three");
      } catch {
        // No network for the chunk, or WebGL unavailable further down. The panel keeps its CSS
        // gradient and the form — the only thing that matters here — is untouched.
        return;
      }
      if (cancelled || !hostRef.current) return;

      const width = host.clientWidth || 1;
      const height = host.clientHeight || 1;

      let renderer: import("three").WebGLRenderer;
      try {
        renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
      } catch {
        return;
      }
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(width, height);
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      renderer.domElement.style.display = "block";
      host.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
      camera.position.set(0, 0, 5.4);

      const primary = tone === "accent" ? tokenHex("--accent", 0xf59e0b) : tokenHex("--primary", 0x0f9aa8);
      const info = tokenHex("--info", 0x2563eb);

      /* ---- The work items ------------------------------------------------------------------ */
      // A FIBONACCI SPHERE, not random points. Random placement on a sphere clumps visibly at the
      // poles and leaves bald patches, which reads as a bug rather than as a design.
      const positions: import("three").Vector3[] = [];
      const golden = Math.PI * (3 - Math.sqrt(5));
      for (let i = 0; i < NODE_COUNT; i++) {
        const y = 1 - (i / (NODE_COUNT - 1)) * 2;
        const radius = Math.sqrt(Math.max(0, 1 - y * y));
        const theta = golden * i;
        positions.push(new THREE.Vector3(Math.cos(theta) * radius, y, Math.sin(theta) * radius).multiplyScalar(1.7));
      }

      const nodeGeometry = new THREE.SphereGeometry(0.022, 10, 10);
      const nodeMaterial = new THREE.MeshBasicMaterial({ color: primary, transparent: true, opacity: 0.85 });
      const nodes = new THREE.InstancedMesh(nodeGeometry, nodeMaterial, NODE_COUNT);
      const dummy = new THREE.Object3D();
      const nodeColour = new THREE.Color();
      const from = new THREE.Color(primary);
      const to = new THREE.Color(info);
      positions.forEach((position, i) => {
        dummy.position.copy(position);
        // Slightly varied scale so the sphere reads as depth rather than as a decal.
        dummy.scale.setScalar(0.7 + ((i * 37) % 10) / 14);
        dummy.updateMatrix();
        nodes.setMatrixAt(i, dummy.matrix);
        // Graded along the axis so the two brand stops are both present without a gradient shader.
        nodeColour.copy(from).lerp(to, (position.y + 1.7) / 3.4);
        nodes.setColorAt(i, nodeColour);
      });
      nodes.instanceMatrix.needsUpdate = true;
      if (nodes.instanceColor) nodes.instanceColor.needsUpdate = true;
      scene.add(nodes);

      /* ---- The links ----------------------------------------------------------------------- */
      // Built ONCE, not per frame. The pair test is O(n²) — 11,175 comparisons at this node count —
      // which is nothing as a setup cost and is exactly the sort of thing that quietly eats a
      // laptop's battery when it is done sixty times a second instead.
      const linkPoints: number[] = [];
      for (let i = 0; i < positions.length; i++) {
        for (let j = i + 1; j < positions.length; j++) {
          if (positions[i].distanceTo(positions[j]) < LINK_DISTANCE) {
            linkPoints.push(positions[i].x, positions[i].y, positions[i].z, positions[j].x, positions[j].y, positions[j].z);
          }
        }
      }
      const linkGeometry = new THREE.BufferGeometry();
      linkGeometry.setAttribute("position", new THREE.Float32BufferAttribute(linkPoints, 3));
      const linkMaterial = new THREE.LineBasicMaterial({ color: info, transparent: true, opacity: 0.22 });
      const links = new THREE.LineSegments(linkGeometry, linkMaterial);
      scene.add(links);

      /* ---- Three inclined rings ------------------------------------------------------------ */
      const ringGeometry = new THREE.TorusGeometry(2.05, 0.004, 6, 160);
      const ringMaterial = new THREE.MeshBasicMaterial({ color: primary, transparent: true, opacity: 0.3 });
      const rings = [0.3, 1.15, 2.1].map((tilt, i) => {
        const ring = new THREE.Mesh(ringGeometry, ringMaterial);
        ring.rotation.x = tilt;
        ring.rotation.y = i * 0.7;
        scene.add(ring);
        return ring;
      });

      const group = new THREE.Group();
      group.add(nodes, links, ...rings);
      scene.add(group);

      /* ---- Motion --------------------------------------------------------------------------- */
      // Eased toward the pointer rather than following it. A backdrop that snaps to the cursor is a
      // toy; one that drifts after it is atmosphere.
      const target = { x: 0, y: 0 };
      const current = { x: 0, y: 0 };
      const onPointerMove = (event: PointerEvent) => {
        const rect = host.getBoundingClientRect();
        target.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        target.y = ((event.clientY - rect.top) / rect.height) * 2 - 1;
      };
      window.addEventListener("pointermove", onPointerMove, { passive: true });

      const resize = () => {
        const w = host.clientWidth || 1;
        const h = host.clientHeight || 1;
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      };
      const resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(host);

      // A GPU loop behind a tab nobody is looking at is a battery cost with no viewer.
      let visible = true;
      const visibility = new IntersectionObserver(([entry]) => {
        visible = entry.isIntersecting;
      });
      visibility.observe(host);

      let frame = 0;
      const start = performance.now();
      const loop = () => {
        frame = requestAnimationFrame(loop);
        if (!visible || document.hidden) return;
        const t = (performance.now() - start) / 1000;

        current.x += (target.x - current.x) * 0.03;
        current.y += (target.y - current.y) * 0.03;

        group.rotation.y = t * 0.09 + current.x * 0.35;
        group.rotation.x = Math.sin(t * 0.06) * 0.12 + current.y * 0.22;
        rings.forEach((ring, i) => {
          ring.rotation.z = t * (0.05 + i * 0.02);
        });

        renderer.render(scene, camera);
      };
      frame = requestAnimationFrame(loop);

      teardown = () => {
        cancelAnimationFrame(frame);
        window.removeEventListener("pointermove", onPointerMove);
        resizeObserver.disconnect();
        visibility.disconnect();
        nodeGeometry.dispose();
        nodeMaterial.dispose();
        linkGeometry.dispose();
        linkMaterial.dispose();
        ringGeometry.dispose();
        ringMaterial.dispose();
        renderer.domElement.remove();
        renderer.dispose();
        // Explicit, because `dispose()` frees three.js's own resources but browsers cap how many
        // live WebGL contexts a page may hold, and `/login` is a route people re-enter.
        renderer.forceContextLoss();
      };
    })();

    return () => {
      cancelled = true;
      teardown?.();
    };
  }, [shouldRun, tone]);

  // `aria-hidden` and empty: it is decoration, and the panel beside it carries the words.
  return <div ref={hostRef} className={className} aria-hidden />;
}
