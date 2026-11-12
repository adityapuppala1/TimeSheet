/**
 * WHAT: the pure half of the Agents "Studio" — which CHARACTER an agent is, what MOOD it is in, and
 * where its workstation stands. No three.js, no DOM, no React: everything here is a function of the
 * roster data, so it is unit-tested and the 3D layer (scene/*) and the 2D fallback render the same
 * answers.
 *
 * WHY MOOD IS DERIVED FROM THE ROSTER AND NOT INVENTED: a character that looks busy while the agent is
 * switched off is a lie told by decoration. So the visuals follow facts the page already holds:
 *   off        — the agent is switched off. Powered down, dim, nothing simulated.
 *   idle       — on, nothing running. Calm; a trickle of ambient motion so the scene reads as alive.
 *   working    — a run is QUEUED or RUNNING right now, or the viewer pressed "Watch it work".
 *   attention  — its latest run FAILED / was BLOCKED / ended PARTIAL recently. Amber, not alarming.
 *   celebrating— its latest run COMPLETED moments ago. A short, earned flourish.
 * What happens on the stage while an agent "works" is an ILLUSTRATION of its job, not its real data —
 * the UI says so wherever it shows a simulated caption. The mood is the only part that is real.
 *
 * WHO CALLS THIS: components/agents-studio/AgentStudio.tsx, scene/engine.ts and pages/Agents.tsx
 * (which takes its avatar tint from `agentTintIndex` so the card, the portrait and the 3D body agree).
 */

export type Archetype = "triage" | "planner" | "risk" | "security" | "reporter" | "balancer" | "assistant";
export type Mood = "off" | "idle" | "working" | "attention" | "celebrating";

/** The slice of a roster entry the studio reads. `AgentRosterEntry` satisfies it. */
export interface RosterLike {
  enabled: boolean;
  templateKey: string | null;
  capabilities: ReadonlyArray<{ id: string }>;
  readiness: { enabledButInert: boolean };
  runs: { recent: ReadonlyArray<{ status: string; createdAt: string; finishedAt: string | null }> };
}

/* ------------------------------------------------------------------ characters */

const TEMPLATE_ARCHETYPE: Readonly<Record<string, Archetype>> = {
  triage: "triage",
  planner: "planner",
  "risk-watch": "risk",
  "security-desk": "security",
  reporter: "reporter",
  "load-balancer": "balancer"
};

/** Capability id → the character whose job it belongs to. A custom agent is built from these, so it
 *  becomes whichever character owns most of what it can do. */
const CAPABILITY_ARCHETYPE: Readonly<Record<string, Archetype>> = {
  triage: "triage",
  duplicate_detection: "triage",
  assignee_suggestion_explanation: "triage",
  plan_breakdown: "planner",
  schedule_adjustment: "planner",
  blueprint_instantiate: "planner",
  project_risk_narrative: "risk",
  risk_mitigation: "risk",
  security_finding_triage: "security",
  ci_failure_triage: "security",
  pr_review_summary: "security",
  weekly_digest: "reporter",
  security_weekly_digest: "reporter",
  bug_pattern_digest: "reporter",
  status_report: "reporter",
  assignment_rebalance: "balancer"
};

/** Which character an agent is: its template's, else the one that owns most of its capabilities,
 *  else the generic assistant (a custom agent with nothing recognisable). */
export function archetypeFor(entry: Pick<RosterLike, "templateKey" | "capabilities">): Archetype {
  const fromTemplate = entry.templateKey ? TEMPLATE_ARCHETYPE[entry.templateKey] : undefined;
  if (fromTemplate) return fromTemplate;
  const tally = new Map<Archetype, number>();
  for (const capability of entry.capabilities) {
    const owner = CAPABILITY_ARCHETYPE[capability.id];
    if (owner) tally.set(owner, (tally.get(owner) ?? 0) + 1);
  }
  let best: Archetype = "assistant";
  let bestCount = 0;
  for (const [archetype, count] of tally) {
    if (count > bestCount) {
      best = archetype;
      bestCount = count;
    }
  }
  return best;
}

/** How a character is introduced in words — the stage's caption and the screen-reader list. */
export const ARCHETYPE_ROLE: Readonly<Record<Archetype, string>> = {
  triage: "sorts what arrives",
  planner: "breaks work into a plan",
  risk: "watches project risk",
  security: "screens scanner findings",
  reporter: "writes the recaps",
  balancer: "balances the load",
  assistant: "lends a hand"
};

/* ------------------------------------------------------------------ colour */

/** The six avatar tints, as three.js hex numbers AND CSS strings — the same palette as the Tailwind
 *  `-300` swatches the roster cards use, so a card, its portrait and its 3D body are one colour. */
export const AGENT_PALETTE: ReadonlyArray<{ name: string; hex: number; css: string }> = [
  { name: "lime", hex: 0xbef264, css: "#bef264" },
  { name: "violet", hex: 0xc4b5fd, css: "#c4b5fd" },
  { name: "orange", hex: 0xfdba74, css: "#fdba74" },
  { name: "emerald", hex: 0x6ee7b7, css: "#6ee7b7" },
  { name: "sky", hex: 0x7dd3fc, css: "#7dd3fc" },
  { name: "pink", hex: 0xf9a8d4, css: "#f9a8d4" }
];

/** Stable index into the palette for a key. This is the hash `agentTint` always used — moved here so
 *  the 2D tint and the 3D body cannot drift apart. */
export function agentTintIndex(key: string): number {
  let hash = 0;
  for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) % 997;
  return hash % AGENT_PALETTE.length;
}

/* ------------------------------------------------------------------ mood */

/** How long a finished run keeps the celebration going. Long enough to be seen, short enough that
 *  "just finished" stays true. */
export const CELEBRATE_MS = 8_000;
/** How long a failed or blocked run keeps asking for attention. A day-old failure is history, not news. */
export const ATTENTION_WINDOW_MS = 6 * 60 * 60 * 1000;

const ATTENTION_STATUSES = new Set(["FAILED", "BLOCKED", "PARTIAL"]);

/**
 * What an agent is doing right now, from facts the roster already carries.
 *
 * `preview` is the viewer pressing "Watch it work": it is working on stage whatever the agent's real
 * state, including OFF — that is the point, previewing what it WOULD do before switching it on. The
 * caller labels it as a preview; it never changes the real mood.
 */
export function moodFor(entry: Pick<RosterLike, "enabled" | "readiness" | "runs">, now: number = Date.now(), preview = false): Mood {
  if (preview) return "working";
  if (!entry.enabled) return "off";

  const latest = [...entry.runs.recent].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  if (latest && (latest.status === "RUNNING" || latest.status === "QUEUED")) return "working";
  if (entry.readiness.enabledButInert) return "idle";

  if (latest) {
    const ended = Date.parse(latest.finishedAt ?? latest.createdAt);
    const age = now - ended;
    if (latest.status === "COMPLETED" && age >= 0 && age < CELEBRATE_MS) return "celebrating";
    if (ATTENTION_STATUSES.has(latest.status) && age < ATTENTION_WINDOW_MS) return "attention";
  }
  return "idle";
}

/** The status colour of each mood — the visor, the antenna light, the platform rim, and the 2D portrait. */
export const MOOD_HEX: Readonly<Record<Mood, number>> = {
  off: 0x475569,
  idle: 0x34d399,
  working: 0x38bdf8,
  attention: 0xfbbf24,
  celebrating: 0xf472b6
};

export const moodCss = (mood: Mood): string => `#${MOOD_HEX[mood].toString(16).padStart(6, "0")}`;

/** How much a station's simulation is doing, 0–1, for a mood. Idle is not zero on purpose: a stage
 *  that freezes the moment nothing is running reads as broken rather than calm. */
export const MOOD_INTENSITY: Readonly<Record<Mood, number>> = {
  off: 0,
  idle: 0.22,
  working: 1,
  attention: 0.4,
  celebrating: 0.75
};

export const MOOD_LABEL: Readonly<Record<Mood, string>> = {
  off: "Off",
  idle: "On duty",
  working: "Working",
  attention: "Needs a look",
  celebrating: "Just finished"
};

/* ------------------------------------------------------------------ layout */

export interface StationSlot {
  x: number;
  z: number;
  /** Radians about Y — stations turn slightly toward the middle so the row reads as a room. */
  rotY: number;
}

/** Stations in a row, wrapping to a second row behind from five up. Centred on x = 0. */
export const STATION_SPACING_X = 4.9;
export const STATION_SPACING_Z = 5.4;
export const MAX_STATIONS = 8;

export function layoutStations(count: number): StationSlot[] {
  const n = Math.min(Math.max(count, 0), MAX_STATIONS);
  const perRow = n > 4 ? Math.ceil(n / 2) : n;
  const slots: StationSlot[] = [];
  for (let i = 0; i < n; i += 1) {
    const row = Math.floor(i / perRow);
    const inRow = row === 0 ? Math.min(perRow, n) : n - perRow;
    const col = i - row * perRow;
    const x = (col - (inRow - 1) / 2) * STATION_SPACING_X;
    slots.push({ x, z: -row * STATION_SPACING_Z, rotY: -x * 0.035 });
  }
  return slots;
}

export interface CameraPose {
  position: [number, number, number];
  target: [number, number, number];
}

/** The camera that frames every station: far enough that the widest row fits the viewport's width
 *  (not just its height — a phone is tall and narrow), high enough to see over the front row. */
export function overviewPose(slots: readonly StationSlot[], aspect: number, fovDeg = 34): CameraPose {
  const xs = slots.map((s) => Math.abs(s.x));
  // 3.6 beyond the outermost centre: the platform (2.1) plus its glow, nameplate and a margin, so no station is cropped.
  const halfWidth = (xs.length ? Math.max(...xs) : 0) + 3.6;
  const zs = slots.map((s) => s.z);
  const backZ = zs.length ? Math.min(...zs) : 0;
  const halfHeightRad = (fovDeg * Math.PI) / 360;
  const byWidth = halfWidth / (Math.tan(halfHeightRad) * Math.max(0.3, aspect));
  const byHeight = 3.4 / Math.tan(halfHeightRad);
  const distance = Math.max(byWidth, byHeight, 8);
  const centreZ = backZ / 2;
  // The target sits above the floor so the whole stage — platforms and characters — lands in the middle of the frame.
  return { position: [0, 4.6 + distance * 0.16, centreZ + distance], target: [0, 1.7, centreZ] };
}

/**
 * The camera that fills the frame with one station — the click-to-focus move.
 *
 * On a wide viewport the station is framed RIGHT of centre (the camera looks left of it), leaving the
 * left third for the selection panel instead of letting the panel cover the conveyor. A narrow
 * viewport stacks the panel below, so there the station is centred.
 */
export function focusPose(slot: StationSlot, aspect: number, fovDeg = 34): CameraPose {
  const halfHeightRad = (fovDeg * Math.PI) / 360;
  const byWidth = 3.2 / (Math.tan(halfHeightRad) * Math.max(0.3, aspect));
  const distance = Math.max(byWidth, 8.4);
  const shift = aspect > 1.3 ? 1.5 : 0;
  return { position: [slot.x - shift, 3.6 + distance * 0.12, slot.z + distance], target: [slot.x - shift, 1.5, slot.z] };
}

/* ------------------------------------------------------------------ randomness */

/** A string to a 32-bit seed (FNV-1a). Determinism matters here: an agent's simulated shift must
 *  look the same on every visit, or the scene would seem to be inventing a new life each reload. */
export function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Small, fast, seedable PRNG returning [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
