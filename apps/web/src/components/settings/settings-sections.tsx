/**
 * The shape every long Workspace Settings tab now shares: a BOARD that answers "what is switched
 * on, and is it working" in one screen, above SECTIONS that fold, each with an icon, a one-line
 * status and the form behind a click.
 *
 * WHY THIS EXISTS AS ONE MODULE. The Single sign-on tab was rebuilt this way first, and the AI tab
 * was then measured at 13,871 px tall on a laptop and 27,374 px on a phone — ten cards in a
 * trench coat, most of them about something the admin did not come for. Chat integrations, the
 * MCP server and Security & DevOps had the same shape at smaller scale. Rebuilding each tab with
 * its own copy of a tile, a chip and a folding card would have given four tabs four slightly
 * different treatments; this is the one they share, so a section cannot end up with a
 * differently-worded status or a header that behaves unlike its neighbours.
 *
 * WHY SECTIONS STAY MOUNTED WHILE FOLDED (a `grid-template-rows` transition, not an unmount): each
 * holds unsaved local state — a half-typed token, a pasted certificate, a filter somebody set.
 * Unmounting would discard it the moment they folded the card to look at another.
 *
 * WHY THE FOLDED SET IS REMEMBERED per tab (localStorage, best effort): an admin who works on
 * prompts and datasets together should find both open tomorrow. The default set is the one
 * question the tab exists to answer first.
 *
 * THE EXISTING CARDS ARE NOT REWRITTEN. A card such as AIProviderListCard renders its own
 * `<Card><CardHeader>…` today. Inside a section it renders FRAMELESS — the section's header is the
 * card's title, the card's own description stays as the lead paragraph, and the card's border and
 * padding drop away — through `CardFrameContext` in ui/card.tsx, so nine card components gained
 * this without nine edits, and a card mounted elsewhere is exactly as it was.
 */
import { ChevronDown, type LucideIcon } from "lucide-react";
import { Children, useCallback, useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { Card, CardContent, CardDescription, CardFrameContext, CardTitle } from "../ui/card";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { cn } from "../../lib/utils";

/* ── Status ───────────────────────────────────────────────────────────────────────────────────
   Four states. The distinction that matters is between "ready" (set up, switched off on purpose)
   and "attention" (started and stopped, or working but with a warning) — folding those into one
   "not enabled" hides a mistake behind a choice. */
export type SectionState = "live" | "ready" | "attention" | "off";

export const SECTION_STATE_META: Record<SectionState, { label: string; className: string; dot: string }> = {
  live: { label: "Live", className: "bg-success/10 text-success-ink ring-success/20", dot: "bg-success" },
  ready: { label: "Ready — not switched on", className: "bg-warning/10 text-warning-ink ring-warning/20", dot: "bg-warning" },
  attention: { label: "Needs attention", className: "bg-warning/10 text-warning-ink ring-warning/20", dot: "bg-warning" },
  off: { label: "Not set up", className: "bg-muted text-muted-foreground ring-border", dot: "bg-muted-foreground/50" }
};

/** Any mark or lucide icon: everything in provider-marks.tsx takes exactly this. */
export type SectionIcon = LucideIcon | ComponentType<{ className?: string }>;

/** The dot pulses only when something is actually live — an animation that is always running says
 *  nothing, and here it is the one piece of state worth catching from across a room. */
export function StatusChip({ state, label, className }: { state: SectionState; label?: string; className?: string }) {
  const meta = SECTION_STATE_META[state];
  return (
    <span
      className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset", meta.className, className)}
      data-section-state={state}
    >
      <span className="relative flex h-1.5 w-1.5">
        {state === "live" && <span className={cn("absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 motion-reduce:hidden", meta.dot)} />}
        <span className={cn("relative inline-flex h-1.5 w-1.5 rounded-full", meta.dot)} />
      </span>
      {label ?? meta.label}
    </span>
  );
}

/* ── The board ────────────────────────────────────────────────────────────────────────────────
   The summary an admin came for, above the forms they didn't. Each tile is a real button that
   opens its section and scrolls to it, so the board is navigation rather than decoration. A tile
   may carry a FIGURE ("$0.64 of $20", "3 of 5 on") — the one number the section is about — so the
   board also answers the question without a click. */
export interface BoardEntry {
  id: string;
  name: string;
  blurb: string;
  state: SectionState;
  stateLabel?: string;
  Icon: SectionIcon;
  /** The section's one figure, when it has one. */
  value?: string;
}

export function SectionBoard({
  title,
  summary,
  entries,
  onPick,
  aside,
  columns = 3
}: {
  title: string;
  summary: ReactNode;
  entries: BoardEntry[];
  onPick: (id: string) => void;
  aside?: ReactNode;
  columns?: 3 | 4;
}) {
  return (
    <Card className="overflow-hidden" data-settings-board>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/30 px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <CardTitle className="text-base">{title}</CardTitle>
          <CardDescription className="mt-0.5">{summary}</CardDescription>
        </div>
        {aside}
      </div>
      <div className={cn("grid gap-3 p-4 sm:grid-cols-2 sm:p-5", columns === 4 ? "lg:grid-cols-3 xl:grid-cols-4" : "xl:grid-cols-3")}>
        {entries.map((entry, i) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => onPick(entry.id)}
            style={{ animationDelay: `${Math.min(i, 11) * 40}ms` }}
            data-board-tile={entry.id}
            className="group flex animate-fade-in items-start gap-3 rounded-xl border border-border bg-card p-3.5 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-soft focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transform-none motion-reduce:animate-none motion-reduce:transition-none"
          >
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-muted text-foreground transition-colors group-hover:bg-primary/10 group-hover:text-primary">
              <entry.Icon className="h-[18px] w-[18px]" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-semibold">{entry.name}</span>
                <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", SECTION_STATE_META[entry.state].dot)} aria-hidden />
              </span>
              {entry.value && <span className="mt-0.5 block truncate text-sm font-bold tabular-nums text-foreground">{entry.value}</span>}
              <span className="mt-0.5 block text-xs text-muted-foreground">{entry.blurb}</span>
              <span className="mt-1.5 block text-xs font-medium text-muted-foreground group-hover:text-primary">
                {entry.stateLabel ?? SECTION_STATE_META[entry.state].label}
              </span>
            </span>
          </button>
        ))}
      </div>
    </Card>
  );
}

/* ── The section shell ────────────────────────────────────────────────────────────────────────
   One shell for every section, so none can end up with a different icon treatment or a header
   that behaves differently from its neighbours. */
export function SettingsSection({
  id,
  prefix,
  name,
  blurb,
  state,
  stateLabel,
  Icon,
  open,
  onToggle,
  actions,
  children
}: {
  id: string;
  /** Namespaces the DOM ids so two tabs cannot collide: `ai`, `chat`, `mcp`, `devops`. */
  prefix: string;
  name: string;
  blurb: ReactNode;
  state: SectionState;
  stateLabel?: string;
  Icon: SectionIcon;
  open: boolean;
  onToggle: () => void;
  /** Header-level controls (a switch, a count) that must work without opening the section. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card
      id={`${prefix}-section-${id}`}
      className="overflow-hidden scroll-mt-24 transition-shadow duration-200 hover:shadow-soft"
      data-settings-section={id}
      data-section-open={open ? "true" : "false"}
    >
      {/* A real heading with the toggle button INSIDE it (h3 > button is valid; button > h3 is
          not, and a button's children are flattened out of the accessibility tree anyway, which
          would leave the section without a heading for a screen reader or a test to find). The
          button's ::after stretches over the whole header so the entire row is the click target;
          the actions slot sits above that overlay so its switch keeps its own click. */}
      <div className="relative flex items-start gap-3 p-4 sm:p-5 transition-colors hover:bg-muted/40">
        <span className={cn("grid h-10 w-10 shrink-0 place-items-center rounded-lg transition-colors", state === "live" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground")}>
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="flex flex-wrap items-center gap-2 text-base font-semibold">
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={open}
              aria-controls={`${prefix}-body-${id}`}
              className="text-left after:absolute after:inset-0 after:rounded-lg focus-visible:outline-hidden focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring"
            >
              {name}
            </button>
            <StatusChip state={state} label={stateLabel} />
          </h3>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">{blurb}</p>
        </div>
        <ChevronDown className={cn("mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none", open && "rotate-180")} aria-hidden />
        {actions && <div className="relative z-10 shrink-0 pt-1">{actions}</div>}
      </div>
      {/* 0fr → 1fr is the one way to transition to a content-derived height without measuring it
          in JS. The inner element owns the overflow; the outer one owns the animation. */}
      <div
        id={`${prefix}-body-${id}`}
        className={cn("grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none", open ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}
      >
        <div className="overflow-hidden">
          <CardContent className="grid gap-4 border-t border-border pt-4 sm:pt-5">
            <CardFrameContext.Provider value="frameless">{children}</CardFrameContext.Provider>
          </CardContent>
        </div>
      </div>
    </Card>
  );
}

/**
 * Several cards in one section: each keeps its own title as a sub-heading (the "embedded" card
 * mode), loses its frame, and a rule separates it from the next. A section wrapping ONE card is
 * the plain case — the section's header is that card's title; a section wrapping a group needs
 * the group's members still telling themselves apart.
 */
export function SectionGroup({ children }: { children: ReactNode }) {
  return (
    <CardFrameContext.Provider value="embedded">
      <div className="grid gap-5 divide-y divide-border [&>*+*]:pt-5">
        {Children.map(children, (child) => (child === null || child === undefined || child === false ? null : <div className="grid gap-4">{child}</div>))}
      </div>
    </CardFrameContext.Provider>
  );
}

/** The switch rows repeated across sections, one component so wording, spacing and the disabled
 *  treatment cannot drift apart. */
export function ToggleRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
  emphasis = false
}: {
  label: string;
  hint: ReactNode;
  checked: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
  /** The one master switch a tab hangs on. */
  emphasis?: boolean;
}) {
  return (
    <div className={cn("flex items-start gap-4 rounded-lg border p-4 transition-colors", emphasis ? "border-primary/40 bg-primary/5" : "border-border bg-muted/20 hover:border-primary/30")}>
      <div className="min-w-0 flex-1">
        <Label>{label}</Label>
        <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{hint}</p>
      </div>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}

/* ── Which sections are open ──────────────────────────────────────────────────────────────────
   Several may be open at once (an admin comparing prompts against datasets), remembered per tab.
   `reveal` opens one and scrolls to it — what a board tile does. */
function readStored(key: string): string[] | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((v) => typeof v === "string") ? parsed : null;
  } catch {
    return null;
  }
}

export function useOpenSections(storageKey: string, defaults: string[]) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(readStored(storageKey) ?? defaults));

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify([...open]));
    } catch {
      /* private mode, quota: the choice simply is not remembered */
    }
  }, [open, storageKey]);

  const toggle = useCallback((id: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const reveal = useCallback((id: string, prefix: string) => {
    setOpen((prev) => (prev.has(id) ? prev : new Set([...prev, id])));
    // After the section has had a frame to open; the scroll target is the card itself.
    requestAnimationFrame(() => {
      const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      document.getElementById(`${prefix}-section-${id}`)?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
    });
  }, []);

  return useMemo(() => ({ isOpen: (id: string) => open.has(id), toggle, reveal }), [open, toggle, reveal]);
}
