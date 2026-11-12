/**
 * The Agents Studio's decisions, pinned as pure functions — the parts that would be wrong in a way a
 * screenshot cannot show.
 *
 * MOOD is the honest one. A character that looks busy while its agent is switched off is a lie told
 * by decoration, so every state is derived from the roster and these tests hold each rule, including
 * the edges: a finished run stops being "just finished", an old failure stops asking for attention,
 * and "Watch it work" overrides everything including OFF without changing what is real.
 */
import { describe, expect, it } from "vitest";

import {
  AGENT_PALETTE,
  agentTintIndex,
  archetypeFor,
  ATTENTION_WINDOW_MS,
  CELEBRATE_MS,
  focusPose,
  hashSeed,
  layoutStations,
  MAX_STATIONS,
  MOOD_HEX,
  moodCss,
  moodFor,
  mulberry32,
  overviewPose,
  type RosterLike
} from "../../src/components/agents-studio/studio-model";

const NOW = Date.parse("2026-11-12T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const entry = (over: Partial<RosterLike> = {}): RosterLike => ({
  enabled: true,
  templateKey: null,
  capabilities: [],
  readiness: { enabledButInert: false },
  runs: { recent: [] },
  ...over
});

const run = (status: string, createdMsAgo: number, finishedMsAgo: number | null = createdMsAgo) => ({
  status,
  createdAt: ago(createdMsAgo),
  finishedAt: finishedMsAgo === null ? null : ago(finishedMsAgo)
});

describe("archetypeFor", () => {
  it("uses the template's character", () => {
    expect(archetypeFor({ templateKey: "triage", capabilities: [] })).toBe("triage");
    expect(archetypeFor({ templateKey: "risk-watch", capabilities: [] })).toBe("risk");
    expect(archetypeFor({ templateKey: "security-desk", capabilities: [] })).toBe("security");
    expect(archetypeFor({ templateKey: "load-balancer", capabilities: [] })).toBe("balancer");
  });

  it("gives a custom agent the character that owns most of its capabilities", () => {
    const caps = [{ id: "weekly_digest" }, { id: "status_report" }, { id: "triage" }];
    expect(archetypeFor({ templateKey: null, capabilities: caps })).toBe("reporter");
  });

  it("falls back to the generic assistant when nothing is recognisable", () => {
    expect(archetypeFor({ templateKey: null, capabilities: [] })).toBe("assistant");
    expect(archetypeFor({ templateKey: null, capabilities: [{ id: "something_new" }] })).toBe("assistant");
    expect(archetypeFor({ templateKey: "unknown-template", capabilities: [] })).toBe("assistant");
  });
});

describe("moodFor — derived from the roster, never invented", () => {
  it("is off whenever the agent is switched off, whatever its runs say", () => {
    expect(moodFor(entry({ enabled: false, runs: { recent: [run("RUNNING", 1000, null)] } }), NOW)).toBe("off");
  });

  it("is working while a run is queued or running", () => {
    expect(moodFor(entry({ runs: { recent: [run("RUNNING", 5000, null)] } }), NOW)).toBe("working");
    expect(moodFor(entry({ runs: { recent: [run("QUEUED", 1000, null)] } }), NOW)).toBe("working");
  });

  it("judges by the NEWEST run, not the order the API happened to list them", () => {
    const old = run("FAILED", 3 * 3_600_000);
    const fresh = run("RUNNING", 2000, null);
    expect(moodFor(entry({ runs: { recent: [old, fresh] } }), NOW)).toBe("working");
    expect(moodFor(entry({ runs: { recent: [fresh, old] } }), NOW)).toBe("working");
  });

  it("celebrates a run that finished moments ago — and only moments", () => {
    expect(moodFor(entry({ runs: { recent: [run("COMPLETED", 60_000, CELEBRATE_MS - 1)] } }), NOW)).toBe("celebrating");
    expect(moodFor(entry({ runs: { recent: [run("COMPLETED", 60_000, CELEBRATE_MS + 1)] } }), NOW)).toBe("idle");
  });

  it("asks for attention after a failed, blocked or partial run, until it is history", () => {
    for (const status of ["FAILED", "BLOCKED", "PARTIAL"]) {
      expect(moodFor(entry({ runs: { recent: [run(status, 3_600_000)] } }), NOW), status).toBe("attention");
    }
    expect(moodFor(entry({ runs: { recent: [run("FAILED", ATTENTION_WINDOW_MS + 60_000)] } }), NOW)).toBe("idle");
  });

  it("stays idle when it is on but nothing can act, rather than looking busy", () => {
    expect(moodFor(entry({ readiness: { enabledButInert: true }, runs: { recent: [run("COMPLETED", 1000)] } }), NOW)).toBe("idle");
  });

  it("is idle with no runs at all", () => {
    expect(moodFor(entry(), NOW)).toBe("idle");
  });

  it("'Watch it work' previews working even for an agent that is off — without needing it to be real", () => {
    expect(moodFor(entry({ enabled: false }), NOW, true)).toBe("working");
    expect(moodFor(entry({ enabled: false }), NOW, false)).toBe("off");
  });
});

describe("agentTintIndex", () => {
  it("is stable and always lands inside the palette", () => {
    expect(agentTintIndex("triage")).toBe(agentTintIndex("triage"));
    for (const key of ["triage", "planner", "a-very-long-custom-agent-id-1234", ""]) {
      const i = agentTintIndex(key);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(AGENT_PALETTE.length);
    }
  });
});

describe("layoutStations", () => {
  it("centres a single row on x = 0", () => {
    const slots = layoutStations(3);
    expect(slots).toHaveLength(3);
    expect(slots[0].x).toBeCloseTo(-slots[2].x);
    expect(slots[1].x).toBeCloseTo(0);
    expect(new Set(slots.map((s) => s.z)).size).toBe(1);
  });

  it("wraps to a second row behind from five up, and keeps each row centred", () => {
    const slots = layoutStations(6);
    expect(slots).toHaveLength(6);
    const rows = new Set(slots.map((s) => s.z));
    expect(rows.size).toBe(2);
    for (const z of rows) {
      const xs = slots.filter((s) => s.z === z).map((s) => s.x);
      expect(xs.reduce((a, b) => a + b, 0)).toBeCloseTo(0);
    }
  });

  it("never lays out more than the studio can show", () => {
    expect(layoutStations(50)).toHaveLength(MAX_STATIONS);
    expect(layoutStations(0)).toEqual([]);
  });
});

describe("camera poses", () => {
  it("backs off on a narrow viewport so the widest row still fits", () => {
    const slots = layoutStations(4);
    const wide = overviewPose(slots, 2.2);
    const phone = overviewPose(slots, 0.6);
    expect(phone.position[2]).toBeGreaterThan(wide.position[2]);
  });

  it("frames the focused station beside the selection panel on a wide viewport, and centred on a narrow one", () => {
    const slot = layoutStations(4)[2];
    const wide = focusPose(slot, 1.6);
    expect(wide.target[0]).toBeCloseTo(slot.x - 1.5); // right of centre: the panel gets the left third
    expect(wide.position[2]).toBeGreaterThan(slot.z);
    const phone = focusPose(slot, 0.6);
    expect(phone.target[0]).toBeCloseTo(slot.x); // the panel stacks below, so the station is centred
  });

  it("keeps every station inside the frame: the overview is wide enough for the outermost platform", () => {
    const slots = layoutStations(7);
    const pose = overviewPose(slots, 2);
    const halfHeightRad = (34 * Math.PI) / 360;
    const visibleHalfWidth = Math.tan(halfHeightRad) * 2 * (pose.position[2] - slots.reduce((m, s) => Math.min(m, s.z), 0));
    const outermost = Math.max(...slots.map((s) => Math.abs(s.x))) + 2.1;
    expect(visibleHalfWidth).toBeGreaterThan(outermost);
  });
});

describe("seeded randomness", () => {
  it("replays the same sequence for the same seed, so a simulated shift looks the same every visit", () => {
    const a = mulberry32(hashSeed("agent-1"));
    const b = mulberry32(hashSeed("agent-1"));
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it("differs between agents and stays in [0, 1)", () => {
    const a = mulberry32(hashSeed("agent-1"));
    const b = mulberry32(hashSeed("agent-2"));
    expect(a()).not.toBe(b());
    for (let i = 0; i < 200; i += 1) {
      const v = a();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("mood colours", () => {
  it("has one colour per mood, as a valid CSS hex the 2D portrait can use", () => {
    for (const mood of ["off", "idle", "working", "attention", "celebrating"] as const) {
      expect(MOOD_HEX[mood]).toBeGreaterThan(0);
      expect(moodCss(mood)).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(moodCss("working")).toBe("#38bdf8");
  });
});
