/**
 * WHAT: the Agents page's "Studio" — a 3D diorama of the roster, one hovering robot per agent at its
 * own workstation, each acting out its job when it is on. It sits ABOVE the ordinary roster cards and
 * never replaces them: the cards stay the complete, accessible record, and this is the view that makes
 * the roster feel like a team.
 *
 * WHAT IS REAL AND WHAT IS ILLUSTRATION: whether an agent is on, working, finished or in trouble comes
 * from the roster (components/agents-studio/studio-model.ts). What it appears to be doing on its
 * stage — the tickets, the scanning — is a seeded illustration of its job, and every caption is tagged
 * "Simulated". "Watch it work" previews that illustration for any agent, including one that is off,
 * so you can see what a teammate would do before you switch it on.
 *
 * WHY THREE.JS IS LOADED HERE AND ONLY HERE: it is ~600KB. The engine is a dynamic import started when
 * the Studio mounts, so a visit to any other page never pays for it, and a failed chunk or a machine
 * with no real GPU falls back to a 2D row of animated portraits — the same agents, the same
 * selection, no 3D.
 *
 * ACCESSIBILITY: the canvas is `aria-hidden`; a visually-hidden list of buttons is the keyboard and
 * screen-reader route to every agent, and a live region announces the selection. Reduced motion draws
 * a still stage that can still be picked.
 *
 * WHO renders this: pages/Agents.tsx, above the roster.
 */
import { ArrowDown, Eye, EyeOff, Info, Play, Power, Square, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { isSoftwareWebGl } from "../../lib/webgl";
import { currentTheme, subscribeTheme } from "../../lib/theme";
import { useMediaQuery } from "../../lib/use-media-query";
import { cn } from "../../lib/utils";
import type { AgentRosterEntry } from "../../services/api";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { AgentPortrait } from "./AgentPortrait";
import type { StudioAgent, StudioHandle } from "./scene/types";
import { agentTintIndex, archetypeFor, ARCHETYPE_ROLE, MAX_STATIONS, moodCss, MOOD_LABEL, moodFor, type Mood } from "./studio-model";

const HIDE_KEY = "ts.agents.studio.hidden";
const PREVIEW_MS = 25_000;

const readHidden = () => {
  try {
    return localStorage.getItem(HIDE_KEY) === "1";
  } catch {
    return false;
  }
};

type Status = "loading" | "ready" | "unavailable";

const LEGEND: ReadonlyArray<Mood> = ["working", "idle", "attention", "off"];

export function AgentStudio({
  entries,
  selectedId,
  onSelect,
  canManage,
  busy,
  onToggle,
  onOpenDetails
}: Readonly<{
  entries: readonly AgentRosterEntry[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  canManage: boolean;
  busy: boolean;
  onToggle: (id: string, enabled: boolean) => void;
  onOpenDetails: (id: string) => void;
}>) {
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [hidden, setHidden] = useState(readHidden);
  const [status, setStatus] = useState<Status>("loading");
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  const [caption, setCaption] = useState<{ id: string; text: string } | null>(null);
  const [previews, setPreviews] = useState<ReadonlySet<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());

  const hostRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<StudioHandle | null>(null);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  // Moods that depend on the clock (a celebration ends, an old failure stops mattering) need a tick.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const timer of map.values()) clearTimeout(timer);
    };
  }, []);

  const agents = useMemo<StudioAgent[]>(
    () =>
      entries.slice(0, MAX_STATIONS).map((entry) => ({
        id: entry.id,
        name: entry.name,
        emoji: entry.emoji,
        archetype: archetypeFor(entry),
        tint: agentTintIndex(entry.templateKey ?? entry.id),
        mood: moodFor(entry, now, previews.has(entry.id)),
        previewing: previews.has(entry.id)
      })),
    [entries, now, previews]
  );
  const byId = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  // The scene is created once; later renders reach it through refs, never by rebuilding it.
  const agentsRef = useRef(agents);
  const selectedRef = useRef(selectedId);
  const onSelectRef = useRef(onSelect);
  agentsRef.current = agents;
  selectedRef.current = selectedId;
  onSelectRef.current = onSelect;

  useEffect(() => {
    if (hidden) return;
    const host = hostRef.current;
    if (!host) return;
    if (isSoftwareWebGl()) {
      setStatus("unavailable");
      return;
    }
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    setStatus("loading");
    void (async () => {
      try {
        const { createStudio } = await import("./scene/engine");
        if (cancelled || !hostRef.current) return;
        const handle = createStudio(
          hostRef.current,
          {
            onHover: (id, x, y) => setHover(id ? { id, x, y } : null),
            onSelect: (id) => onSelectRef.current(id),
            onCaption: (id, text) => setCaption({ id, text }),
            onLost: () => setStatus("unavailable")
          },
          { reducedMotion: reduced, theme: currentTheme() }
        );
        handleRef.current = handle;
        handle.setAgents(agentsRef.current);
        handle.select(selectedRef.current);
        unsubscribe = subscribeTheme(() => handle.setTheme(currentTheme()));
        setStatus("ready");
      } catch {
        if (!cancelled) setStatus("unavailable");
      }
    })();
    return () => {
      cancelled = true;
      unsubscribe?.();
      handleRef.current?.destroy();
      handleRef.current = null;
    };
  }, [hidden, reduced]);

  useEffect(() => {
    handleRef.current?.setAgents(agents);
  }, [agents]);
  useEffect(() => {
    handleRef.current?.select(selectedId);
  }, [selectedId]);

  const selected = selectedId ? byId.get(selectedId) : undefined;
  const hovered = hover ? byId.get(hover.id) : undefined;
  const selectedEntry = selectedId ? entries.find((e) => e.id === selectedId) : undefined;

  const togglePreview = (id: string) => {
    const next = new Set(previews);
    const existing = timers.current.get(id);
    if (existing) clearTimeout(existing);
    if (next.has(id)) {
      next.delete(id);
      timers.current.delete(id);
    } else {
      next.add(id);
      timers.current.set(
        id,
        setTimeout(() => {
          setPreviews((p) => {
            const copy = new Set(p);
            copy.delete(id);
            return copy;
          });
          timers.current.delete(id);
        }, PREVIEW_MS)
      );
    }
    setPreviews(next);
  };

  const setHiddenPersist = (value: boolean) => {
    setHidden(value);
    try {
      localStorage.setItem(HIDE_KEY, value ? "1" : "0");
    } catch {
      // Private mode: the preference just does not stick.
    }
  };

  if (hidden) {
    return (
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onClick={() => setHiddenPersist(false)} className="text-muted-foreground">
          <Eye className="mr-1.5 h-4 w-4" />
          Show the studio
        </Button>
      </div>
    );
  }

  const realWorking = selectedEntry ? moodFor(selectedEntry, now, false) === "working" : false;

  return (
    <section
      aria-label="The agents' studio"
      data-studio-status={status}
      data-tour="agent-studio"
      className="relative h-[430px] overflow-hidden rounded-2xl border border-border bg-linear-to-b from-primary/5 via-background to-muted/40 sm:h-[520px]"
      onKeyDown={(e) => {
        if (e.key === "Escape" && selectedId) onSelect(null);
      }}
    >
      {/* The canvas. Decorative: everything it shows is also in the list below it and in the cards. */}
      <div ref={hostRef} className="absolute inset-0" aria-hidden="true" />

      {status !== "ready" && (
        <StudioBackdrop status={status} agents={agents} selectedId={selectedId} onSelect={onSelect} reduced={reduced} />
      )}

      {/* Legend and controls. */}
      <div className="pointer-events-none absolute inset-x-3 top-3 flex flex-wrap items-start justify-between gap-2">
        <ul className="pointer-events-auto flex flex-wrap gap-x-3 gap-y-1 rounded-full border border-border bg-background/80 px-3 py-1.5 text-[11px] backdrop-blur" aria-label="What the colours mean">
          {LEGEND.map((mood) => (
            <li key={mood} className="flex items-center gap-1.5 text-muted-foreground">
              <span className="h-2 w-2 rounded-full" style={{ background: moodCss(mood) }} aria-hidden="true" />
              {MOOD_LABEL[mood]}
            </li>
          ))}
        </ul>
        <div className="pointer-events-auto flex items-center gap-1">
          <span
            className="hidden items-center gap-1 rounded-full border border-border bg-background/80 px-2.5 py-1 text-[11px] text-muted-foreground backdrop-blur sm:flex"
            title="Whether an agent is on, working or needs a look is real. What it appears to do on its stage is an illustration of its job, not live data."
          >
            <Info className="h-3 w-3" aria-hidden="true" />
            Activity on stage is simulated
          </span>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8 bg-background/80 backdrop-blur"
            onClick={() => setHiddenPersist(true)}
            aria-label="Hide the studio"
            title="Hide the studio"
          >
            <EyeOff className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Hover label. */}
      {hover && hovered && !selected && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-border bg-popover px-2.5 py-1.5 text-xs shadow-md"
          style={{ left: hover.x, top: Math.max(40, hover.y - 14) }}
        >
          <p className="font-medium">
            {hovered.emoji} {hovered.name}
          </p>
          <p className="text-muted-foreground">
            {MOOD_LABEL[hovered.mood]} · {ARCHETYPE_ROLE[hovered.archetype]}
          </p>
        </div>
      )}

      {/* The selected agent. */}
      {selected && (
        <div className="absolute inset-x-3 bottom-3 z-10 animate-fade-in rounded-xl border border-border bg-background/90 p-3 shadow-lg backdrop-blur sm:inset-x-auto sm:left-3 sm:w-[26rem]">
          <div className="flex items-start gap-2.5">
            <AgentPortrait tint={selected.tint} mood={selected.mood} size={40} animate={!reduced} />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-1.5 font-medium leading-tight">
                {selected.name}
                <Badge variant="secondary" className="gap-1 text-[10px]">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: moodCss(selected.mood) }} aria-hidden="true" />
                  {selected.previewing ? "Previewing" : MOOD_LABEL[selected.mood]}
                </Badge>
              </p>
              <p className="text-xs text-muted-foreground">{ARCHETYPE_ROLE[selected.archetype]}</p>
            </div>
            <button
              type="button"
              onClick={() => onSelect(null)}
              aria-label="Close"
              className="focus-ring grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <p className="mt-2 flex items-start gap-1.5 text-xs" aria-live="polite">
            <span className="mt-px shrink-0 rounded bg-muted px-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">Simulated</span>
            <span className="min-w-0 text-foreground/90">{caption?.id === selected.id ? caption.text : "Settling in…"}</span>
          </p>

          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {!realWorking && (
              <Button size="sm" variant={selected.previewing ? "secondary" : "outline"} className="h-8" onClick={() => togglePreview(selected.id)}>
                {selected.previewing ? <Square className="mr-1.5 h-3 w-3" /> : <Play className="mr-1.5 h-3 w-3" />}
                {selected.previewing ? "Stop preview" : "Watch it work"}
              </Button>
            )}
            {canManage && selectedEntry && (
              <Button size="sm" variant="outline" className="h-8" disabled={busy} onClick={() => onToggle(selected.id, !selectedEntry.enabled)}>
                <Power className="mr-1.5 h-3.5 w-3.5" />
                {selectedEntry.enabled ? "Power off" : "Power on"}
              </Button>
            )}
            <Button size="sm" variant="ghost" className="h-8" onClick={() => onOpenDetails(selected.id)}>
              <ArrowDown className="mr-1.5 h-3.5 w-3.5" />
              Details
            </Button>
          </div>
        </div>
      )}

      {/* The route in for keyboards and screen readers. */}
      <ul className="sr-only" aria-label="Agents in the studio">
        {agents.map((a) => (
          <li key={a.id}>
            <button type="button" onClick={() => onSelect(a.id === selectedId ? null : a.id)} aria-pressed={a.id === selectedId}>
              {a.name}, {MOOD_LABEL[a.mood]}, {ARCHETYPE_ROLE[a.archetype]}
            </button>
          </li>
        ))}
      </ul>
      <p className="sr-only" aria-live="polite">
        {selected ? `${selected.name} selected. ${MOOD_LABEL[selected.mood]}.` : ""}
      </p>
    </section>
  );
}

/**
 * What shows when the 3D stage is not (yet) there: while it loads, ghost portraits; if it cannot run
 * — no real GPU, a failed chunk, a lost context — the same agents as animated portraits you can still
 * pick. It is the Studio, just flat.
 */
function StudioBackdrop({
  status,
  agents,
  selectedId,
  onSelect,
  reduced
}: Readonly<{
  status: Status;
  agents: readonly StudioAgent[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  reduced: boolean;
}>) {
  const loading = status === "loading";
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-4 pb-24 pt-14">
      <div className="flex max-w-full flex-wrap items-end justify-center gap-4 sm:gap-6">
        {agents.map((a) => {
          const active = a.id === selectedId;
          return (
            <button
              key={a.id}
              type="button"
              disabled={loading}
              onClick={() => onSelect(active ? null : a.id)}
              aria-pressed={active}
              className={cn(
                "focus-ring group flex w-24 flex-col items-center gap-1.5 rounded-xl p-2 transition-all duration-200 sm:w-28",
                loading ? "opacity-40" : "hover:-translate-y-1 hover:bg-background/70",
                active && "bg-background/80 ring-2 ring-primary/60"
              )}
            >
              <AgentPortrait tint={a.tint} mood={loading ? "off" : a.mood} size={72} animate={!reduced && !loading} className={loading ? "animate-pulse" : undefined} />
              <span className="max-w-full truncate text-xs font-medium">{a.name}</span>
              <span className="text-[10px] text-muted-foreground">{loading ? "…" : MOOD_LABEL[a.mood]}</span>
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        {loading ? "Waking the studio…" : "The 3D view needs a graphics card this browser can use — the same agents, flat."}
      </p>
    </div>
  );
}
