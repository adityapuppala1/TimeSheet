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
 *   - Hand-offs, meetings and queue piles come from the last 24h of real runs (`activity`, see
 *     office-activity.ts); a colleague walking over to help a deep queue is a visual cue, labelled so.
 *   - The timeline replays those 24h in the office (moods then come from the events, not the roster);
 *     "Live" returns to now.
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
import { ArrowDown, Eye, EyeOff, Maximize2, Minimize2, Minus, Pause, Play, Plus, Power, Radio, RotateCcw, Square, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { isSoftwareWebGl } from "../../lib/webgl";
import { currentTheme, subscribeTheme } from "../../lib/theme";
import { useMediaQuery } from "../../lib/use-media-query";
import { cn } from "../../lib/utils";
import type { AgentRosterEntry, OfficeActivity } from "../../services/api";
import type { StudioAgent } from "../agents-studio/scene/types";
import { agentTintIndex, archetypeFor, ARCHETYPE_ROLE, moodCss, MOOD_LABEL, moodFor, type Mood } from "../agents-studio/studio-model";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { AgentAvatar } from "./AgentAvatar";
import { describeView, feedAt, replayBounds, viewAt } from "./office-activity";
import { MAX_AGENTS, runFeed, type FeedLine } from "./office-model";
import type { OfficeHandle } from "./scene/office-engine";

const HIDE_KEY = "ts.agents.office.hidden";
const PREVIEW_MS = 30_000;
const LEGEND: ReadonlyArray<Mood> = ["working", "idle", "attention", "off"];
/** Replay speeds: office time per real second. */
const SPEEDS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 60, label: "1 min/s" },
  { value: 300, label: "5 min/s" },
  { value: 900, label: "15 min/s" },
  { value: 3600, label: "1 h/s" }
];
const REPLAY_TICK_MS = 250;
const LIVE_HANDOFF_MS = 5 * 60_000;

/** The feed's run lines: the roster's recent runs live, or the runs as they stood at the replayed time. */
function feedFor(entries: readonly AgentRosterEntry[], activity: OfficeActivity | null, live: boolean, at: number): FeedLine[] {
  if (live) return runFeed(entries, 5);
  return feedAt(activity, at, (id) => entries.find((e) => e.id === id)?.name ?? "An agent");
}

/** What real activity shows at the office time, and each agent's mood then. */
function useOfficeState(
  entries: readonly AgentRosterEntry[],
  activity: OfficeActivity | null,
  o: {
    live: boolean;
    officeTime: number;
    now: number;
    speed: number;
    previews: ReadonlySet<string>;
  }
) {
  const { live, officeTime, now, speed, previews } = o;
  const view = useMemo(() => {
    const idleIds = entries.filter((e) => e.enabled && (!live || moodFor(e, now, false) === "idle")).map((e) => e.id);
    return viewAt(activity, officeTime, {
      live,
      handoffWindowMs: live ? LIVE_HANDOFF_MS : speed * 15_000,
      idleIds
    });
  }, [activity, officeTime, live, speed, entries, now]);
  const agents = useMemo<StudioAgent[]>(
    () =>
      entries.slice(0, MAX_AGENTS).map((entry) => ({
        id: entry.id,
        name: entry.name,
        emoji: entry.emoji,
        archetype: archetypeFor(entry),
        tint: agentTintIndex(entry.templateKey ?? entry.id),
        mood: live ? moodFor(entry, now, previews.has(entry.id)) : replayMood(entry, view.working),
        previewing: live && previews.has(entry.id)
      })),
    [entries, now, previews, live, view]
  );
  return { view, agents };
}

/** In replay, an agent's mood is what the events say it was doing then, not today's roster state. */
function replayMood(entry: AgentRosterEntry, working: ReadonlySet<string>): Mood {
  if (!entry.enabled) return "off";
  return working.has(entry.id) ? "working" : "idle";
}

/** "14:05", or "Sun 14:05" when it is not today — the replay spans two calendar days. */
const clockTime = (t: number) => {
  const d = new Date(t);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
};

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
  onOpenDetails,
  activity = null
}: Readonly<{
  entries: readonly AgentRosterEntry[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  canManage: boolean;
  busy: boolean;
  onToggle: (id: string, enabled: boolean) => void;
  onOpenDetails: (id: string) => void;
  /** GET /agents/office-activity: the last 24h of real runs; null while loading or unavailable. */
  activity?: OfficeActivity | null;
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
  /** null = live; otherwise the office time being replayed. */
  const [replayAt, setReplayAt] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(300);

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

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      setReplayAt((t) => {
        const next = (t ?? Date.now()) + REPLAY_TICK_MS * speed;
        if (next < Date.now()) return next;
        setPlaying(false);
        return null;
      });
    }, REPLAY_TICK_MS);
    return () => clearInterval(id);
  }, [playing, speed]);

  const live = replayAt === null;
  const officeTime = replayAt ?? now;
  const { view, agents } = useOfficeState(entries, activity, {
    live,
    officeTime,
    now,
    speed,
    previews
  });
  const byId = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const nameOf = (id: string) => byId.get(id)?.name ?? "An agent";
  const runs = useMemo(() => feedFor(entries, activity, live, officeTime), [entries, live, activity, officeTime]);
  const happening = describeView(view, nameOf);

  /** Add a piece of office life to the feed, keeping the four most recent. */
  const pushLife = (agentId: string, text: string, real = false) => {
    const line: FeedLine = {
      key: `life-${agentId}-${Date.now()}`,
      agentId,
      agentName: byId.get(agentId)?.name ?? "An agent",
      text,
      at: Date.now(),
      kind: real ? "run" : "life"
    };
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
            onLife: (agentId, text, real) => pushLifeRef.current(agentId, text, real),
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
  useEffect(() => handleRef.current?.setActivity(view), [view, status]);
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

  const feed = live ? [...life, ...runs] : runs;
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
        <ul data-office-keepout className={cn("pointer-events-auto flex flex-wrap gap-x-3 gap-y-1 rounded-full px-3 py-1.5 text-[11px]", glass)} aria-label="What the colours mean">
          {LEGEND.map((mood) => (
            <li key={mood} className="flex items-center gap-1.5 text-muted-foreground">
              <span className="h-2 w-2 rounded-full" style={{ background: moodCss(mood) }} aria-hidden="true" />
              {MOOD_LABEL[mood]}
            </li>
          ))}
        </ul>
        <div data-office-keepout className={cn("pointer-events-auto flex items-center gap-0.5 rounded-full p-0.5", glass)}>
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
      {status === "ready" && <FeedPanel feed={feed} live={live} officeTime={officeTime} className={glass} onSelect={onSelect} />}

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

      <ReplayControls
        activity={activity}
        hiddenOnPhone={Boolean(selected)}
        className={glass}
        now={now}
        at={officeTime}
        replayAt={replayAt}
        playing={playing}
        speed={speed}
        setReplayAt={setReplayAt}
        setPlaying={setPlaying}
        setSpeed={setSpeed}
      />

      {status === "ready" && !selected && (
        <p className={cn("pointer-events-none absolute bottom-3 left-3 hidden rounded-full px-3 py-1 text-[11px] text-muted-foreground xl:block", glass)}>
          Drag to look around · click a person to follow · click a ball to flick it
        </p>
      )}

      <HappeningList lines={happening} replayAt={replayAt} />

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

function FeedPanel({
  feed,
  live,
  officeTime,
  className,
  onSelect
}: Readonly<{
  feed: readonly FeedLine[];
  live: boolean;
  officeTime: number;
  className: string;
  onSelect: (id: string) => void;
}>) {
  if (live && feed.length === 0) return null;
  return (
    <div data-office-keepout className={cn("absolute right-3 top-14 hidden w-64 rounded-xl p-2.5 text-xs md:block", className)} aria-label="Activity">
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Activity</p>
      <ul className="space-y-1.5" aria-live="polite">
        {!live && <li className="text-[10px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">Replay · {clockTime(officeTime)}</li>}
        {!live && feed.length === 0 && <li className="text-muted-foreground">No runs yet at this time.</li>}
        {feed.slice(0, 7).map((line) => (
          <li key={line.key} className="flex items-start gap-1.5">
            <span className={cn("mt-px shrink-0 rounded px-1 text-[9px] font-semibold uppercase tracking-wide", line.kind === "run" ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground")}>
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
  );
}

function HappeningList({ lines, replayAt }: Readonly<{ lines: readonly string[]; replayAt: number | null }>) {
  const label = replayAt === null ? "What is happening in the office" : `What was happening at ${clockTime(replayAt)}`;
  return (
    <ul className="sr-only" aria-label={label}>
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

/** Wires the timeline to the office's replay state; renders nothing until activity has loaded. */
function ReplayControls({
  activity,
  hiddenOnPhone,
  className,
  now,
  at,
  replayAt,
  playing,
  speed,
  setReplayAt,
  setPlaying,
  setSpeed
}: Readonly<{
  activity: OfficeActivity | null;
  hiddenOnPhone: boolean;
  className: string;
  now: number;
  at: number;
  replayAt: number | null;
  playing: boolean;
  speed: number;
  setReplayAt: (t: number | null) => void;
  setPlaying: (fn: (p: boolean) => boolean) => void;
  setSpeed: (s: number) => void;
}>) {
  if (!activity) return null;
  const live = replayAt === null;
  const play = () => {
    if (live) setReplayAt(replayBounds(activity, Date.now()).from);
    setPlaying((p) => !p);
  };
  const goLive = () => {
    setPlaying(() => false);
    setReplayAt(null);
  };
  return (
    <Timeline
      className={cn(className, hiddenOnPhone && "hidden sm:flex")}
      activity={activity}
      now={now}
      at={at}
      live={live}
      playing={playing}
      speed={speed}
      onScrub={setReplayAt}
      onPlay={play}
      onSpeed={setSpeed}
      onLive={goLive}
    />
  );
}

/** The replay scrubber: the last 24h of real runs, played back in the office. */
function Timeline({
  className,
  activity,
  now,
  at,
  live,
  playing,
  speed,
  onScrub,
  onPlay,
  onSpeed,
  onLive
}: Readonly<{
  className: string;
  activity: OfficeActivity;
  now: number;
  at: number;
  live: boolean;
  playing: boolean;
  speed: number;
  onScrub: (t: number) => void;
  onPlay: () => void;
  onSpeed: (s: number) => void;
  onLive: () => void;
}>) {
  const { from, to } = replayBounds(activity, now);
  const span = Math.max(1, to - from);
  const value = Math.min(to, Math.max(from, at));
  return (
    <div
      role="group"
      aria-label="Replay the last 24 hours"
      className={cn("absolute bottom-3 right-3 z-10 flex w-[min(26rem,calc(100%-1.5rem))] items-center gap-2 rounded-xl px-2.5 py-2 text-xs", className)}
    >
      <button
        type="button"
        onClick={onPlay}
        aria-label={playing ? "Pause the replay" : "Play the replay"}
        aria-pressed={playing}
        className="focus-ring grid h-7 w-7 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
      </button>
      <div className="relative min-w-0 flex-1">
        {/* Hand-off ticks: where real work passed between agents. */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-0" aria-hidden="true">
          {activity.handoffs.map((h) => (
            <span key={`${h.fromRunId}>${h.toRunId}`} className="absolute -top-1 h-1.5 w-0.5 rounded bg-sky-500" style={{ left: `${((Date.parse(h.at) - from) / span) * 100}%` }} />
          ))}
        </div>
        <input
          type="range"
          min={from}
          max={to}
          step={60_000}
          value={value}
          onChange={(e) => onScrub(Number(e.target.value))}
          aria-label="Office time"
          aria-valuetext={live ? `Live, ${clockTime(now)}` : `Replaying ${clockTime(value)}`}
          className="block w-full accent-primary"
        />
      </div>
      <span className="shrink-0 whitespace-nowrap text-right tabular-nums text-muted-foreground">{clockTime(value)}</span>
      <label className="sr-only" htmlFor="office-replay-speed">
        Replay speed
      </label>
      <select
        id="office-replay-speed"
        value={speed}
        onChange={(e) => onSpeed(Number(e.target.value))}
        className="focus-ring h-7 shrink-0 rounded-md border border-border bg-background px-1 text-[11px]"
      >
        {SPEEDS.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={onLive}
        aria-pressed={live}
        aria-label={live ? "Showing live" : "Back to live"}
        className={cn(
          "focus-ring flex h-7 shrink-0 items-center gap-1 rounded-full px-2 font-medium transition-colors",
          live ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : "bg-muted text-foreground hover:bg-muted/70"
        )}
      >
        <Radio className="h-3 w-3" aria-hidden="true" />
        Live
      </button>
    </div>
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
