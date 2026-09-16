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

import { ACCENT_PALETTES, DEFAULT_ACCENT, DEFAULT_DENSITY, isAccentId, isDensity, type AccentId, type Density } from "@timesheet/shared";

const THEME_KEY = "timesheet:theme";
const ACCENT_KEY = "timesheet:accent";
const DENSITY_KEY = "timesheet:density";
const THEME_CHANGED = "timesheet:theme-changed";

export type Theme = "light" | "dark";
/**
 * The three things a person can SAVE. "system" is a real, explicit choice — distinct from having
 * never chosen — even though both render by following the OS. Keeping them apart is what lets
 * "reset to default" be a state change, and what lets the per-user preference (below) say "this
 * person deliberately follows the OS" rather than "we know nothing about this person".
 */
export type ThemeMode = "system" | "light" | "dark";

let explicitChoice: Theme | undefined;
let accent: AccentId = DEFAULT_ACCENT;
let density: Density = DEFAULT_DENSITY;

function storedTheme(): Theme | undefined {
  try {
    const stored = window.localStorage.getItem(THEME_KEY);
    return stored === "dark" || stored === "light" ? stored : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Paints the accent for the theme being rendered.
 *
 * WHY THIS RUNS INSIDE renderTheme AND NOT ON ITS OWN: an accent is two colours, one per theme —
 * measured that way, because no hue passes WCAG AA as white-on-fill in dark mode (see
 * packages/shared/src/appearance.ts). So the accent has to be re-applied every time the theme
 * flips, or a dark-mode page keeps its light-mode primary for the rest of the session.
 *
 * WHY THREE VARIABLES AND NOT A CLASS: index.css derives `--ring`, `--plan-bar` and the capacity
 * ramp from the primary hue by VALUE, not by reference, so a class that only swapped `--primary`
 * would leave the focus ring and the Gantt bars in brand teal under an indigo button. Overriding
 * `--ring` alongside keeps focus honest; the planning tokens are deliberately left brand-coloured —
 * the timeline is a chart, and the dataviz rule is that a chart's palette does not follow the
 * chrome's. The default accent writes the EXACT existing values, so "teal" is pixel-identical to
 * "never chose", and nothing about today's screens changes for anyone who has not opened the card.
 */
function paintAccent(theme: Theme): void {
  const palette = ACCENT_PALETTES[accent][theme];
  const root = document.documentElement.style;
  root.setProperty("--primary", palette.primary);
  root.setProperty("--primary-foreground", palette.foreground);
  root.setProperty("--ring", palette.primary);
  document.documentElement.dataset.accent = accent;
}

/**
 * Density is ONE attribute on `<html>`; index.css turns it into the root font-size. It is applied
 * inside renderTheme for the same reason the accent is: every path that repaints (boot, a toggle,
 * another tab's change, a saved profile) then carries it, and there is no way to render a theme
 * without also rendering the density that goes with it.
 */
function paintDensity(): void {
  document.documentElement.dataset.density = density;
}

function renderTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
  paintAccent(theme);
  paintDensity();
  window.dispatchEvent(new Event(THEME_CHANGED));
}

function storedAccent(): AccentId | undefined {
  try {
    const stored = window.localStorage.getItem(ACCENT_KEY);
    return isAccentId(stored) ? stored : undefined;
  } catch {
    return undefined;
  }
}

function storedDensity(): Density | undefined {
  try {
    const stored = window.localStorage.getItem(DENSITY_KEY);
    return isDensity(stored) ? stored : undefined;
  } catch {
    return undefined;
  }
}

/** The accent currently painted. */
export function currentAccent(): AccentId {
  return accent;
}

/** The density currently applied. */
export function currentDensity(): Density {
  return density;
}

/**
 * The saved mode, as the three-way value a control shows. "system" both when the person chose
 * it and when they never chose — the control cannot tell those apart, and does not need to.
 */
export function currentMode(): ThemeMode {
  return explicitChoice ?? "system";
}

/** What the theme should be on a cold load: an explicit choice if there is one, the OS otherwise. */
export function resolveInitialTheme(): Theme {
  if (typeof window === "undefined") return "light";
  const stored = storedTheme();
  if (stored) return stored;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function currentTheme(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/** Subscribe controls to the rendered theme, including changes made from another control or tab. */
export function subscribeTheme(listener: () => void): () => void {
  window.addEventListener(THEME_CHANGED, listener);
  return () => window.removeEventListener(THEME_CHANGED, listener);
}

/** Follow the OS until a person makes a choice. Boot must never persist an inferred preference. */
export function initializeTheme(): () => void {
  const media = window.matchMedia?.("(prefers-color-scheme: dark)");
  explicitChoice = storedTheme();
  accent = storedAccent() ?? DEFAULT_ACCENT;
  density = storedDensity() ?? DEFAULT_DENSITY;
  const sync = () => renderTheme(explicitChoice ?? (media?.matches ? "dark" : "light"));
  const onStorage = (event: StorageEvent) => {
    if (event.storageArea !== window.localStorage) return;
    if (event.key !== THEME_KEY && event.key !== ACCENT_KEY && event.key !== DENSITY_KEY && event.key !== null) return;
    explicitChoice = storedTheme();
    accent = storedAccent() ?? DEFAULT_ACCENT;
    density = storedDensity() ?? DEFAULT_DENSITY;
    sync();
  };
  sync();
  media?.addEventListener("change", sync);
  window.addEventListener("storage", onStorage);
  return () => {
    media?.removeEventListener("change", sync);
    window.removeEventListener("storage", onStorage);
  };
}

/** The actual change, with no animation attached. Everything else in this file is decoration
 *  around this function, and it is called directly on every fallback path. */
export function applyTheme(theme: Theme): void {
  explicitChoice = theme;
  renderTheme(theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // A private window with storage blocked still gets the theme it asked for; it just will not
    // remember it. Losing the preference is a far better outcome than the toggle throwing.
  }
}

/**
 * Set the three-way mode. "system" CLEARS the stored choice — it is not stored as the string
 * "system", because the previous unit's whole point was that following the OS must never be a
 * persisted value: a persisted "system" would be one more thing for a reload to get wrong.
 */
export function applyMode(mode: ThemeMode): void {
  if (mode === "system") {
    explicitChoice = undefined;
    try {
      localStorage.removeItem(THEME_KEY);
    } catch {
      // Same posture as applyTheme: the screen still follows the OS; it just cannot remember to.
    }
    renderTheme(window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    return;
  }
  applyTheme(mode);
}

/** Set the accent. Repaints under the CURRENT theme; the theme itself does not change. */
export function applyAccent(next: AccentId): void {
  accent = next;
  try {
    localStorage.setItem(ACCENT_KEY, next);
  } catch {
    // Storage blocked — painted for this session, forgotten on reload, never thrown.
  }
  renderTheme(currentTheme());
}

/** Set the density. Repaints under the CURRENT theme; nothing else changes. */
export function applyDensity(next: Density): void {
  density = next;
  try {
    localStorage.setItem(DENSITY_KEY, next);
  } catch {
    // Storage blocked — applied for this session, forgotten on reload, never thrown.
  }
  renderTheme(currentTheme());
}

/**
 * Adopt a SAVED preference from the profile, on sign-in.
 *
 * The saved value wins over this browser's localStorage, because the profile is the thing a person
 * set on purpose and localStorage is where a previous session on this machine left its footprint —
 * possibly somebody else's. A profile with nothing saved leaves the browser's state untouched, so
 * an existing person's screen does not move on the deploy that introduces this.
 */
export function adoptSavedAppearance(
  saved: { mode?: ThemeMode | null; accent?: AccentId | null; density?: Density | null } | null | undefined
): void {
  if (!saved) return;
  if (saved.accent && isAccentId(saved.accent) && saved.accent !== accent) applyAccent(saved.accent);
  if (saved.density && isDensity(saved.density) && saved.density !== density) applyDensity(saved.density);
  if (saved.mode && saved.mode !== currentMode()) applyMode(saved.mode);
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

  /*
   * SUPPRESS THE APP'S OWN COLOUR TRANSITIONS FOR THE DURATION, and this is the difference between
   * the effect working and the effect being invisible.
   *
   * Measured: flipping the `dark` class starts 461 CSS transitions of 150 ms each — every card,
   * border, chip and label carrying `transition-colors`. Those run on the LIVE DOM underneath the
   * view transition's snapshots, so what a person actually perceives is a fast global cross-fade
   * that is over before the circle has travelled anywhere. The wipe was running correctly the whole
   * time; it was simply the quieter of two things happening at once.
   *
   * With them off, the live DOM changes instantly, the two snapshots are clean, and the circle is
   * the only thing moving — which is the entire point of taking the snapshots.
   */
  document.documentElement.classList.add("theme-switching");

  const transition = doc.startViewTransition(() => {
    applyTheme(next);
  });

  // Removed on `finished`, not on a timer: a transition that is skipped or interrupted still
  // settles that promise, so the class can never be left behind freezing every transition in the app.
  void transition.finished.finally(() => {
    document.documentElement.classList.remove("theme-switching");
  });

  void transition.ready
    .then(() => {
      document.documentElement.animate(
        {
          clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`]
        },
        {
          duration: 620,
          /*
           * LINEAR, AND THAT IS THE WHOLE POINT — this was `cubic-bezier(0.22, 1, 0.36, 1)`, an
           * aggressive ease-out, and it was why the sweep read as coming from the middle of the
           * screen rather than from the button. That curve is at ~93% of its travel by 25% of the
           * duration: the circle went from nothing to nearly full-screen inside about 80ms, so the
           * moment where it is small and visibly ON the control never lasted long enough to see.
           * The geometry was right the whole time; the timing hid it.
           *
           * A radial wipe wants its EDGE moving at a constant speed, because that is what makes an
           * origin readable — the eye tracks the boundary travelling outward from a point. Radius
           * growing linearly does exactly that. (Area still accelerates, since area goes as r², so
           * it does not feel mechanical the way a linear fade would.)
           */
          easing: "linear",
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
