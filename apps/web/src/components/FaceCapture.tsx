/**
 * WHAT: the camera surface shared by face enrollment and face verification — requests the
 * webcam, shows a live preview with an alignment guide, grabs a still, and hands the caller a
 * JPEG Blob.
 * WHERE THE LINE IS, and it has moved but not blurred: this component now runs live face
 * DETECTION and head-pose tracking locally (lib/use-face-tracker.ts), because guiding somebody to
 * produce a good frame requires knowing what the current frame looks like. It still computes no
 * embedding and decides no outcome. Every judgement that matters — is this the right person, is
 * this a live face, did the demanded movement actually happen — is made server-side in
 * apps/api/src/services/face.service.ts, because a client that decides its own verification
 * result is not a security control; anyone could send a "passed" from devtools.
 *
 * So: the client decides WHEN to press the shutter and what to say to the person. The server
 * decides everything else, and re-measures from the frames rather than trusting anything sent
 * alongside them.
 *
 * Responsive behaviour (works phone → 4K without media queries): the video sits in an
 * aspect-ratio box that fills its container up to a max width, so it scales fluidly; the
 * alignment oval is drawn in percentage units so it tracks the video at any size; and controls
 * stack vertically under `sm` and sit inline above it.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Camera, CameraOff, RefreshCw, ShieldCheck, Users } from "lucide-react";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";
import { useFaceTracker, type FaceTrackerReading } from "../lib/use-face-tracker";

export type FaceCaptureState = "idle" | "starting" | "ready" | "captured" | "denied" | "unavailable";

/** Imperative surface for multi-frame flows (the challenge–response dialog): lets the parent
 *  grab an EXTRA frame from the live stream without the user pressing anything, read the current
 *  head pose, and read the active camera's label (sent to the server as the virtual-camera review
 *  signal). */
/**
 * The live head-turn meter, drawn over the preview.
 *
 * PRESENTATIONAL ON PURPOSE. This component used to own a second, self-driving copy of the
 * challenge loop — which nothing ever mounted, because the dialog ran its own. Two loops that
 * disagreed about the fire threshold and the axis rule is precisely how a bar reading "done" ends
 * up attached to a refused frame. The measurement now lives in exactly one place
 * (lib/face-pose.ts) and this just draws what it is told.
 */
export interface PoseMeter {
  /** 0-1. Full at the moment the shutter fires — see PoseTarget#fireMargin for why that is above
   *  the server's own line rather than exactly on it. */
  progress: number;
  /** The single line of coaching for whatever is currently blocking, from `poseCoaching`. */
  coaching: string;
  /** Reached. Drives the colour AND the wording — never colour alone. */
  satisfied: boolean;
  /** Whole seconds left in the movement window, or null to hide the countdown. */
  secondsLeft?: number | null;
}

export interface FaceCaptureHandle {
  captureFrame: () => Promise<Blob | null>;
  /** The newest live tracking reading, read synchronously. The challenge flow uses this to record
   *  the neutral pose at the exact moment it grabs the neutral frame. */
  getReading: () => FaceTrackerReading;
  /** Grabs `count` frames spaced `gapMs` apart — the multi-frame enrollment burst. Natural
   *  micro-movement between frames is the point: it's what gives the stored template set the
   *  variation that stops one unlucky frame defining the person forever. */
  captureBurst: (count: number, gapMs?: number) => Promise<Blob[]>;
  getDeviceLabel: () => string | null;
  isLive: () => boolean;
}

interface FaceCaptureProps {
  /** Called with the captured still. The parent owns upload + result handling. */
  onCapture: (blob: Blob) => void;
  /** Disables the shutter while the parent is uploading/verifying. */
  busy?: boolean;
  /** Shown under the preview — the parent's status/error message. */
  hint?: string;
  /** Tone of `hint`. */
  hintTone?: "info" | "error" | "success";
  captureLabel?: string;
  className?: string;
  /** Large overlay text on the live preview (the challenge instruction + countdown). */
  overlayText?: string | null;
  /** Request the camera immediately on mount instead of waiting for a click — the Face-ID
   *  "it's already looking at you" feel. The browser's permission prompt still applies. */
  autoStart?: boolean;
  /** Hands-free shutter: scan the live stream and fire onCapture by itself once a single,
   *  centred, large-enough, sharp face holds still for a few consecutive ticks. Needs the local
   *  tracker, which needs WebGL; where that is unavailable the manual button remains, unchanged.
   *  Re-arms automatically when `busy` drops back to false. */
  autoCapture?: boolean;
  /** When set, the preview shows the live "turn further" meter over the video. The parent owns
   *  the measurement and the shutter; this only draws. Null hides it. */
  poseMeter?: PoseMeter | null;
  /**
   * Which of this component's own buttons to render.
   * - "full": shutter + "Turn off" (standalone usage).
   * - "capture-only": just the shutter — for dialogs whose own Cancel already closes and stops
   *   the camera; a second "Turn off" there was one of the duplicate buttons users tripped on.
   * - "none": no controls at all — for wizard parents that drive capture imperatively; the old
   *   behavior rendered a shutter wired to a no-op, which is worse than a duplicate: a dead
   *   "Start" right beside the real one.
   * The "Turn on camera / Try again" button is exempt: enabling the camera (and recovering from
   * a denied permission) is this component's own job in every mode.
   */
  controls?: "full" | "capture-only" | "none";
}

export const FaceCapture = forwardRef<FaceCaptureHandle, FaceCaptureProps>(function FaceCapture(
  {
    onCapture,
    busy = false,
    hint,
    hintTone = "info",
    captureLabel = "Capture",
    className,
    overlayText = null,
    autoStart = false,
    autoCapture = false,
    poseMeter = null,
    controls = "full"
  }: FaceCaptureProps,
  ref
) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // State, not a ref, so attaching the tracker re-renders once the <video> exists.
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [state, setState] = useState<FaceCaptureState>("idle");
  const [error, setError] = useState<string | null>(null);
  /** Hands-free scan phase: null = not scanning, "searching" = no usable face yet,
   *  "locking" = face seen, holding for stability before the shutter fires. */
  const [scanPhase, setScanPhase] = useState<"searching" | "locking" | null>(null);
  /** Live, pre-upload coaching from the local quality score ("Move a little closer"). This is
   *  what turns a binary pass/fail into a cooperative interaction. */
  const [liveHint, setLiveHint] = useState<string | null>(null);

  // The live tracker. Only runs while the camera is actually up, so nothing is loaded for a user
  // who never opens it. `status === "unavailable"` (no WebGL, models blocked) simply means the
  // guidance below stays quiet and the manual shutter carries the flow, exactly as before.
  const tracker = useFaceTracker(videoEl, state === "ready");

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const start = useCallback(async () => {
    setError(null);
    // getUserMedia only exists on a secure origin (https, or localhost). Saying so explicitly is
    // far more useful than the browser's generic "undefined is not a function".
    //
    // WHY THE MESSAGE NAMES THE ACTUAL HOST: this is overwhelmingly a PHONE problem, and it is
    // invisible during development. A laptop opens the app on `localhost`, which browsers exempt
    // from the secure-context rule, so the camera works and nobody notices. The same build reached
    // from a phone on `http://192.168.1.20:5173` has no camera at all — and the old wording ("ask
    // your admin to enable HTTPS") gave the admin no clue that the address was the problem, or
    // which address to fix. Showing the origin makes it self-diagnosing.
    if (!navigator.mediaDevices?.getUserMedia) {
      setState("unavailable");
      const origin = typeof window !== "undefined" ? window.location.origin : "this address";
      setError(
        `Your browser only allows camera access over HTTPS, and this page was opened on ${origin}. ` +
          `Open it on https:// (or on localhost on this machine) and the camera will work. ` +
          `Your admin can set this up — see "Serving over HTTPS" in the deployment guide.`
      );
      return;
    }
    setState("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
      setState("ready");
    } catch (err) {
      const name = (err as DOMException)?.name;
      setState(name === "NotAllowedError" ? "denied" : "unavailable");
      setError(
        name === "NotAllowedError"
          ? "Camera permission was blocked. Allow camera access for this site in your browser settings, then try again."
          : name === "NotFoundError"
            ? "No camera was found on this device."
            : "Couldn't start the camera. Close any other app that might be using it and try again."
      );
    }
  }, []);

  // Release the camera on unmount — leaving the indicator light on after the dialog closes
  // reads as spyware, and on mobile it keeps the sensor powered.
  useEffect(() => () => stop(), [stop]);

  // Face-ID feel, part 1: the camera comes to YOU. Runs once on mount; a permission denial
  // falls through to the normal error state with its "try again" button.
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (autoStart && !autoStartedRef.current) {
      autoStartedRef.current = true;
      void start();
    }
  }, [autoStart, start]);

  /**
   * Grabs one un-mirrored JPEG frame off the live stream, or null when the camera isn't up.
   *
   * THE WHOLE FRAME GOES UP, DELIBERATELY — and this has been proposed and rejected more than
   * once, so the reasoning lives here. Cropping to the tracked face box before upload would cut
   * bandwidth and would make MULTIPLE_FACES rejections disappear. That last part is the problem:
   * it would make them disappear by hiding the second person from the detector, not by there not
   * being one. `faceCount > 1` is a security decision — "is somebody standing behind this
   * employee, coaching or coercing them?" — and the server can only answer it from what it is
   * sent. Letting the client choose the crop hands that answer to the client, and a client that
   * decides what the server is allowed to see is not a control at all; anyone could crop from
   * devtools. The frame stays whole so the server keeps deciding.
   *
   * The honest version of "warn me before I'm rejected" is the live multi-face banner below,
   * which tells the person to move BEFORE the shutter without changing what the server judges.
   */
  const grabFrame = useCallback((): Promise<Blob | null> => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return Promise.resolve(null);
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return Promise.resolve(null);
    // The preview is mirrored for a natural "looking in a mirror" feel, but the frame we send
    // must NOT be — the server compares it against an un-mirrored enrollment image.
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.9));
  }, []);

  const capture = useCallback(() => {
    void grabFrame().then((blob) => {
      if (blob) onCapture(blob);
    });
  }, [grabFrame, onCapture]);

  // Face-ID feel, part 2: hands-free shutter, now driven by the shared tracker rather than
  // Chromium's Shape Detection API.
  //
  // WHY THE SWITCH: window.FaceDetector exists only in Chromium, so on Firefox and on iOS Safari
  // — which is most phones — hands-free capture silently never happened and every user pressed
  // the button at a moment of their own choosing. That is precisely the flow that produced
  // blurry, off-angle frames and unexplained rejections. The tracker works in every browser with
  // WebGL, and it additionally measures sharpness, which the bounding box alone cannot express: a
  // big, centred, confidently-detected face can still be motion-blurred, and blur is what turns
  // into a low similarity score and a refusal the person cannot account for.
  //
  // Detection still decides only WHEN to press the shutter. Whether the face is the right one
  // remains entirely the server's call.
  const supportsAutoCapture = autoCapture && tracker.status === "tracking";
  useEffect(() => {
    if (!supportsAutoCapture || state !== "ready" || busy || poseMeter) {
      setScanPhase(null);
      return;
    }

    let cancelled = false;
    let goodTicks = 0;
    let fired = false;
    // Rolling best-frame: keep the highest-quality frame seen during the lock window and submit
    // THAT, rather than whichever frame the shutter happened to land on. Same latency, better
    // input — the cheap half of the accuracy work, done client-side.
    let best: { blob: Blob; score: number } | null = null;
    setScanPhase("searching");

    const interval = setInterval(async () => {
      if (cancelled || fired) return;
      const reading = tracker.latest();
      // The hint itself belongs to the ambient effect below — one owner, so the two loops can't
      // race each other to write different text into the same line.
      if (reading.faceCount !== 1 || reading.hint !== null) {
        goodTicks = 0;
        best = null;
        setScanPhase("searching");
        return;
      }

      goodTicks += 1;
      setScanPhase("locking");
      const blob = await grabFrame();
      if (cancelled || fired) return;
      if (blob && (!best || reading.quality > best.score)) best = { blob, score: reading.quality };
      // 3 consecutive good ticks (~1s) — the same "hold still… got it" cadence phone face-unlock
      // trains people to expect.
      if (goodTicks >= 3 && best) {
        fired = true;
        setScanPhase(null);
        onCapture(best.blob);
      }
    }, 320);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [supportsAutoCapture, state, busy, poseMeter, grabFrame, onCapture, tracker]);

  /**
   * Ambient pre-shutter coaching, whether or not the hands-free scanner is running.
   *
   * WHY IT IS SEPARATE FROM THE SCANNER: guidance used to be a side effect of the auto-capture
   * loop, so it appeared only when auto-capture was armed. Every OTHER path — the manual shutter
   * after the auto-scan ceiling, the enrollment wizard between steps, any browser where
   * auto-capture is off — showed a live preview with no feedback at all, which is the exact
   * "press the button and find out afterwards" flow that produced unexplained rejections. The
   * hint is the cheap half of the fix and it belongs to the preview, not to one of its modes.
   */
  useEffect(() => {
    if (state !== "ready" || tracker.status !== "tracking" || poseMeter) return;
    const interval = setInterval(() => setLiveHint(tracker.latest().hint), 200);
    return () => {
      clearInterval(interval);
      setLiveHint(null);
    };
  }, [state, tracker, poseMeter]);

  const captureBurst = useCallback(
    async (count: number, gapMs = 260): Promise<Blob[]> => {
      const out: Blob[] = [];
      for (let i = 0; i < count; i++) {
        const blob = await grabFrame();
        if (blob) out.push(blob);
        if (i < count - 1) await new Promise((r) => setTimeout(r, gapMs));
      }
      return out;
    },
    [grabFrame]
  );

  useImperativeHandle(
    ref,
    () => ({
      captureFrame: grabFrame,
      getReading: tracker.latest,
      captureBurst,
      getDeviceLabel: () => streamRef.current?.getVideoTracks()[0]?.label ?? null,
      isLive: () => state === "ready"
    }),
    [grabFrame, captureBurst, state, tracker.latest]
  );

  const live = state === "ready";
  const showStart = state === "idle" || state === "denied" || state === "unavailable";

  return (
    <div className={cn("flex w-full flex-col items-center gap-3", className)}>
      <div className="relative w-full max-w-sm overflow-hidden rounded-xl border border-border bg-muted/40 shadow-sm">
        {/* Fixed 4:3 box: reserves layout space before the stream arrives, so the dialog
            doesn't jump when the camera starts. */}
        <div className="relative aspect-[4/3] w-full">
          <video
            ref={(el) => {
              videoRef.current = el;
              setVideoEl(el);
            }}
            playsInline
            muted
            autoPlay
            className={cn("h-full w-full scale-x-[-1] object-cover transition-opacity", live ? "opacity-100" : "opacity-0")}
          />

          {live && (
            /* Alignment guide, percentage-sized so it tracks the video at every viewport.
               Turns solid + primary while the hands-free scanner is locking on — the visual
               "I see you, hold still" cue. motion-safe keeps the pulse away from
               prefers-reduced-motion users. */
            <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div
                className={cn(
                  "h-[78%] w-[58%] rounded-[50%] border-2 shadow-[0_0_0_9999px_rgba(0,0,0,0.28)] transition-colors",
                  scanPhase === "locking" ? "border-solid border-primary motion-safe:animate-pulse" : "border-dashed border-white/70"
                )}
              />
            </div>
          )}

          {/* SECOND FACE, BEFORE the shutter rather than after the rejection. The server decides
              MULTIPLE_FACES on the frame it receives and nothing here changes that — this is a
              chance to step out of shot instead of submitting and being refused. It warns, it
              does not block: the detector is a guidance model, and letting it veto a capture
              would strand anyone it mis-fires on (a poster, a reflection) with no way through. */}
          {live && tracker.status === "tracking" && tracker.reading.faceCount > 1 && (
            <div
              role="alert"
              className="pointer-events-none absolute inset-x-2 top-2 flex items-center justify-center gap-1.5 rounded-lg bg-amber-500 px-2 py-1.5 text-center"
            >
              <Users className="h-3.5 w-3.5 shrink-0 text-amber-950" />
              <span className="text-[11px] font-semibold leading-tight text-amber-950">
                {tracker.reading.faceCount} faces in view — you need to be alone in frame
              </span>
            </div>
          )}

          {live && !overlayText && (liveHint || scanPhase) && (
            <div role="status" aria-live="polite" className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-3 pb-3 pt-8 text-center">
              <p className="text-sm font-semibold text-white drop-shadow">
                {liveHint ?? (scanPhase === "locking" ? "Hold still…" : "Looking for you — face the camera")}
              </p>
            </div>
          )}

          {live && overlayText && (
            /* Challenge instruction + meter, announced for screen readers too. */
            <div role="status" className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-3 pb-3 pt-8 text-center">
              <p className="text-sm font-semibold text-white drop-shadow sm:text-base">{overlayText}</p>
              {poseMeter && (
                <>
                  {/* The bar IS the fix. The requirement never changed — what changed is that it
                      is now visible while you move, instead of being scored after you guess.
                      It lives ON the video because that is where the person is looking while
                      their head is moving. aria-valuenow carries the same number for anyone who
                      cannot see the fill; the coaching line below never depends on colour. */}
                  <div
                    role="progressbar"
                    aria-label="Head movement progress"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(poseMeter.progress * 100)}
                    className="mx-auto mt-2 h-1.5 w-40 overflow-hidden rounded-full bg-white/25 sm:w-52"
                  >
                    <div
                      className={cn(
                        "h-full rounded-full motion-safe:transition-[width,background-color] motion-safe:duration-100",
                        poseMeter.satisfied ? "bg-success" : "bg-primary"
                      )}
                      style={{ width: `${Math.round(poseMeter.progress * 100)}%` }}
                    />
                  </div>
                  <p className="mt-1 text-xs font-medium text-white/90 drop-shadow">
                    {poseMeter.coaching}
                    {poseMeter.secondsLeft != null && !poseMeter.satisfied ? ` · ${poseMeter.secondsLeft}s` : ""}
                  </p>
                </>
              )}
            </div>
          )}

          {/* Live quality ring — the ambient "the camera can see you properly" signal. Shown only
              while tracking and not mid-challenge, where the pose bar is the thing to watch. */}
          {live && tracker.status === "tracking" && !poseMeter && tracker.reading.faceCount === 1 && (
            <div className="pointer-events-none absolute right-2 top-2 flex items-center gap-1.5 rounded-full bg-black/45 px-2 py-1">
              <span
                aria-hidden
                className={cn(
                  "h-2 w-2 rounded-full",
                  tracker.reading.quality > 0.7 ? "bg-success" : tracker.reading.quality > 0.4 ? "bg-warning" : "bg-destructive"
                )}
              />
              {/* The word, not just the dot — the ring is the one place a colour could have been
                  the whole message. */}
              <span className="text-[10px] font-semibold uppercase tracking-wide text-white/90">
                {tracker.reading.quality > 0.7 ? "Good" : tracker.reading.quality > 0.4 ? "Fair" : "Poor"}
              </span>
            </div>
          )}

          {!live && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
              {state === "starting" ? (
                <>
                  <RefreshCw className="h-7 w-7 animate-spin text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">Starting camera…</p>
                </>
              ) : (
                <>
                  {state === "denied" || state === "unavailable" ? (
                    <CameraOff className="h-7 w-7 text-muted-foreground" />
                  ) : (
                    <Camera className="h-7 w-7 text-muted-foreground" />
                  )}
                  <p className="text-sm text-muted-foreground">
                    {state === "idle" ? "Your camera is off." : "Camera unavailable."}
                  </p>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {(error || hint) && (
        <p
          role={error || hintTone === "error" ? "alert" : "status"}
          className={cn(
            "max-w-sm text-center text-sm",
            error || hintTone === "error" ? "text-destructive" : hintTone === "success" ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"
          )}
        >
          {error ?? hint}
        </p>
      )}

      {/* Stacks on phones, inline from sm up. One row, whose contents depend on `controls` —
          see the prop's comment for why wizard/dialog parents suppress pieces of it. */}
      {(showStart || controls !== "none") && (
        <div className="flex w-full max-w-sm flex-col gap-2 sm:flex-row sm:justify-center">
          {showStart ? (
            <Button type="button" onClick={start} className="w-full sm:w-auto">
              <Camera className="mr-2 h-4 w-4" />
              {state === "idle" ? "Turn on camera" : "Try again"}
            </Button>
          ) : (
            controls !== "none" && (
              <>
                <Button type="button" onClick={capture} disabled={!live || busy} className="w-full sm:w-auto">
                  {busy ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}
                  {busy ? "Checking…" : captureLabel}
                </Button>
                {controls === "full" && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      stop();
                      setState("idle");
                    }}
                    disabled={busy}
                    className="w-full sm:w-auto"
                  >
                    <CameraOff className="mr-2 h-4 w-4" />
                    Turn off
                  </Button>
                )}
              </>
            )
          )}
        </div>
      )}
    </div>
  );
});
