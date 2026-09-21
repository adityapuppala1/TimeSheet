/**
 * Scroll and pointer parallax, as CSS custom properties.
 *
 * WHY A HOOK AND NOT A LIBRARY: the whole job is "read a number, write a CSS variable, let the
 * compositor do the rest". A parallax library is tens of kilobytes on a public page whose entire
 * animation budget is otherwise one IntersectionObserver (see marketing/Reveal.tsx).
 *
 * WHY CUSTOM PROPERTIES rather than inline transforms: one rAF write drives any number of layers,
 * each choosing its own depth in CSS (`translateY(calc(var(--parallax) * -40px))`). The component
 * decides the motion; the stylesheet decides how much of it each layer takes. It also means the
 * reduced-motion path is a CSS question, not a JS branch — a layer simply does not reference the
 * variable inside a `motion-safe:` utility.
 *
 * WHAT IT REFUSES TO DO, and why each refusal is deliberate:
 *  - Not under `prefers-reduced-motion: reduce`. Parallax is vestibular motion; this is the one
 *    effect on the page where the preference is a medical setting rather than a taste.
 *  - Not on a coarse pointer. A finger has no hover, and scroll parallax on a phone competes with
 *    the scroll itself for the same 60 frames — it reads as jank, not depth.
 *  - Never more than one rAF in flight, and nothing at all while the element is off screen. A
 *    marketing page that keeps a scroll handler busy behind three sections of content is the
 *    reason people think parallax is expensive.
 *
 * The value handed to CSS is normalised: 0 when the element's top edge reaches the bottom of the
 * viewport, 1 when its bottom edge leaves the top. That keeps every layer's arithmetic in one
 * place and makes a depth factor readable — `-40px` is "forty pixels across the whole pass".
 */
import { useEffect, useRef } from "react";

/** Reads the preference once per call; cheap, and always current if the visitor changes it. */
function motionAllowed(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches && window.matchMedia("(pointer: fine)").matches;
}

/**
 * Writes `--parallax` (0→1 across the element's pass through the viewport) and, when `pointer` is
 * on, `--pointer-x` / `--pointer-y` (-1→1 from the element's centre) onto the returned ref.
 */
export function useParallax<T extends HTMLElement>({ pointer = false }: { pointer?: boolean } = {}) {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !motionAllowed()) return;

    let frame = 0;
    let visible = true;

    const write = () => {
      frame = 0;
      const rect = el.getBoundingClientRect();
      const span = window.innerHeight + rect.height;
      // 0 as the top edge meets the fold, 1 as the bottom edge leaves the top.
      const progress = span === 0 ? 0 : (window.innerHeight - rect.top) / span;
      el.style.setProperty("--parallax", Math.min(1, Math.max(0, progress)).toFixed(4));
    };

    const onScroll = () => {
      if (frame || !visible) return;
      frame = requestAnimationFrame(write);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!visible || event.pointerType !== "mouse") return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      el.style.setProperty("--pointer-x", (((event.clientX - rect.left) / rect.width) * 2 - 1).toFixed(3));
      el.style.setProperty("--pointer-y", (((event.clientY - rect.top) / rect.height) * 2 - 1).toFixed(3));
    };

    // Off-screen costs nothing: the listeners stay attached (re-binding on every scroll would cost
    // more than the guard) but do no work at all.
    const observer = new IntersectionObserver(
      ([entry]) => {
        visible = entry?.isIntersecting ?? true;
        if (visible) write();
      },
      { rootMargin: "20% 0px" }
    );
    observer.observe(el);

    write();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    if (pointer) window.addEventListener("pointermove", onPointerMove, { passive: true });

    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (pointer) window.removeEventListener("pointermove", onPointerMove);
    };
  }, [pointer]);

  return ref;
}
