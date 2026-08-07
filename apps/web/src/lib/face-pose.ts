/**
 * Pose-driven capture: wait until the head is actually in the position that was asked for, then
 * take the frame — instead of taking a frame on a timer and judging it afterwards.
 *
 * Shared by the verification challenge and by guided enrollment, which want the same behaviour
 * for different reasons: the challenge needs proof that a demanded movement happened, enrollment
 * needs reference images that are genuinely different from one another.
 *
 * ON THE SIGN OF YAW, which drives the API here: the codebase deliberately does not trust Human's
 * yaw sign convention — it interacts with the mirrored preview and has never been calibrated
 * against real cameras, and a wrong guess would fail every honest user. So callers never ask for
 * "left"; they ask for "away from neutral on this axis" and, where two distinct poses are needed,
 * for "the other way from the previous one". That gets the variation enrollment wants without
 * asserting which physical direction a sign corresponds to.
 *
 * WHY `evaluatePose` IS A SEPARATE PURE FUNCTION rather than inline in the loop: it is the one
 * piece of arithmetic the meter, the shutter and the coaching copy must all agree on. When the
 * dialog kept its own copy of this loop, the copy fired at exactly the server's minimum while the
 * shared one fired above it, and the two disagreed about axis dominance — which is how a bar that
 * reads "done" ends up attached to a refused frame.
 */
import type { FaceTrackerReading } from "./use-face-tracker";

export interface PoseTarget {
  axis: "yaw" | "pitch";
  /** Radians away from neutral, on `axis`. The SERVER's number, passed down — never a client
   *  constant, so the two can't drift apart. */
  minDelta: number;
  /** `null` accepts either direction. `1` / `-1` demands the signed delta match — used only to
   *  make the second side genuinely different from the first, never to claim it is "the left". */
  direction?: 1 | -1 | null;
  /** Require the demanded axis to move more than the other one. The verification challenge sets
   *  this because the server enforces it too; enrollment does not need to be that strict. */
  requireDominance?: boolean;
  /**
   * Fire the shutter at `minDelta * fireMargin` rather than at `minDelta`.
   *
   * WHY IT EXISTS: the client measures pose from the preview stream and the server re-measures it
   * from the two JPEGs it receives, at a different instant and a different resolution. Firing
   * exactly on the line therefore lands a meaningful share of captures on the wrong side of it —
   * and a check refused after the meter filled reads as broken rather than strict, which is worse
   * than no meter at all. 1.15 is roughly 3° of extra yaw: unnoticeable to turn, comfortably
   * outside the disagreement.
   *
   * This TIGHTENS what the client submits. It cannot loosen anything: the server still measures
   * the delta itself and still decides.
   */
  fireMargin?: number;
}

/** Why the pose is not yet good enough to capture. Ordered by what to tell the person FIRST —
 *  see `evaluatePose`. */
export type PoseBlock =
  /** Satisfied — the frame is worth taking. */
  | "ready"
  | "no-face"
  | "multiple-faces"
  /** Moved on the demanded axis but the other way from the one asked for (enrollment's second side). */
  | "wrong-way"
  /** Moved, but the OTHER axis moved more — a tilt when a turn was asked for, or vice versa.
   *  The server enforces this too, so firing here would guarantee a rejection. */
  | "wrong-axis"
  /** Right movement, not far enough yet. The ordinary state while someone is turning. */
  | "short";

export interface PoseEvaluation {
  /** |delta| on the demanded axis. */
  onAxis: number;
  /** |delta| on the other axis. */
  offAxis: number;
  /**
   * 0-1 for the meter, measured against the FIRE point rather than the server's minimum, so a
   * full bar and a taken frame are the same event. The server's own line sits at
   * `1 / fireMargin` of the bar — meaning a bar that fills has already cleared it, and the person
   * is never left staring at 100% wondering why nothing happened.
   */
  progress: number;
  block: PoseBlock;
}

const DEFAULT_FIRE_MARGIN = 1;

/** Pure — no camera, no clock. The meter, the shutter and the coaching copy all read this. */
export function evaluatePose(
  reading: FaceTrackerReading | undefined,
  neutral: { yaw: number; pitch: number },
  target: PoseTarget
): PoseEvaluation {
  const empty = { onAxis: 0, offAxis: 0, progress: 0 };
  if (!reading || reading.faceCount === 0) return { ...empty, block: "no-face" };
  if (reading.faceCount > 1) return { ...empty, block: "multiple-faces" };

  const signedYaw = reading.yaw - neutral.yaw;
  const signedPitch = reading.pitch - neutral.pitch;
  const signed = target.axis === "yaw" ? signedYaw : signedPitch;
  const onAxis = Math.abs(signed);
  const offAxis = Math.abs(target.axis === "yaw" ? signedPitch : signedYaw);

  const fireAt = target.minDelta * (target.fireMargin ?? DEFAULT_FIRE_MARGIN);
  const progress = fireAt > 0 ? Math.max(0, Math.min(1, onAxis / fireAt)) : 0;

  // Direction before dominance: when the wizard has asked for "the other side", moving the wrong
  // way is the more specific and more actionable complaint of the two.
  if (target.direction && onAxis > 0.05 && Math.sign(signed) !== target.direction) {
    return { onAxis, offAxis, progress, block: "wrong-way" };
  }
  // Only complain about the axis once there is enough movement for the comparison to mean
  // anything — at rest both deltas are noise, and whichever is larger is a coin toss.
  if (target.requireDominance && onAxis > 0.05 && offAxis > onAxis) {
    return { onAxis, offAxis, progress, block: "wrong-axis" };
  }
  return { onAxis, offAxis, progress, block: onAxis >= fireAt ? "ready" : "short" };
}

export interface AwaitPoseOptions {
  getReading: () => FaceTrackerReading | undefined;
  captureFrame: () => Promise<Blob | null>;
  neutral: { yaw: number; pitch: number };
  target: PoseTarget;
  windowMs: number;
  /** Called every tick with the meter value AND why it is stuck, so the caller can coach rather
   *  than just render a bar. */
  onProgress?: (progress: number, block: PoseBlock) => void;
  /** Polled so a closed dialog or a cancelled wizard stops immediately. */
  isCancelled?: () => boolean;
  /** How long to keep watching after the threshold is first crossed, looking for the peak.
   *  People overshoot and settle back, so the frame taken the instant the line is crossed is the
   *  shallowest qualifying angle rather than the clearest one. */
  peakHoldMs?: number;
}

export interface AwaitPoseResult {
  blob: Blob | null;
  /** The delta actually achieved on the demanded axis, for diagnostics and UI copy. */
  delta: number;
  /** The best delta seen on the demanded axis even if nothing qualified — this is what lets a
   *  timeout say "you got about halfway" instead of "we didn't see the movement", which is the
   *  difference between a person learning what to do and a person giving up. */
  bestAttemptDelta: number;
  /** What was blocking most of the time. `"short"` means "turn further"; `"wrong-axis"` means
   *  "you tilted when we asked you to turn". */
  block: PoseBlock;
  /** True when the window ran out before the pose was reached. */
  timedOut: boolean;
}

const TICK_MS = 80;

export async function awaitPose(options: AwaitPoseOptions): Promise<AwaitPoseResult> {
  const { getReading, captureFrame, neutral, target, windowMs, onProgress, isCancelled, peakHoldMs = 400 } = options;
  const deadline = Date.now() + windowMs;
  let best: { blob: Blob; delta: number } | null = null;
  let bestAttemptDelta = 0;
  let crossedAt: number | null = null;
  // The blocker seen most often, not the last one — a single frame where the face was momentarily
  // lost should not become the explanation for a whole failed window.
  const blockTally: Partial<Record<PoseBlock, number>> = {};

  while (Date.now() < deadline) {
    if (isCancelled?.()) break;
    const evaluation = evaluatePose(getReading(), neutral, target);
    onProgress?.(evaluation.progress, evaluation.block);
    blockTally[evaluation.block] = (blockTally[evaluation.block] ?? 0) + 1;
    if (evaluation.onAxis > bestAttemptDelta) bestAttemptDelta = evaluation.onAxis;

    if (evaluation.block === "ready") {
      const blob = await captureFrame();
      if (blob && (!best || evaluation.onAxis > best.delta)) best = { blob, delta: evaluation.onAxis };
      crossedAt ??= Date.now();
      if (Date.now() - crossedAt >= peakHoldMs) break;
    }
    await new Promise((r) => setTimeout(r, TICK_MS));
  }

  onProgress?.(0, best ? "ready" : "short");
  return {
    blob: best?.blob ?? null,
    delta: best?.delta ?? 0,
    bestAttemptDelta,
    block: best ? "ready" : dominantBlock(blockTally),
    timedOut: best === null
  };
}

/** The blocker that held for the largest share of the window, ignoring the "ready" ticks that by
 *  definition weren't blocking. */
function dominantBlock(tally: Partial<Record<PoseBlock, number>>): PoseBlock {
  let winner: PoseBlock = "short";
  let most = 0;
  for (const [block, count] of Object.entries(tally) as [PoseBlock, number][]) {
    if (block === "ready") continue;
    if (count > most) {
      most = count;
      winner = block;
    }
  }
  return winner;
}

/** Waits for the head to be roughly still and facing forward — the enrollment baseline every
 *  other pose is measured against. */
export async function awaitNeutral(options: {
  getReading: () => FaceTrackerReading | undefined;
  windowMs: number;
  isCancelled?: () => boolean;
}): Promise<{ yaw: number; pitch: number } | null> {
  const deadline = Date.now() + options.windowMs;
  let steadyTicks = 0;
  let last: { yaw: number; pitch: number } | null = null;

  while (Date.now() < deadline) {
    if (options.isCancelled?.()) return null;
    const reading = options.getReading();
    // Quality is part of the gate: enrollment is the one place a weak frame must never be stored,
    // because every future check is measured against it.
    if (reading && reading.faceCount === 1 && reading.quality > 0.55 && Math.abs(reading.yaw) < 0.2 && Math.abs(reading.pitch) < 0.2) {
      if (last && Math.abs(reading.yaw - last.yaw) < 0.06 && Math.abs(reading.pitch - last.pitch) < 0.06) steadyTicks += 1;
      else steadyTicks = 0;
      last = { yaw: reading.yaw, pitch: reading.pitch };
      if (steadyTicks >= 4) return last;
    } else {
      steadyTicks = 0;
      last = null;
    }
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
  return null;
}

/**
 * The single line of coaching to show for a given blocker. Lives here rather than in a component
 * because the challenge dialog and the enrollment wizard must not invent different wording for
 * the same measured condition — that inconsistency is what makes guidance read as guesswork.
 */
export function poseCoaching(block: PoseBlock, axis: "yaw" | "pitch", progress: number): string {
  switch (block) {
    case "no-face":
      return "Keep your face in view";
    case "multiple-faces":
      return "More than one face in view — make sure you're alone";
    case "wrong-way":
      return "The other way";
    case "wrong-axis":
      return axis === "yaw" ? "Turn your head, don't tilt it" : "Tilt your head up, keep facing the camera";
    case "ready":
      return "Got it — hold there";
    default:
      return progress > 0.6
        ? "Almost — a little further"
        : axis === "yaw"
          ? "Keep turning until the bar fills"
          : "Keep tilting up until the bar fills";
  }
}
