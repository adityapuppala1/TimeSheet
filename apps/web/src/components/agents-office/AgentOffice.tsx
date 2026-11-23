/**
 * WHAT: the Agents page's Office — a 3D office floor where every agent is a person: sitting at a desk,
 * walking to the room that does its job when a run starts, waving for help after a failure, heading out
 * of the door when switched off, and between runs getting coffee, chatting or holding a stand-up. It
 * sits above the roster cards and never replaces them.
 *
 * WHAT IS REAL, AND HOW THE PAGE SAYS SO:
 *   - Where an agent is and what it is doing follows its real state (studio-model.ts `moodFor`).
 *   - The feed's "Runs" lines are real agent runs from the roster.
 *   - "Office life" lines (coffee, chats, stand-ups) are idle ambience and are labelled that way.
 *   - What a room's equipment shows while an agent works it is an illustration, tagged "Simulated".
 *   - "Watch it work" previews an agent at its zone without it having a real run; the panel says so.
 *
 * COST AND FALLBACKS: three.js, the Rapier physics engine and the character models load only when this
 * mounts. No real GPU, a failed chunk or a lost context shows the same agents as 2D portraits. Reduced
 * motion draws a still office. The canvas is `aria-hidden`; a visually-hidden list is the keyboard and
 * screen-reader route to every agent.
 *
 * CONTROLS: drag to orbit, the buttons (or Ctrl+wheel; plain wheel in full-screen) to zoom, click a
 * person to follow them, click a ball or box to flick it.
 *
 * WHO renders this: pages/Agents.tsx, above the roster.
 */
import { ArrowDown, Eye, EyeOff, Maximize2, Minimize2, Minus, Play, Plus, Power, RotateCcw, Square, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { isSoftwareWebGl } from "../../lib/webgl";
import { currentTheme, subscribeTheme } from "../../lib/theme";
import { useMediaQuery } from "../../lib/use-media-query";
import { cn } from "../../lib/utils";
import type { AgentRosterEntry } from "../../services/api";
import type { StudioAgent } from "../agents-studio/scene/types";
import { agentTintIndex, archetypeFor, ARCHETYPE_ROLE, moodCss, MOOD_LABEL, moodFor, type Mood } from "../agents-studio/studio-model";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { AgentAvatar } from "./AgentAvatar";
import { MAX_AGENTS, runFeed, type FeedLine } from "./office-model";
import type { OfficeHandle } from "./scene/office-engine";

const HIDE_KEY = "ts.agents.office.hidden";
const PREVIEW_MS = 30_000;
const LEGEND: ReadonlyArray<Mood> = ["working", "idle", "attention", "off"];

type Status = "loading" | "ready" | "unavailable";

const readHidden = () => {
  try {
    return localStorage.getItem(HIDE_KEY) === "1";
  } catch {
    return false;
  }
};

const ago = (at: number) => {
  const mins = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
};

export function AgentOffice({
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
  const [full, setFull] = useState(false);
  const [status, setStatus] = useState<Status>("loading");
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  const [caption, setCaption] = useState<{ id: string; text: string; simulated: boolean } | null>(null);
  const [life, setLife] = useState<FeedLine[]>([]);
  const [previews, setPreviews] = useState<ReadonlySet<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());

  const hostRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<OfficeHandle | null>(null);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    const map = timers.current;
    return () => {
      clearInterval(id);
      for (const timer of map.values()) clearTimeout(timer);
    };
  }, []);

  const agents = useMemo<StudioAgent[]>(
    () =>
      entries.slice(0, MAX_AGENTS).map((entry) => ({
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
  const runs = useMemo(() => runFeed(entries, 5), [entries]);

  /** Add a piece of office life to the feed, keeping the four most recent. */
  const pushLife = (agentId: string, text: string) => {
    const line: FeedLine = { key: `life-${agentId}-${Date.now()}`, agentId, agentName: byId.get(agentId)?.name ?? "An agent", text, at: Date.now(), kind: "life" };
    setLife((lines) => [line, ...lines].slice(0, 4));
  };
  const pushLifeRef = useRef(pushLife);
  pushLifeRef.current = pushLife;
  const stopPreview = (id: string) => setPreviews((p) => new Set([...p].filter((x) => x !== id)));

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
        const { createOffice } = await import("./scene/office-engine");
        if (cancelled || !hostRef.current) return;
        const handle = await createOffice(
          hostRef.current,
          {
            onHover: (id, x, y) => setHover(id ? { id, x, y } : null),
            onSelect: (id) => onSelectRef.current(id),
            onCaption: (id, text, simulated) => setCaption({ id, text, simulated }),
            onLife: (agentId, text) => pushLifeRef.current(agentId, text),
            onLost: () => setStatus("unavailable")
          },
          { reducedMotion: reduced, theme: currentTheme() }
        );
        if (cancelled) return handle.destroy();
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

  useEffect(() => handleRef.current?.setAgents(agents), [agents]);
  useEffect(() => handleRef.current?.select(selectedId), [selectedId]);
  useEffect(() => handleRef.current?.setWheelZoom(full), [full, status]);
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFull(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full]);

  const selected = selectedId ? byId.get(selectedId) : undefined;
  const hovered = hover ? byId.get(hover.id) : undefined;
  const selectedEntry = selectedId ? entries.find((e) => e.id === selectedId) : undefined;
  const reallyWorking = selectedEntry ? moodFor(selectedEntry, now, false) === "working" : false;

  const togglePreview = (id: string) => {
    const next = new Set(previews);
    const existing = timers.current.get(id);
    if (existing) clearTimeout(existing);
    timers.current.delete(id);
    if (next.has(id)) next.delete(id);
    else {
      next.add(id);
      timers.current.set(
        id,
        setTimeout(() => stopPreview(id), PREVIEW_MS)
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
          Show the office
        </Button>
      </div>
    );
  }

  const feed = [...life, ...runs];
  const glass = "border border-border bg-background/85 backdrop-blur";

  return (
    <section
      aria-label="The agents' office"
      data-office-status={status}
      data-tour="agent-studio"
      className={cn(
        "overflow-hidden border border-border bg-linear-to-b from-primary/5 via-background to-muted/40",
        full ? "fixed inset-0 z-50 rounded-none" : "relative h-[460px] rounded-2xl sm:h-[600px]"
      )}
    >
      <div ref={hostRef} className="absolute inset-0" aria-hidden="true" />

      {status !== "ready" && <Backdrop status={status} agents={agents} selectedId={selectedId} onSelect={onSelect} reduced={reduced} />}

      {/* Top bar: legend on the left, view controls on the right. */}
      <div className="pointer-events-none absolute inset-x-3 top-3 flex flex-wrap items-start justify-between gap-2">
        <ul className={cn("pointer-events-auto flex flex-wrap gap-x-3 gap-y-1 rounded-full px-3 py-1.5 text-[11px]", glass)} aria-label="What the colours mean">
          {LEGEND.map((mood) => (
            <li key={mood} className="flex items-center gap-1.5 text-muted-foreground">
              <span className="h-2 w-2 rounded-full" style={{ background: moodCss(mood) }} aria-hidden="true" />
              {MOOD_LABEL[mood]}
            </li>
          ))}
        </ul>
        <div className={cn("pointer-events-auto flex items-center gap-0.5 rounded-full p-0.5", glass)}>
          <IconButton label="Zoom in" onClick={() => handleRef.current?.zoom(0.8)} icon={<Plus className="h-3.5 w-3.5" />} />
          <IconButton label="Zoom out" onClick={() => handleRef.current?.zoom(1.25)} icon={<Minus className="h-3.5 w-3.5" />} />
          <IconButton
            label="Reset the view"
            onClick={() => {
              onSelect(null);
              handleRef.current?.resetView();
            }}
            icon={<RotateCcw className="h-3.5 w-3.5" />}
          />
          <IconButton
            label={full ? "Leave full screen" : "Full screen"}
            onClick={() => setFull((v) => !v)}
            icon={full ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          />
          {!full && <IconButton label="Hide the office" onClick={() => setHiddenPersist(true)} icon={<EyeOff className="h-3.5 w-3.5" />} />}
        </div>
      </div>

      {/* The feed: real runs, and office life labelled as such. */}
      {status === "ready" && feed.length > 0 && (
        <div className={cn("absolute right-3 top-14 hidden w-64 rounded-xl p-2.5 text-xs md:block", glass)} aria-label="Activity">
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Activity</p>
          <ul className="space-y-1.5" aria-live="polite">
            {feed.slice(0, 7).map((line) => (
              <li key={line.key} className="flex items-start gap-1.5">
                <span
                  className={cn(
                    "mt-px shrink-0 rounded px-1 text-[9px] font-semibold uppercase tracking-wide",
                    line.kind === "run" ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
                  )}
                >
                  {line.kind === "run" ? "Run" : "Idle"}
                </span>
                <button type="button" className="min-w-0 flex-1 text-left hover:underline" onClick={() => onSelect(line.agentId)}>
                  <span className="font-medium">{line.agentName}</span> <span className="text-muted-foreground">{line.text}</span>
                </button>
                <span className="shrink-0 tabular-nums text-muted-foreground">{ago(line.at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {hover && hovered && !selected && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-border bg-popover px-2.5 py-1.5 text-xs shadow-md"
          style={{ left: hover.x, top: Math.max(40, hover.y - 14) }}
        >
          <p className="font-medium">{hovered.name}</p>
          <p className="text-muted-foreground">
            {MOOD_LABEL[hovered.mood]} · {ARCHETYPE_ROLE[hovered.archetype]}
          </p>
        </div>
      )}

      {selected && (
        <div className={cn("absolute inset-x-3 bottom-3 z-10 animate-fade-in rounded-xl p-3 shadow-lg sm:inset-x-auto sm:left-3 sm:w-[26rem]", glass)}>
          <div className="flex items-start gap-2.5">
            <AgentAvatar name={selected.name} emoji={selected.emoji} tint={selected.tint} mood={selected.mood} size={40} animate={!reduced} />
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
            {caption?.id === selected.id && caption.simulated && (
              <span className="mt-px shrink-0 rounded bg-muted px-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">Simulated</span>
            )}
            <span className="min-w-0 text-foreground/90">{caption?.id === selected.id ? caption.text : "…"}</span>
          </p>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {!reallyWorking && (
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
            <Button
              size="sm"
              variant="ghost"
              className="h-8"
              onClick={() => {
                setFull(false);
                onOpenDetails(selected.id);
              }}
            >
              <ArrowDown className="mr-1.5 h-3.5 w-3.5" />
              Details
            </Button>
          </div>
        </div>
      )}

      {status === "ready" && !selected && (
        <p className={cn("pointer-events-none absolute bottom-3 left-3 hidden rounded-full px-3 py-1 text-[11px] text-muted-foreground sm:block", glass)}>
          Drag to look around · click a person to follow · click a ball to flick it
        </p>
      )}

      <ul className="sr-only" aria-label="Agents in the office">
        {agents.map((a) => (
          <li key={a.id}>
            <button type="button" onClick={() => onSelect(a.id === selectedId ? null : a.id)} aria-pressed={a.id === selectedId}>
              {a.name}, {MOOD_LABEL[a.mood]}, {ARCHETYPE_ROLE[a.archetype]}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function IconButton({ label, onClick, icon }: Readonly<{ label: string; onClick: () => void; icon: React.ReactNode }>) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="focus-ring grid h-7 w-7 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {icon}
    </button>
  );
}

/** While the 3D office loads, or when it cannot run: the same agents as portraits you can still pick. */
function Backdrop({
  status,
  agents,
  selectedId,
  onSelect,
  reduced
}: Readonly<{ status: Status; agents: readonly StudioAgent[]; selectedId: string | null; onSelect: (id: string | null) => void; reduced: boolean }>) {
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
                "focus-ring flex w-24 flex-col items-center gap-1.5 rounded-xl p-2 transition-all duration-200 sm:w-28",
                loading ? "opacity-40" : "hover:-translate-y-1 hover:bg-background/70",
                active && "bg-background/80 ring-2 ring-primary/60"
              )}
            >
              <AgentAvatar name={a.name} emoji={a.emoji} tint={a.tint} mood={loading ? "off" : a.mood} size={64} animate={!reduced && !loading} className={loading ? "animate-pulse" : undefined} />
              <span className="max-w-full truncate text-xs font-medium">{a.name}</span>
              <span className="text-[10px] text-muted-foreground">{loading ? "…" : MOOD_LABEL[a.mood]}</span>
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        {loading ? "Opening the office…" : "The 3D office needs a graphics card this browser can use — the same agents, flat."}
      </p>
    </div>
  );
}
