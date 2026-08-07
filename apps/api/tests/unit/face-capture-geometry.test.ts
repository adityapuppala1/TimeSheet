/**
 * The BROWSER-side pose and framing arithmetic — apps/web/src/lib/face-pose.ts and the pure
 * scoring half of apps/web/src/lib/use-face-tracker.ts.
 *
 * WHY A WEB MODULE IS TESTED FROM THE API PACKAGE: apps/web has no test runner (its `lint` script
 * is `tsc -b --noEmit`), and this is the one piece of client code where being wrong is expensive
 * rather than cosmetic. It decides when the shutter fires during the liveness challenge, and the
 * measured history of this feature is that a client which disagrees with the server about where
 * the line is produces a meter that reads "done" attached to a frame the server then refuses.
 * Both modules are pure — no React, no DOM, no canvas; `face-pose` imports its only dependency as
 * `import type`, which erases — so they load here with nothing mocked.
 *
 * These test GUIDANCE, not a security control. Nothing here can admit a verification: the server
 * re-measures every delta from the submitted frames (face.service.ts#verifyChallengePose, tested
 * in face.service.test.ts) and decides on its own numbers regardless.
 */
import { describe, expect, it } from "vitest";
import { evaluatePose, poseCoaching, type PoseTarget } from "../../../web/src/lib/face-pose.js";
import { scoreFrame } from "../../../web/src/lib/use-face-tracker.js";

const reading = (over: Partial<{ faceCount: number; yaw: number; pitch: number }> = {}) => ({
  faceCount: 1,
  box: null,
  yaw: 0,
  pitch: 0,
  roll: 0,
  quality: 0.8,
  hint: null,
  confidence: 0.9,
  ...over
});

const NEUTRAL = { yaw: 0, pitch: 0 };
/** The server's real numbers, as /face/challenge publishes them. */
const YAW_TARGET: PoseTarget = { axis: "yaw", minDelta: 0.35, requireDominance: true, fireMargin: 1.15 };
const PITCH_TARGET: PoseTarget = { axis: "pitch", minDelta: 0.22, requireDominance: true, fireMargin: 1.15 };

describe("evaluatePose", () => {
  it("does not fire below the server's own minimum", () => {
    // 0.09 rad: the mean of the 19 measured real-browser challenge failures.
    const short = evaluatePose(reading({ yaw: 0.09 }), NEUTRAL, YAW_TARGET);
    expect(short.block).toBe("short");
    expect(short.progress).toBeGreaterThan(0);
    expect(short.progress).toBeLessThan(1);
  });

  it("waits for the fire margin rather than firing exactly on the server's line", () => {
    // Above the server's 0.35 but below the client's 0.4025 fire point. Firing here is what
    // produced refusals after a full bar, because the server re-measures from a different frame.
    expect(evaluatePose(reading({ yaw: 0.36 }), NEUTRAL, YAW_TARGET).block).toBe("short");
    expect(evaluatePose(reading({ yaw: 0.41 }), NEUTRAL, YAW_TARGET).block).toBe("ready");
  });

  it("fills the bar exactly when the shutter fires, never before", () => {
    // The invariant the whole meter rests on: progress===1 and block==="ready" are one event, so
    // nobody is ever left staring at a full bar wondering why nothing happened.
    for (const yaw of [0, 0.1, 0.2, 0.3, 0.35, 0.36, 0.4, 0.4025, 0.5, 0.9]) {
      const e = evaluatePose(reading({ yaw }), NEUTRAL, YAW_TARGET);
      expect(e.progress >= 1).toBe(e.block === "ready");
    }
  });

  it("mirrors the server's axis-dominance rule instead of submitting a doomed frame", () => {
    // Turned far enough but tilted further — the server refuses this, so the client must not fire.
    const tilted = evaluatePose(reading({ yaw: 0.5, pitch: 0.7 }), NEUTRAL, YAW_TARGET);
    expect(tilted.block).toBe("wrong-axis");

    const nodded = evaluatePose(reading({ yaw: 0.6, pitch: 0.3 }), NEUTRAL, PITCH_TARGET);
    expect(nodded.block).toBe("wrong-axis");
  });

  it("does not cry wrong-axis over noise at rest", () => {
    // At neutral both deltas are jitter and whichever is larger is a coin toss. Coaching somebody
    // to "turn, don't tilt" before they have moved at all is noise that discredits the guidance.
    expect(evaluatePose(reading({ yaw: 0.004, pitch: 0.02 }), NEUTRAL, YAW_TARGET).block).toBe("short");
  });

  it("measures against the neutral pose, not against zero", () => {
    // The baseline is wherever the person's head actually was, which is rarely dead centre — a
    // laptop on a desk sits below eye line and every pitch reading is offset by it.
    const offsetNeutral = { yaw: 0.2, pitch: -0.15 };
    expect(evaluatePose(reading({ yaw: 0.2, pitch: -0.15 }), offsetNeutral, YAW_TARGET).progress).toBe(0);
    expect(evaluatePose(reading({ yaw: 0.61, pitch: -0.15 }), offsetNeutral, YAW_TARGET).block).toBe("ready");
  });

  it("is direction-agnostic unless a direction is demanded", () => {
    // Human's yaw SIGN is uncalibrated in this codebase, so "either way" is the honest default.
    expect(evaluatePose(reading({ yaw: 0.5 }), NEUTRAL, YAW_TARGET).block).toBe("ready");
    expect(evaluatePose(reading({ yaw: -0.5 }), NEUTRAL, YAW_TARGET).block).toBe("ready");

    // Enrollment's second side is the one case that demands a sign, and only relative to the first.
    const otherWay: PoseTarget = { axis: "yaw", minDelta: 0.26, direction: -1 };
    expect(evaluatePose(reading({ yaw: 0.3 }), NEUTRAL, otherWay).block).toBe("wrong-way");
    expect(evaluatePose(reading({ yaw: -0.3 }), NEUTRAL, otherWay).block).toBe("ready");
  });

  it("reports lost and crowded frames rather than scoring them", () => {
    expect(evaluatePose(reading({ faceCount: 0 }), NEUTRAL, YAW_TARGET).block).toBe("no-face");
    expect(evaluatePose(undefined, NEUTRAL, YAW_TARGET).block).toBe("no-face");
    // Multi-face is the SERVER's refusal; warning here just means the person can step aside
    // before submitting rather than after being rejected.
    expect(evaluatePose(reading({ faceCount: 2, yaw: 0.5 }), NEUTRAL, YAW_TARGET).block).toBe("multiple-faces");
  });

  it("defaults to no fire margin, so enrollment is not silently made stricter", () => {
    const plain: PoseTarget = { axis: "yaw", minDelta: 0.26 };
    expect(evaluatePose(reading({ yaw: 0.26 }), NEUTRAL, plain).block).toBe("ready");
  });
});

describe("poseCoaching", () => {
  it("gives a different instruction for each blocker", () => {
    const blocks = ["no-face", "multiple-faces", "wrong-way", "wrong-axis", "ready", "short"] as const;
    const lines = blocks.map((b) => poseCoaching(b, "yaw", 0.2));
    expect(new Set(lines).size).toBe(blocks.length);
    expect(lines.every((l) => l.length > 0)).toBe(true);
  });

  it("names the right movement per axis, since 'turn' and 'tilt' are the mistake being corrected", () => {
    expect(poseCoaching("wrong-axis", "yaw", 0.5)).toMatch(/turn/i);
    expect(poseCoaching("wrong-axis", "yaw", 0.5)).toMatch(/tilt/i);
    expect(poseCoaching("wrong-axis", "pitch", 0.5)).toMatch(/tilt/i);
    expect(poseCoaching("short", "pitch", 0.1)).toMatch(/tilt/i);
    expect(poseCoaching("short", "yaw", 0.1)).toMatch(/turn/i);
  });
});

describe("scoreFrame", () => {
  const good = { areaShare: 0.08, offset: 0.05, sharpness: 0.8, luminance: 0.5, faceCount: 1 };

  it("stays quiet when the frame is already good", () => {
    const { hint, quality } = scoreFrame(good);
    expect(hint).toBeNull();
    expect(quality).toBeGreaterThan(0.7);
  });

  it("explains an empty frame by its exposure — the only thing measurable without a face box", () => {
    // "No face detected" is advice nobody can act on when the real problem is the blinds, and
    // NO_FACE is the second-largest recorded refusal.
    expect(scoreFrame({ ...good, faceCount: 0, luminance: 0.05 }).hint).toMatch(/dark/i);
    expect(scoreFrame({ ...good, faceCount: 0, luminance: 0.95 }).hint).toMatch(/bright/i);
    expect(scoreFrame({ ...good, faceCount: 0, luminance: 0.5 }).hint).toMatch(/face the camera/i);
  });

  it("warns about a second face ahead of anything else fixable", () => {
    // The server refuses on faceCount>1 regardless of framing, so no other advice matters yet.
    expect(scoreFrame({ ...good, faceCount: 2, areaShare: 0.01, sharpness: 0.1 }).hint).toMatch(/one face/i);
  });

  it("gives one instruction at a time, lighting first", () => {
    // Lighting is upstream of the rest: a dark room is why the face is small and soft in the
    // first place, so leading with "move closer" sends the person after the wrong problem.
    expect(scoreFrame({ ...good, luminance: 0.05, areaShare: 0.01, sharpness: 0.1 }).hint).toMatch(/dark/i);
    expect(scoreFrame({ ...good, areaShare: 0.01, sharpness: 0.1 }).hint).toMatch(/closer/i);
    expect(scoreFrame({ ...good, offset: 0.4, sharpness: 0.1 }).hint).toMatch(/centre/i);
    expect(scoreFrame({ ...good, sharpness: 0.1 }).hint).toMatch(/blurry/i);
    expect(scoreFrame({ ...good, areaShare: 0.6 }).hint).toMatch(/back/i);
  });

  it("scores framing continuously, so the quality ring can't jump between extremes", () => {
    const far = scoreFrame({ ...good, areaShare: 0.02 }).quality;
    const near = scoreFrame({ ...good, areaShare: 0.09 }).quality;
    const offCentre = scoreFrame({ ...good, offset: 0.25 }).quality;
    expect(far).toBeLessThan(near);
    expect(offCentre).toBeLessThan(near);
    for (const q of [far, near, offCentre]) {
      expect(q).toBeGreaterThanOrEqual(0);
      expect(q).toBeLessThanOrEqual(1);
    }
  });
});
