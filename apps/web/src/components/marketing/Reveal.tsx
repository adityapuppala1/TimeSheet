/**
 * Scroll-driven presentation helpers for the three public pages (`/`, `/pitch`, `/login`).
 *
 * WHY THEY LIVE HERE TOGETHER: they are one concern — "what the visitor is currently looking at" —
 * and they are deliberately NOT in the app's shared hooks folder, because nothing behind the login
 * wall should grow a dependency on marketing chrome.
 *
 * WHY NO ANIMATION LIBRARY: these pages previously entered via framer-motion, which is ~35KB of
 * JavaScript to move an element 14px once. Everything below is a CSS transition plus one
 * IntersectionObserver, so the animation runs on the compositor and the public bundle pays nothing.
 *
 * REDUCED MOTION IS HANDLED BY THE `motion-safe:` PREFIX, NOT BY JS. That matters: the hidden state
 * (`opacity-0 translate-y-4`) is *itself* behind `motion-safe:`, so a visitor who asked for reduced
 * motion — or one whose IntersectionObserver never fires — sees fully-rendered content rather than
 * an invisible page waiting on a callback. Content must never depend on an animation to exist.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../../lib/utils";

/** Fades and lifts its children into place the first time they approach the viewport. */
export function Reveal({
  children,
  className,
  /** Stagger, in ms, for siblings revealed by the same scroll. */
  delay = 0
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setShown(true);
        // One-shot: re-hiding a section on the way back up is disorienting, and it keeps the
        // observer alive for the life of the page for no benefit.
        observer.disconnect();
      },
      // Negative bottom margin so the reveal fires slightly *after* the element's top edge
      // appears, rather than while it's still a sliver at the fold.
      { rootMargin: "0px 0px -8% 0px", threshold: 0.01 }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      style={shown ? undefined : { transitionDelay: `${delay}ms` }}
      className={cn(
        "motion-safe:transition-[opacity,transform] motion-safe:duration-700 motion-safe:ease-out",
        !shown && "motion-safe:translate-y-4 motion-safe:opacity-0",
        className
      )}
    >
      {children}
    </div>
  );
}

/**
 * Which of `ids` is currently under the reader's eye, for a nav that highlights itself.
 * The band is the middle of the viewport, so the answer changes when the *content* changes rather
 * than when a section's edge grazes the fold.
 */
export function useSectionSpy(ids: string[]): string | undefined {
  const [active, setActive] = useState<string | undefined>(undefined);
  // Joined so the effect keys on the contents, not on a fresh array identity each render.
  const key = ids.join(",");

  useEffect(() => {
    const order = key.split(",");
    const elements = order.map((id) => document.getElementById(id)).filter((el): el is HTMLElement => el !== null);
    if (elements.length === 0 || typeof IntersectionObserver === "undefined") return;

    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        // Topmost wins when two sections share the band — otherwise the highlight flickers
        // between them while a short section scrolls through.
        setActive(order.find((id) => visible.has(id)));
      },
      { rootMargin: "-45% 0px -50% 0px", threshold: 0 }
    );

    for (const element of elements) observer.observe(element);
    return () => observer.disconnect();
  }, [key]);

  return active;
}

/** How far down the document the visitor is, 0–1, for a reading-progress bar. */
export function useScrollProgress(): number {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const doc = document.documentElement;
      const scrollable = doc.scrollHeight - doc.clientHeight;
      setProgress(scrollable > 0 ? Math.min(1, Math.max(0, doc.scrollTop / scrollable)) : 0);
    };
    // Coalesced into a frame: scroll fires far more often than the bar can repaint, and reading
    // scrollHeight per event forces a layout each time.
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, []);

  return progress;
}
