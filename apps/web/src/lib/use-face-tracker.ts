/**
 * WHAT: live, in-browser face tracking for the camera surfaces — where the face is, how big, how
 * sharp, and which way the head is turned, at ~12-15fps.
 *
 * WHY THIS EXISTS AT ALL, and it is worth being precise because the answer shaped the design:
 * the server already judges every capture. This does not second-guess it and it CANNOT — no
 * embedding is computed here, no match is decided here, and nothing this file returns is trusted
 * by the API. Its entire job is to answer "is now a good moment to press the shutter, and if not,
 * what should I tell the person to do?".
 *
 * That question was previously unanswerable, and the cost was measurable. In production data, the
 * head-turn challenge failed 107 times against 69 passes, with recorded yaw deltas of 0.02-0.26
 * radians against a 0.35 requirement. People were not refusing to turn their heads; they had no
 * way to know how far was far enough, because the instruction was static text and the frame was
 * grabbed at a moment they could not see coming. A meter that fills as you turn, and fires the
 * instant you cross the line, replaces a blind guess with a closed loop.
 *
 * WHY ONLY blazeface + facemesh: detection and pose are all the client is allowed to act on, and
 * they are 2.1MB together. The embedding model is 7MB and would buy the client nothing it may
 * legitimately use. See scripts/copy-face-models.mjs.
 *
 * DEGRADATION IS A FIRST-CLASS PATH, not an afterthought. WebGL can be unavailable (locked-down
 * corporate browsers, some VMs, older mobile Safari), the models can 404 behind a proxy that
 * mangles .bin, and a low-end phone can be too slow to be useful. In every one of those cases
 * `status` becomes "unavailable" and the caller falls back to the manual shutter, which is
 * exactly today's behaviour. Nothing about this may become load-bearing for taking a photo.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export type TrackerStatus = "idle" | "loading" | "tracking" | "unavailable";

export interface FaceTrackerReading {
  /** How many faces are in frame. >1 is a refusal condition server-side, so we warn early. */
  faceCount: number;
  /** Face box in *normalised* 0-1 coordinates, so it overlays correctly at any render size. */
  box: { x: number; y: number; width: number; height: number } | null;
  /** Head rotation in radians. Sign convention is NOT relied on anywhere — see the challenge
   *  code and face.service.ts for why only |delta| and axis dominance are trusted. */
  yaw: number;
  pitch: number;
  roll: number;
  /** 0-1 framing/size/sharpness composite. Mirrors the server's scoreQuality closely enough to
   *  agree on the borderline cases, which is all it needs to do. */
  quality: number;
  /** The single most useful thing to tell the person right now, or null when they're good. */
  hint: string | null;
  /** Detector confidence for the primary face. */
  confidence: number;
}

const EMPTY: FaceTrackerReading = {
  faceCount: 0,
  box: null,
  yaw: 0,
  pitch: 0,
  roll: 0,
  quality: 0,
  hint: "Looking for you — face the camera",
  confidence: 0
};

/**
 * Shared across every mount. Human loads ~2MB of weights and compiles WebGL shaders on first use;
 * doing that once per dialog open would put a visible stall on a flow whose whole problem is that
 * it feels slow. The instance is stateless between detect() calls, so sharing is safe.
 */
let humanPromise: Promise<any> | null = null;

async function getHuman(): Promise<any> {
  if (humanPromise) return humanPromise;
  humanPromise = (async () => {
    const { Human } = await import("@vladmandic/human");
    const human = new Human({
      // Same-origin, copied at build time — never a CDN. See copy-face-models.mjs.
      modelBasePath: `${window.location.origin}/human-models/`,
      backend: "humangl",
      cacheSensitivity: 0.7,
      // Everything the client is not allowed to act on is off. This is not a performance tweak;
      // it is the boundary between "help the user aim" and "decide who this is".
      face: {
        enabled: true,
        detector: { enabled: true, maxDetected: 3, minConfidence: 0.25, rotation: false },
        mesh: { enabled: true },
        description: { enabled: false }, // the embedding — server only
        antispoof: { enabled: false },   // security judgements — server only
        liveness: { enabled: false },
        iris: { enabled: false },
        emotion: { enabled: false }
      },
      body: { enabled: false },
      hand: { enabled: false },
      object: { enabled: false },
      gesture: { enabled: false },
      filter: { enabled: false }
    });
    await human.load();
    await human.warmup();
    return human;
  })().catch((err) => {
    // Reset so a later mount can retry — a transient network blip on first open should not
    // disable guidance for the rest of the session.
    humanPromise = null;
    throw err;
  });
  return humanPromise;
}

/** Laplacian-style sharpness proxy plus mean luminance, on a downscaled grayscale strip.
 *
 *  Both come out of one pixel walk because both answer questions the face box alone cannot.
 *  SHARPNESS: a big, centred, confidently-detected face can still be motion-blurred, and blur is
 *  what produces a low similarity score and an unexplained rejection later.
 *  LUMINANCE: it is also the only thing that can be measured when there is NO face box, which is
 *  exactly the NO_FACE case — "the detector found nothing" and "the room is too dark for the
 *  detector to find anything" are the same event to the user and need different advice. */
function frameStats(video: HTMLVideoElement, canvas: HTMLCanvasElement): { sharpness: number; luminance: number } {
  const W = 96;
  const H = Math.max(1, Math.round((video.videoHeight / Math.max(1, video.videoWidth)) * W));
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return { sharpness: 1, luminance: 0.5 };
  ctx.drawImage(video, 0, 0, W, H);
  const { data } = ctx.getImageData(0, 0, W, H);
  let sum = 0;
  let sumSq = 0;
  let lumaSum = 0;
  let n = 0;
  for (let y = 1; y < H - 1; y += 1) {
    for (let x = 1; x < W - 1; x += 1) {
      const i = (y * W + x) * 4;
      const g = (p: number) => 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
      // 4-neighbour Laplacian.
      const lap = 4 * g(i) - g(i - 4) - g(i + 4) - g(i - W * 4) - g(i + W * 4);
      sum += lap;
      sumSq += lap * lap;
      lumaSum += g(i);
      n += 1;
    }
  }
  if (n === 0) return { sharpness: 1, luminance: 0.5 };
  const variance = sumSq / n - (sum / n) ** 2;
  return {
    // ~180 is a comfortably crisp webcam frame; below ~40 is visibly soft.
    sharpness: Math.max(0, Math.min(1, variance / 180)),
    luminance: lumaSum / n / 255
  };
}

/** The framing inputs `scoreFrame` judges. Normalised so the scoring is pure arithmetic with no
 *  camera, canvas or DOM in it — which is the only reason it can be tested at all. */
export interface FrameMetrics {
  /** Share of the frame the face box covers, 0-1. */
  areaShare: number;
  /** Distance of the face centre from the frame centre, in normalised units. */
  offset: number;
  /** 0-1 Laplacian-variance sharpness. */
  sharpness: number;
  /** 0-1 mean luminance of the whole frame. */
  luminance: number;
  faceCount: number;
}

/**
 * The quality score and the single hint to show, from the framing numbers alone.
 *
 * THE HINT ORDER IS THE DESIGN, not an implementation detail. Telling somebody to hold still
 * while their face is out of frame is noise; one instruction at a time, addressing the thing that
 * is actually blocking them, is what makes this feel like it is helping rather than nagging.
 * Lighting comes first among the fixable ones because it is upstream of everything else — a dark
 * room makes the detector miss the face entirely, and "no face detected" is advice nobody can act
 * on when the real problem is the blinds.
 */
export function scoreFrame(m: FrameMetrics): { quality: number; hint: string | null } {
  const sizeScore = Math.max(0, Math.min(1, (m.areaShare - 0.015) / (0.09 - 0.015)));
  const centreScore = Math.max(0, 1 - m.offset / 0.28);
  const quality = 0.45 * sizeScore + 0.3 * centreScore + 0.25 * m.sharpness;

  let hint: string | null = null;
  if (m.faceCount === 0) {
    // The one case with no face box to reason about: only the exposure can explain it.
    hint =
      m.luminance < 0.16
        ? "Too dark — turn on a light or face a window"
        : m.luminance > 0.86
          ? "Too bright — move away from the light behind you"
          : "Looking for you — face the camera";
  } else if (m.faceCount > 1) hint = "More than one face in view — make sure you're alone in frame";
  else if (m.luminance < 0.16) hint = "Too dark — turn on a light or face a window";
  else if (m.luminance > 0.86) hint = "Too bright — try moving away from the window behind you";
  else if (m.areaShare < 0.03) hint = "Move a little closer";
  else if (m.areaShare > 0.45) hint = "Move back slightly";
  else if (m.offset > 0.22) hint = "Centre your face in the oval";
  else if (m.sharpness < 0.25) hint = "Hold still — the image is blurry";

  return { quality, hint };
}

export function useFaceTracker(video: HTMLVideoElement | null, enabled: boolean) {
  const [status, setStatus] = useState<TrackerStatus>("idle");
  const [reading, setReading] = useState<FaceTrackerReading>(EMPTY);
  // The loop reads through a ref so a re-render never restarts it, and so the caller can read the
  // newest value synchronously at the moment it decides to capture.
  const readingRef = useRef<FaceTrackerReading>(EMPTY);
  const rafRef = useRef<number | null>(null);
  const scratchRef = useRef<HTMLCanvasElement | null>(null);

  const latest = useCallback(() => readingRef.current, []);

  useEffect(() => {
    if (!enabled || !video) {
      setStatus("idle");
      return;
    }
    let cancelled = false;
    let human: any = null;
    if (!scratchRef.current) scratchRef.current = document.createElement("canvas");

    setStatus("loading");
    getHuman()
      .then((h) => {
        if (cancelled) return;
        human = h;
        setStatus("tracking");
        loop();
      })
      .catch(() => {
        if (!cancelled) setStatus("unavailable");
      });

    let lastRun = 0;
    /** ~15fps. Faster buys no useful guidance and costs battery on the phones this has to work on. */
    const INTERVAL_MS = 66;

    async function loop() {
      if (cancelled || !video || !human) return;
      const now = performance.now();
      if (now - lastRun >= INTERVAL_MS && video.readyState >= 2 && video.videoWidth > 0) {
        lastRun = now;
        try {
          const result = await human.detect(video);
          if (cancelled) return;
          const faces = result?.face ?? [];
          // Largest face wins, matching face.service.ts#analyzeFace exactly. The client and the
          // server disagreeing about WHICH face is the subject would put the meter on one head
          // and the decision on another.
          const primary = faces.length
            ? faces.reduce((biggest: any, candidate: any) => (area(candidate) > area(biggest) ? candidate : biggest), faces[0])
            : null;
          const next = build(primary, faces.length, video);
          readingRef.current = next;
          setReading(next);
        } catch {
          // A single failed frame is not a failure of the feature — keep the loop alive.
        }
      }
      rafRef.current = requestAnimationFrame(loop);
    }

    function area(b: any): number {
      return (b?.box?.[2] ?? 0) * (b?.box?.[3] ?? 0);
    }

    function build(primary: any, faceCount: number, el: HTMLVideoElement): FaceTrackerReading {
      const [bx, by, bw, bh] = primary?.box ?? [0, 0, 0, 0];
      const vw = el.videoWidth || 1;
      const vh = el.videoHeight || 1;
      const areaShare = (bw * bh) / (vw * vh);
      const cx = (bx + bw / 2) / vw;
      const cy = (by + bh / 2) / vh;
      // Measured even with NO face, because exposure is the only thing that can explain the
      // detector coming up empty — and it is the one piece of advice that actually fixes it.
      const stats = frameStats(el, scratchRef.current!);
      const offset = primary ? Math.hypot(cx - 0.5, cy - 0.5) : 1;

      const { quality, hint } = scoreFrame({
        areaShare: primary ? areaShare : 0,
        offset,
        sharpness: stats.sharpness,
        luminance: stats.luminance,
        faceCount
      });

      const rot = primary?.rotation?.angle ?? {};
      return {
        faceCount,
        box: primary ? { x: bx / vw, y: by / vh, width: bw / vw, height: bh / vh } : null,
        yaw: typeof rot.yaw === "number" ? rot.yaw : 0,
        pitch: typeof rot.pitch === "number" ? rot.pitch : 0,
        roll: typeof rot.roll === "number" ? rot.roll : 0,
        quality: primary ? quality : 0,
        hint,
        confidence: primary?.faceScore ?? primary?.score ?? 0
      };
    }

    return () => {
      cancelled = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      readingRef.current = EMPTY;
    };
  }, [video, enabled]);

  return { status, reading, latest };
}
