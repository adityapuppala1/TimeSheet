/**
 * WHAT: the guided product tour. Walks a person through the parts of the app their role can
 * actually reach, navigating to each page, scrolling the target into view, spotlighting it and
 * blurring everything else.
 *
 * WHY IT'S HAND-BUILT rather than driver.js/shepherd/joyride: the hard part here isn't the
 * tooltip, it's that every step has to drive the ROUTER, wait for a page that fetches its data
 * before rendering, optionally switch a tab, and be filtered by the same permissions the sidebar
 * uses. Bending a library's step model around all four is more code than the ~200 lines below, and
 * leaves the role filtering — the part that must not be wrong — in a place nobody thinks to check.
 *
 * ── HOW THE SPOTLIGHT WORKS ─────────────────────────────────────────────────────────────────
 * Four panels are drawn AROUND the target rect (above, below, left, right) rather than one overlay
 * with a hole punched in it. That's deliberate: `clip-path` can cut a hole but cannot blur, and the
 * requirement is that everything except the target is blurred. Four `backdrop-blur` panels leave
 * the target untouched and readable while everything else goes soft, with no compositing tricks.
 *
 * ── WHEN IT RUNS ────────────────────────────────────────────────────────────────────────────
 * Automatically once per browser session for someone who hasn't seen it, and on demand from the
 * profile menu. Session-scoped rather than persisted: "show it again in a fresh session" is
 * forgiving, whereas a permanently-dismissed flag means someone who skipped it by accident on day
 * one never sees it again.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router";
import { create } from "zustand";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { usePlanningFeatures } from "../lib/use-planning";
import { buildTourSteps, type TourStep } from "../lib/tour-steps";
import { useAuthStore } from "../store/auth";
import { Button } from "./ui/button";

/** Marks the tour as seen for this browser session. See the header note on why not localStorage. */
const SESSION_KEY = "timesheet:tour-seen";
/** Padding around the spotlit element so its focus ring and shadow aren't clipped by the panels. */
const SPOTLIGHT_PADDING = 8;
/** How long to keep looking for a step's target before falling back. Pages fetch before they
 *  render, so the element routinely doesn't exist at the moment the route changes. */
const TARGET_TIMEOUT_MS = 2500;
const CARD_WIDTH = 340;
const CARD_GAP = 14;

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Polls for a selector until it exists or the window closes. Resolves null rather than throwing —
 *  a missing target must degrade to a centred card, never a stuck tour. */
function waitForElement(selector: string, timeoutMs: number): Promise<HTMLElement | null> {
  return new Promise((resolve) => {
    const existing = document.querySelector<HTMLElement>(selector);
    if (existing) return resolve(existing);

    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      const found = document.querySelector<HTMLElement>(selector);
      if (found || Date.now() - startedAt > timeoutMs) {
        window.clearInterval(timer);
        resolve(found ?? null);
      }
    }, 120);
  });
}

/**
 * SHARED, not per-hook local state. Two separate places offer "Take the tour" (the top bar's
 * account menu and the sidebar's, both via AccountMenu.tsx) while only ONE place renders
 * `<ProductTour>`. With `useState` here, each caller got its own disconnected `running` flag and
 * the menu's Start silently did nothing from anywhere but the component holding the renderer.
 */
interface TourState {
  running: boolean;
  start: () => void;
  stop: () => void;
}

const useTourStore = create<TourState>((set) => ({
  running: false,
  start: () => {
    sessionStorage.setItem(SESSION_KEY, "1");
    set({ running: true });
  },
  stop: () => set({ running: false })
}));

export function useTourController() {
  return useTourStore();
}

export function ProductTour({ running, onClose }: { running: boolean; onClose: () => void }) {
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const location = useLocation();

  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const { features } = usePlanningFeatures();
  const [steps, setSteps] = useState<TourStep[]>([]);
  const targetRef = useRef<HTMLElement | null>(null);

  // Rebuilt when the tour starts rather than on every render: the itinerary depends on the user's
  // permissions, which don't change mid-tour, and rebuilding would reset progress.
  useEffect(() => {
    if (running) {
      setSteps(buildTourSteps(user ?? undefined, features));
      setIndex(0);
    }
  }, [running, user]);

  const step: TourStep | undefined = steps[index];

  /** Measures the current target. Split out so scroll/resize can re-run it cheaply. */
  const measure = useCallback(() => {
    const element = targetRef.current;
    if (!element) return setRect(null);
    const box = element.getBoundingClientRect();
    // Zero-size means the element is display:none for this viewport (the sidebar on a phone) —
    // treat it as absent so the card centres instead of pointing at nothing.
    if (box.width === 0 && box.height === 0) return setRect(null);
    setRect({ top: box.top, left: box.left, width: box.width, height: box.height });
  }, []);

  // Resolve the step: navigate if needed, activate a tab if asked, wait for the element, scroll it
  // into view, then measure. Cancelled cleanly if the step changes mid-flight.
  useEffect(() => {
    if (!running || !step) return;
    let cancelled = false;

    (async () => {
      if (location.pathname !== step.route) {
        navigate(step.route);
        return; // The location change re-runs this effect with the right pathname.
      }

      if (step.tab) {
        const tab = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find(
          (candidate) => candidate.textContent?.trim().toLowerCase() === step.tab!.toLowerCase()
        );
        tab?.click();
      }

      let element = await waitForElement(step.selector, TARGET_TIMEOUT_MS);
      if (!element && step.fallbackSelector) element = await waitForElement(step.fallbackSelector, 600);
      if (cancelled) return;

      targetRef.current = element;
      // `center` keeps the card's preferred placement usable — an element scrolled to the very top
      // leaves nowhere to put a card above it.
      element?.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
      // Measure after the smooth scroll settles; the rect is wrong mid-animation.
      window.setTimeout(() => !cancelled && measure(), 380);
    })();

    return () => {
      cancelled = true;
    };
  }, [running, step, location.pathname, navigate, measure]);

  // Keep the spotlight glued to its target while the page moves under it.
  useLayoutEffect(() => {
    if (!running) return;
    const handler = () => measure();
    window.addEventListener("scroll", handler, true);
    window.addEventListener("resize", handler);
    return () => {
      window.removeEventListener("scroll", handler, true);
      window.removeEventListener("resize", handler);
    };
  }, [running, measure]);

  const close = useCallback(() => {
    targetRef.current = null;
    setRect(null);
    onClose();
  }, [onClose]);

  // Escape leaves the tour. Expected of anything modal, and cheaper than hunting for the button.
  useEffect(() => {
    if (!running) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
      if (event.key === "ArrowRight") setIndex((i) => Math.min(i + 1, steps.length - 1));
      if (event.key === "ArrowLeft") setIndex((i) => Math.max(i - 1, 0));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [running, close, steps.length]);

  if (!running || !step) return null;

  const isFirst = index === 0;
  const isLast = index === steps.length - 1;

  // Padded spotlight box, clamped so a target partly off-screen doesn't produce negative panels.
  const spot = rect
    ? {
        top: Math.max(0, rect.top - SPOTLIGHT_PADDING),
        left: Math.max(0, rect.left - SPOTLIGHT_PADDING),
        width: rect.width + SPOTLIGHT_PADDING * 2,
        height: rect.height + SPOTLIGHT_PADDING * 2
      }
    : null;

  const card = placeCard(spot, step.placement);

  return createPortal(
    <div className="fixed inset-0 z-[95]" role="dialog" aria-modal="true" aria-labelledby="tour-title">
      {spot ? (
        // Four panels AROUND the target — see the header note on why not one overlay with a hole.
        <>
          <Panel style={{ top: 0, left: 0, right: 0, height: spot.top }} />
          <Panel style={{ top: spot.top + spot.height, left: 0, right: 0, bottom: 0 }} />
          <Panel style={{ top: spot.top, left: 0, width: spot.left, height: spot.height }} />
          <Panel style={{ top: spot.top, left: spot.left + spot.width, right: 0, height: spot.height }} />
          {/* Ring only — no background, so the spotlit element stays fully legible. */}
          <div
            aria-hidden
            className="pointer-events-none absolute rounded-lg ring-2 ring-primary ring-offset-2 ring-offset-background transition-all duration-200"
            style={{ top: spot.top, left: spot.left, width: spot.width, height: spot.height }}
          />
        </>
      ) : (
        // No resolvable target (hidden at this viewport, or a slow page): dim everything and centre
        // the card. The step still reads, which is what matters.
        <Panel style={{ inset: 0 }} />
      )}

      <div
        className="absolute w-[min(340px,calc(100vw-2rem))] rounded-xl border border-border bg-card p-4 shadow-2xl"
        style={card}
      >
        <div className="flex items-start justify-between gap-2">
          <p id="tour-title" className="text-sm font-black tracking-tight">
            {step.title}
          </p>
          {/* "Close tour", not "Skip tour": the footer button already carries that name, and two
              controls with the same accessible name in one dialog are ambiguous to anyone
              navigating by label. Same action, distinct names. */}
          <button
            type="button"
            onClick={close}
            aria-label="Close tour"
            className="-mr-1 -mt-1 grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <p className="mt-2 text-sm leading-6 text-muted-foreground">{step.body}</p>

        <div className="mt-4 flex items-center justify-between gap-2">
          <span className="text-xs tabular-nums text-muted-foreground">
            {index + 1} of {steps.length}
          </span>
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="sm" className="h-8" onClick={close}>
              Skip tour
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-2"
              disabled={isFirst}
              aria-label="Previous step"
              onClick={() => setIndex((i) => Math.max(0, i - 1))}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button size="sm" className="h-8" onClick={() => (isLast ? close() : setIndex((i) => i + 1))}>
              {isLast ? "Done" : "Next"}
              {!isLast && <ChevronRight className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

/** One quadrant of the blurred surround. `pointer-events-auto` so clicks outside the spotlight
 *  can't reach the app mid-tour and navigate away from the step being explained. */
function Panel({ style }: { style: React.CSSProperties }) {
  return <div aria-hidden className="pointer-events-auto absolute bg-background/70 backdrop-blur-sm" style={style} />;
}

/**
 * Places the card near the target, flipping and clamping to stay on screen.
 *
 * Viewport-aware rather than fixed: the same step runs on a 390px phone and a 4K display, and a
 * card that hangs off the edge makes the tour worse than not having one.
 */
function placeCard(spot: Rect | null, placement: TourStep["placement"] = "bottom"): React.CSSProperties {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = Math.min(CARD_WIDTH, viewportWidth - 32);
  // Estimated; exact height needs a measure pass, and being ~20px out only shifts the card
  // slightly while avoiding a second render on every step.
  const estimatedHeight = 190;

  if (!spot) {
    return { top: Math.max(16, viewportHeight / 2 - estimatedHeight / 2), left: (viewportWidth - width) / 2 };
  }

  const below = spot.top + spot.height + CARD_GAP;
  const above = spot.top - estimatedHeight - CARD_GAP;
  const rightOf = spot.left + spot.width + CARD_GAP;
  const leftOf = spot.left - width - CARD_GAP;

  let top: number;
  let left: number;

  // Horizontal placements need real room; below ~640px there never is, so they fall through to
  // the vertical logic rather than producing a squeezed card.
  if (placement === "right" && rightOf + width < viewportWidth) {
    top = spot.top;
    left = rightOf;
  } else if (placement === "left" && leftOf > 0) {
    top = spot.top;
    left = leftOf;
  } else if (placement === "top" && above > 0) {
    // Same assignment as the "above > 0" fallback below, and NOT collapsible into it: this branch
    // must outrank the "below fits" check that follows, or a step explicitly authored with
    // placement="top" would render below the target whenever there also happened to be room below
    // — silently ignoring the author's placement choice.
    top = above;
    left = spot.left;
  } else if (below + estimatedHeight < viewportHeight) {
    top = below;
    left = spot.left;
    // eslint-disable-next-line sonarjs/no-duplicated-branches -- duplicates the placement="top" branch by design; see its comment
  } else if (above > 0) {
    // No room below — flip above rather than letting the card run off the bottom.
    top = above;
    left = spot.left;
  } else {
    // Target fills the viewport (common on a phone): overlay it near the bottom.
    top = Math.max(16, viewportHeight - estimatedHeight - 16);
    left = spot.left;
  }

  return {
    top: Math.min(Math.max(16, top), Math.max(16, viewportHeight - estimatedHeight - 16)),
    left: Math.min(Math.max(16, left), Math.max(16, viewportWidth - width - 16))
  };
}

/**
 * How recently onboarding must have completed for the tour to open itself.
 *
 * The brief said "once, on the user's first login, scoped to the browser session". Session scoping
 * alone is NOT enough to deliver that: it would re-open the tour every time ANY user starts a new
 * browser session, so someone a year into the job gets a walkthrough every morning. Anchoring to
 * `onboardingCompletedAt` makes "first login" literal — a brand-new account completes setup and
 * gets the tour; an established account never does, and reaches it from the profile menu instead.
 *
 * This also fixed a real regression: the tour's overlay intentionally captures clicks, so
 * auto-starting it for everyone blocked 17 existing e2e tests that click through the app. Seeded
 * accounts are backfilled to their creation date and fall outside this window, so they're
 * unaffected — the product behaviour and the test fix are the same change, not a workaround.
 */
const FIRST_LOGIN_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * True when the tour should open itself: this browser session hasn't seen it AND the account is
 * genuinely new.
 *
 * `completedAt` null means the first-run gate is still up — the tour waits, because a walkthrough
 * on top of a blocking gate is two modals arguing.
 */
export function shouldAutoStartTour(completedAt?: string | null): boolean {
  if (sessionStorage.getItem(SESSION_KEY) === "1") return false;
  if (!completedAt) return false;
  return Date.now() - new Date(completedAt).getTime() < FIRST_LOGIN_WINDOW_MS;
}

export function markTourSeen(): void {
  sessionStorage.setItem(SESSION_KEY, "1");
}
