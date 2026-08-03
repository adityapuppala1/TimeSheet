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
 */
import type { FaceTrackerReading } from "./use-face-tracker";

export interface PoseTarget {
  axis: "yaw" | "pitch";
  /** Radians away from neutral, on `axis`. */
  minDelta: number;
  /** `null` accepts either direction. `1` / `-1` demands the signed delta match — used only to
   *  make the second side genuinely different from the first, never to claim it is "the left". */
  direction?: 1 | -1 | null;
  /** Require the demanded axis to move more than the other one. The verification challenge sets
   *  this because the server enforces it too; enrollment does not need to be that strict. */
  requireDominance?: boolean;
}

export interface AwaitPoseOptions {
  getReading: () => FaceTrackerReading | undefined;
  captureFrame: () => Promise<Blob | null>;
  neutral: { yaw: number; pitch: number };
  target: PoseTarget;
  windowMs: number;
  onProgress?: (progress: number) => void;
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
  /** True when the window ran out before the pose was reached. */
  timedOut: boolean;
}

const TICK_MS = 80;

export async function awaitPose(options: AwaitPoseOptions): Promise<AwaitPoseResult> {
  const { getReading, captureFrame, neutral, target, windowMs, onProgress, isCancelled, peakHoldMs = 400 } = options;
  const deadline = Date.now() + windowMs;
  let best: { blob: Blob; delta: number } | null = null;
  let crossedAt: number | null = null;

  while (Date.now() < deadline) {
    if (isCancelled?.()) break;
    const reading = getReading();
    if (reading && reading.faceCount === 1) {
      const signedYaw = reading.yaw - neutral.yaw;
      const signedPitch = reading.pitch - neutral.pitch;
      const signed = target.axis === "yaw" ? signedYaw : signedPitch;
      const onAxis = Math.abs(signed);
      const offAxis = target.axis === "yaw" ? Math.abs(signedPitch) : Math.abs(signedYaw);

      onProgress?.(Math.max(0, Math.min(1, onAxis / target.minDelta)));

      const directionOk = !target.direction || Math.sign(signed) === target.direction;
      const dominanceOk = !target.requireDominance || onAxis >= offAxis;

      if (onAxis >= target.minDelta && directionOk && dominanceOk) {
        const blob = await captureFrame();
        if (blob && (!best || onAxis > best.delta)) best = { blob, delta: onAxis };
        crossedAt ??= Date.now();
        if (Date.now() - crossedAt >= peakHoldMs) break;
      }
    }
    await new Promise((r) => setTimeout(r, TICK_MS));
  }

  onProgress?.(0);
  return { blob: best?.blob ?? null, delta: best?.delta ?? 0, timedOut: best === null };
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
