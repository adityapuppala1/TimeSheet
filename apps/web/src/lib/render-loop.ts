/**
 * The animation-frame policy every canvas scene in this app follows, in one place.
 *
 * WHY THIS EXISTS. Four scenes had grown their own render loops — the login lattice, the hero
 * aurora, the portfolio's 3D scene and the hero product deck — and each had implemented a slightly
 * different subset of the same four safeguards. One paused off screen but not in a background tab;
 * one did neither; one rendered at the display's refresh rate, which on a 120Hz panel is twice the
 * work for motion nobody can see at 60. Measured on an idle marketing page: 598 WebGL draw calls a
 * second for scenery the reader had already scrolled past.
 *
 * The four rules, and why each is not optional:
 *
 *  1. NOTHING RENDERS OFF SCREEN. A scene three sections up the page is not being looked at. This
 *     is the single largest saving on a long page and the easiest to forget, because during
 *     development the scene is usually the thing you are looking at.
 *  2. NOTHING RENDERS IN A BACKGROUND TAB. Browsers throttle `requestAnimationFrame` when a tab is
 *     hidden, but they do not stop it, and a throttled loop still wakes the GPU. A laptop on
 *     battery with this page in a background tab should cost nothing at all.
 *  3. A FRAME BUDGET, not the display's refresh rate. Decorative motion is authored to read at
 *     30fps; drawing it 120 times a second quadruples the cost to deliver the same picture.
 *  4. A REST STATE. The strongest rule and the one most often missing: a scene that has stopped
 *     changing must stop drawing. `render()` returns false when nothing moved, and the loop then
 *     idles at the cost of one early return per frame until something wakes it.
 *
 * It deliberately does NOT own the WebGL context, the scene graph or disposal. Those differ per
 * scene and belong to the scene; this owns *when* to draw, which is the part they were all getting
 * wrong in the same way.
 */

export interface RenderLoopOptions {
  /** Watched for visibility. The loop idles whenever this element is off screen. */
  host: Element;
  /**
   * Draw one frame. Return `false` when nothing changed, and the loop stops drawing until
   * `wake()` is called — the rest state. Returning `true` (or nothing) keeps it drawing.
   */
  render: () => boolean | void;
  /** Frames per second ceiling. 30 unless a scene has a reason to justify more. */
  fps?: number;
  /** Margin around the host for the visibility test, so a scene is warm as it scrolls in. */
  rootMargin?: string;
}

export interface RenderLoopHandle {
  /** Ends the loop and releases its observers. Safe to call more than once. */
  stop: () => void;
  /** Marks the scene as changed, so the loop draws again. Call from input handlers. */
  wake: () => void;
}

export function createRenderLoop({ host, render, fps = 30, rootMargin = "0px" }: RenderLoopOptions): RenderLoopHandle {
  const minFrameMs = 1000 / fps;
  let frame = 0;
  let lastDraw = 0;
  let visible = true;
  let resting = false;
  let stopped = false;

  const observer =
    typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver(
          ([entry]) => {
            const next = entry?.isIntersecting ?? true;
            // Coming back into view is a wake: whatever happened while away was not drawn.
            if (next && !visible) resting = false;
            visible = next;
          },
          { rootMargin }
        );
  observer?.observe(host);

  const onVisibility = () => {
    if (!document.hidden) resting = false;
  };
  document.addEventListener("visibilitychange", onVisibility);

  const tick = () => {
    if (stopped) return;
    frame = requestAnimationFrame(tick);
    if (!visible || document.hidden || resting) return;

    const now = performance.now();
    if (now - lastDraw < minFrameMs) return;
    lastDraw = now;

    resting = render() === false;
  };
  frame = requestAnimationFrame(tick);

  return {
    stop: () => {
      stopped = true;
      cancelAnimationFrame(frame);
      observer?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    },
    wake: () => {
      resting = false;
    }
  };
}
