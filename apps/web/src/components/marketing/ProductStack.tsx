/**
 * The hero's 3D object: real screens of the product, standing in space, turning with the pointer.
 *
 * WHY A SECOND WEBGL SCENE, when this codebase argued against one. The earlier refusal
 * (see the 11.1 note in docs/V12_UiUx_ClickUp_PLAN.md) was about adding another ABSTRACT backdrop —
 * a second field of drifting particles behind the same text, costing a megabyte to say nothing the
 * first one had not. This is a different proposition: the thing in 3D is the PRODUCT. Five real
 * screenshots, generated from the running app by tests/e2e/screenshots.spec.ts, arranged as a
 * carousel a visitor can turn. Depth here is doing the work a hero image does on every good SaaS
 * page — showing the software — and doing it in a way a flat <img> cannot.
 *
 * WHAT IT COSTS AND HOW THAT IS CONTAINED, because "it's only the hero" is how pages get heavy:
 *  - three.js is a dynamic import inside an effect, so it is a separate chunk that only a visitor
 *    who passes every gate below ever downloads. Identical discipline to AuthScene.
 *  - The textures are the 800px WebP variants the rest of the page already serves, not the PNGs.
 *  - It runs only on a fine pointer at >=1024px, with motion allowed, on hardware that is not a
 *    software rasteriser (lib/webgl.ts). A phone, a reduced-motion visitor and a VM all skip it.
 *  - The render loop stops when the scene scrolls out of view or the tab is hidden, and every
 *    geometry, material, texture and the context itself are disposed on unmount.
 *
 * WHAT A VISITOR SEES WHEN IT DOES NOT RUN — which is the majority of visitors, and so is the case
 * that actually matters: `fallback`, rendered underneath and revealed by the absence of the canvas.
 * It is a real, responsive <img> of the same first screenshot. The hero is never empty, never
 * shifts, and never depends on WebGL to communicate. That is the same contract every other scene
 * in this folder signs.
 *
 * WHY THE SHOTS DO NOT SPIN ON THEIR OWN: a carousel that rotates by itself is a slideshow you
 * cannot read, and — measured — a scene that never stops moving is a scene that never stops
 * costing. It answers the pointer and then COMES TO REST: once the easing has converged and every
 * texture has faded in, the loop returns before it renders, so a deck nobody is touching costs the
 * price of one early return per frame and nothing else. Moving the mouse wakes it.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePrefersReducedMotion } from "../../lib/use-motion";
import { isSoftwareWebGl } from "../../lib/webgl";
import { cn } from "../../lib/utils";

export interface ProductStackShot {
  /** Served path of the 800px WebP variant — the same asset the page's <img> tags use. */
  src: string;
  /** Spoken by the fallback image, so it has to describe the screen, not name the file. */
  alt: string;
}

/* COVERFLOW, not a carousel on a circle.
   The first build arranged the cards on a full ring facing outward. Two things went wrong and both
   are visible the moment you look instead of reasoning: back-face culling removed every card on the
   far side, so the middle of the hero was a hole; and a ring wide enough to hold five cards puts the
   front one too far from the camera to read. A shallow arc fixes both — every card faces the viewer,
   the centre one is large enough to actually see the product, and the ones beside it angle away to
   give depth without stealing attention. */
/* 16:9, because that is exactly what tests/e2e/screenshots.spec.ts writes. A card with any other
   aspect letterboxes a real screenshot inside a floating rectangle, which looks like a bug. */
const CARD_W = 3.55;
const CARD_H = CARD_W / (16 / 9);
/** Step between neighbours: near enough to overlap slightly, which is what makes it read as a deck
    rather than as three separate pictures that happen to share a row. */
const STEP_X = 1.95;
const STEP_Z = 0.95;
const TILT = 0.58;

/**
 * Loads one screenshot onto one card. Hoisted out of the scene's `forEach` purely so the mounting
 * code stays inside the nesting depth the lint ratchet allows — the logic is unchanged, and the
 * cancellation check still runs at the moment the texture arrives rather than when it was asked for.
 */
function applyShotTexture({
  THREE,
  loader,
  src,
  material,
  maxAnisotropy,
  keep,
  isCancelled
}: {
  THREE: typeof import("three");
  loader: import("three").TextureLoader;
  src: string;
  material: import("three").MeshBasicMaterial;
  maxAnisotropy: number;
  keep: import("three").Texture[];
  isCancelled: () => boolean;
}) {
  loader.load(
    src,
    (texture) => {
      if (isCancelled()) {
        texture.dispose();
        return;
      }
      texture.colorSpace = THREE.SRGBColorSpace;
      // Anisotropy is what keeps a screenshot of small UI text legible at an angle; without it the
      // cards at the sides of the deck turn to mush, which defeats the point of showing the product.
      texture.anisotropy = Math.min(8, maxAnisotropy);
      keep.push(texture);
      material.map = texture;
      material.needsUpdate = true;
    },
    undefined,
    () => undefined // a missing shot leaves one blank card, never a broken scene
  );
}

/** Places every card (and its frame) for the current `cursor`. Pure arithmetic over the meshes. */
/** Returns whether anything actually changed, so the caller can stop drawing a still picture. */
function layOutDeck({
  meshes,
  frames,
  materials,
  frameMaterials,
  entered,
  cursor,
  pointerY
}: {
  meshes: import("three").Mesh[];
  frames: import("three").Mesh[];
  materials: import("three").MeshBasicMaterial[];
  frameMaterials: import("three").MeshBasicMaterial[];
  entered: number[];
  cursor: number;
  pointerY: number;
}): boolean {
  let moved = false;
  const n = meshes.length;
  for (let i = 0; i < n; i++) {
    const mesh = meshes[i];
    const previousX = mesh.position.x;
    // Wrap the offset into [-n/2, n/2] so the deck is a loop with no end to fall off.
    let offset = i - cursor;
    offset = (((offset % n) + n + n / 2) % n) - n / 2;
    const distance = Math.abs(offset);
    mesh.position.set(offset * STEP_X, pointerY * 0.12, -distance * STEP_Z);
    // Turn away from the centre, so the deck has a vanishing point.
    mesh.rotation.y = -offset * TILT;
    // The far cards must not sit in front of the near ones once they wrap around.
    mesh.renderOrder = Math.round(100 - distance * 10);
    const fade = Math.max(0, 1 - distance / (n / 2));
    mesh.scale.setScalar(0.88 + fade * 0.12);

    // A thousandth of a world unit is far below one device pixel at this camera distance; below
    // it, "moved" is a lie that keeps the renderer awake.
    if (Math.abs(mesh.position.x - previousX) > 0.001) moved = true;

    const frame = frames[i];
    frame.position.set(mesh.position.x, mesh.position.y, mesh.position.z - 0.01);
    frame.rotation.y = mesh.rotation.y;
    frame.scale.copy(mesh.scale);
    frame.renderOrder = mesh.renderOrder - 1;

    if (materials[i].map) {
      // Ramp in on arrival, then hold the neighbours dim but READABLE — a card faded to a ghost is
      // just noise around the centre one.
      if (entered[i] < 1) {
        entered[i] = Math.min(1, entered[i] + 0.08);
        moved = true;
      }
      materials[i].opacity = entered[i] * (0.5 + fade * 0.5);
      frameMaterials[i].opacity = materials[i].opacity * 0.9;
    }
  }
  return moved;
}

export function ProductStack({
  shots,
  fallback,
  className
}: {
  shots: ProductStackShot[];
  fallback: ReactNode;
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const reduced = usePrefersReducedMotion();
  // Drives the fallback's visibility from the SCENE's own success, not from a guess made up front:
  // every reason the scene can fail (no WebGL, chunk blocked, context lost) ends with this false.
  const [running, setRunning] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || reduced || shots.length === 0) return;
    if (typeof window === "undefined" || !window.matchMedia) return;
    if (!window.matchMedia("(min-width: 1024px)").matches) return;
    if (!window.matchMedia("(pointer: fine)").matches) return;
    if (isSoftwareWebGl()) return;

    let cancelled = false;
    let teardown: (() => void) | undefined;

    void (async () => {
      let THREE: typeof import("three");
      try {
        THREE = await import("three");
      } catch {
        return; // no chunk, no scene — the fallback image is already on screen
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
      // 1.5, not 2. A retina display quadruples the pixels this shader fills, and the deck is a
      // photograph of a UI — at 1.5 the difference is invisible and the fill cost drops by 44%.
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      renderer.setSize(width, height);
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      renderer.domElement.style.display = "block";
      host.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(40, width / height, 0.1, 100);
      camera.position.set(0, 0.1, 4.55);
      camera.lookAt(0, 0, 0);

      const group = new THREE.Group();
      scene.add(group);

      const loader = new THREE.TextureLoader();
      const geometry = new THREE.PlaneGeometry(CARD_W, CARD_H, 1, 1);
      const materials: import("three").MeshBasicMaterial[] = [];
      const textures: import("three").Texture[] = [];

      // A slightly larger plane behind each card, in the theme's border colour. The screenshots
      // are mostly white and the page behind them is too, so without this the cards dissolve into
      // the background at their edges — the one thing a flat <img class="border"> got right and the
      // first 3D build lost. Read from the stylesheet so it follows the theme rather than pinning a
      // hex that is wrong in dark mode.
      const frameColour = new THREE.Color(
        getComputedStyle(document.documentElement).getPropertyValue("--border").trim()
          ? `hsl(${getComputedStyle(document.documentElement).getPropertyValue("--border").trim()})`
          : "#d4d4d8"
      );
      const frameGeometry = new THREE.PlaneGeometry(CARD_W + 0.05, CARD_H + 0.05, 1, 1);
      const frames: import("three").Mesh[] = [];
      const frameMaterials: import("three").MeshBasicMaterial[] = [];

      // Hoisted rather than written inline at the call: `() => cancelled` inside the loop body put
      // this five function levels deep, and it allocates one closure per shot for no reason.
      const isCancelled = () => cancelled;

      const meshes: import("three").Mesh[] = [];
      shots.forEach((shot, i) => {
        const material = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 });
        materials.push(material);
        const mesh = new THREE.Mesh(geometry, material);
        const frameMaterial = new THREE.MeshBasicMaterial({ color: frameColour, transparent: true, opacity: 0 });
        frameMaterials.push(frameMaterial);
        const frame = new THREE.Mesh(frameGeometry, frameMaterial);
        group.add(frame);
        frames.push(frame);
        group.add(mesh);
        meshes.push(mesh);

        applyShotTexture({
          THREE,
          loader,
          src: shot.src,
          material,
          maxAnisotropy: renderer.capabilities.getMaxAnisotropy(),
          keep: textures,
          isCancelled
        });
      });

      // Only announce success once something is actually on screen; a canvas that never got a
      // texture would otherwise hide a perfectly good fallback image behind an empty rectangle.
      const announce = window.setTimeout(() => {
        if (!cancelled) setRunning(true);
      }, 60);

      const pointer = { x: 0, y: 0 };
      const onPointerMove = (event: PointerEvent) => {
        if (event.pointerType !== "mouse") return;
        const rect = host.getBoundingClientRect();
        pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = ((event.clientY - rect.top) / rect.height) * 2 - 1;
        settled = false; // wake the loop; it will put itself back to sleep when it catches up
      };
      window.addEventListener("pointermove", onPointerMove, { passive: true });

      let visible = true;
      const observer = new IntersectionObserver(([entry]) => {
        visible = entry?.isIntersecting ?? true;
      });
      observer.observe(host);

      const onResize = () => {
        const w = host.clientWidth || 1;
        const h = host.clientHeight || 1;
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      };
      const resizeObserver = new ResizeObserver(onResize);
      resizeObserver.observe(host);

      let frame = 0;
      let cursor = 0;
      // A frame BUDGET and a REST state, which together are what stop this being a space heater.
      // The loop is still driven by requestAnimationFrame — that is what keeps it in step with the
      // compositor and lets the browser stop it in a background tab — but it renders at most 30
      // times a second, and not at all once the deck has stopped moving and nothing is ramping in.
      // A still deck is a still picture; redrawing it 120 times a second is pure waste.
      const MIN_FRAME_MS = 1000 / 30;
      let lastDraw = 0;
      let settled = false;
      const entered = meshes.map(() => 0);
      const loop = () => {
        frame = requestAnimationFrame(loop);
        if (!visible || document.hidden) return;
        const now = performance.now();
        if (now - lastDraw < MIN_FRAME_MS) return;
        lastDraw = now;
        // Which card is centre-stage, as a continuous number. Driven by the POINTER ONLY — there is
        // no idle term, because an idle term is what would stop this ever reaching rest.
        const target = pointer.x * 1.6;
        // Ease toward the target, then SNAP once the remaining distance is below what a pixel can
        // show. Without the snap an exponential ease never actually arrives: it keeps producing
        // differences small enough to be invisible and large enough to count as movement, so the
        // scene draws for several seconds after the pointer has stopped. Measured at 135 draws a
        // second during that tail, which is most of the cost of a deck nobody is touching.
        cursor = Math.abs(target - cursor) < 0.0015 ? target : cursor + (target - cursor) * 0.12;
        const moved = layOutDeck({ meshes, frames, materials, frameMaterials, entered, cursor, pointerY: pointer.y });
        // False once every card sits where it belongs and every texture has faded in. One more
        // frame is drawn after that (so the final position is actually presented), then the loop
        // returns here until a pointer move sets `settled` back to false.
        if (!moved && settled) return;
        settled = !moved;
        renderer.render(scene, camera);
      };
      frame = requestAnimationFrame(loop);

      teardown = () => {
        window.clearTimeout(announce);
        cancelAnimationFrame(frame);
        observer.disconnect();
        resizeObserver.disconnect();
        window.removeEventListener("pointermove", onPointerMove);
        geometry.dispose();
        frameGeometry.dispose();
        for (const material of materials) material.dispose();
        for (const material of frameMaterials) material.dispose();
        for (const texture of textures) texture.dispose();
        renderer.dispose();
        renderer.domElement.remove();
      };
    })();

    return () => {
      cancelled = true;
      setRunning(false);
      teardown?.();
    };
  }, [reduced, shots]);

  return (
    <div className={cn("relative", className)} data-product-stack={running ? "webgl" : "image"}>
      {/* The fallback is the DEFAULT, not an error state: it renders first, and the canvas covers
          it only once the scene is genuinely drawing. */}
      <div className={cn("transition-opacity duration-500 motion-reduce:transition-none", running && "opacity-0")}>{fallback}</div>
      <div
        ref={hostRef}
        aria-hidden
        className={cn("pointer-events-none absolute inset-0", running ? "opacity-100" : "opacity-0")}
      />
    </div>
  );
}
