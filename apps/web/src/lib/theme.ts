/**
 * The one place that changes the theme — and the circular wipe that plays when it does.
 *
 * WHY A SHARED MODULE: three places set the theme (Topbar, the command palette, and
 * ThemeBootstrap on first paint) and they each had their own copy of the class toggle and the
 * storage key. Three copies of a two-line side effect is how one of them quietly stops matching
 * the others.
 *
 * THE WIPE USES THE VIEW TRANSITIONS API, which is the only way to do this without the app
 * rendering both themes at once. `document.startViewTransition` snapshots the CURRENT frame,
 * applies the DOM change, then lets you animate between the two — so the new theme is revealed
 * through an expanding circle centred on the control that was pressed, and the old theme sits
 * underneath, untouched. The alternative (two stacked copies of the page, cross-fading) means
 * painting the entire UI twice for the duration, which is exactly the kind of always-expensive
 * effect the `.ai-gradient-text` fix in index.css exists to warn about.
 *
 * The radius is measured to the FURTHEST corner from the click, not a fixed number: a toggle in
 * the top-right of a 4K display needs a much larger circle than the same control on a phone, and
 * a circle that stops short leaves a visible ring of the old theme.
 *
 * IT DEGRADES TO AN INSTANT SWITCH, deliberately and in three separate cases: no View Transitions
 * support (Firefox at time of writing), a reduced-motion preference, and a call with no
 * originating element (the command palette's keyboard path — there is no sensible centre for a
 * circle when nobody clicked anything). In all three the theme still changes; only the flourish is
 * absent. That ordering matters — the setting must never depend on the animation succeeding.
 */

const THEME_KEY = "timesheet:theme";

export type Theme = "light" | "dark";

/** What the theme should be on a cold load: an explicit choice if there is one, the OS otherwise. */
export function resolveInitialTheme(): Theme {
  if (typeof window === "undefined") return "light";
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === "dark" || stored === "light") return stored;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function currentTheme(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/** The actual change, with no animation attached. Everything else in this file is decoration
 *  around this function, and it is called directly on every fallback path. */
export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // A private window with storage blocked still gets the theme it asked for; it just will not
    // remember it. Losing the preference is a far better outcome than the toggle throwing.
  }
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => void | Promise<void>) => { ready: Promise<void>; finished: Promise<void> };
};

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** Distance from a point to the furthest corner of the viewport — the radius at which a circle
 *  centred on that point has covered the whole screen. */
function radiusToFurthestCorner(x: number, y: number): number {
  const w = window.innerWidth;
  const h = window.innerHeight;
  return Math.hypot(Math.max(x, w - x), Math.max(y, h - y));
}

/**
 * Switch theme, revealing the new one from `origin` (usually the bounding box of the button that
 * was pressed). Returns the theme that is now active, so a caller can keep its own state in step
 * without re-reading the DOM.
 */
export function toggleTheme(origin?: { x: number; y: number }): Theme {
  const next: Theme = currentTheme() === "dark" ? "light" : "dark";
  const doc = document as ViewTransitionDocument;

  if (!doc.startViewTransition || prefersReducedMotion() || !origin) {
    applyTheme(next);
    return next;
  }

  const { x, y } = origin;
  const radius = radiusToFurthestCorner(x, y);

  const transition = doc.startViewTransition(() => {
    applyTheme(next);
  });

  void transition.ready
    .then(() => {
      document.documentElement.animate(
        {
          clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`]
        },
        {
          duration: 520,
          // Fast out of the gate and settling at the edge — a linear wipe reads mechanical, and
          // the whole point of this is that it should feel like the theme is spreading.
          easing: "cubic-bezier(0.22, 1, 0.36, 1)",
          // Only the INCOMING snapshot is clipped. The outgoing one is left alone underneath, so
          // the effect is the new theme spreading over the old rather than a hole opening in it.
          pseudoElement: "::view-transition-new(root)"
        }
      );
    })
    // A rejected `ready` means the browser abandoned the transition — another one started, or the
    // tab was hidden mid-flight. The class change has already happened by then, so there is
    // genuinely nothing to repair; swallowing it keeps an unhandled rejection out of the console.
    .catch(() => undefined);

  return next;
}

/** The centre of an element, in viewport coordinates — what `toggleTheme` wants for `origin`. */
export function centreOf(el: HTMLElement | null): { x: number; y: number } | undefined {
  if (!el) return undefined;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}
