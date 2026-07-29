/**
 * WHAT: the camera surface shared by face enrollment and face verification — requests the
 * webcam, shows a live preview with an alignment guide, grabs a still, and hands the caller a
 * JPEG Blob.
 * WHY it's deliberately "dumb": no face detection or matching happens here. Every judgement is
 * made server-side (see apps/api/src/services/face.service.ts) because a client that decides
 * its own verification outcome is not a security control — anyone could send a "passed" result
 * from devtools. This component's whole job is to produce a good frame and clear feedback.
 *
 * Responsive behaviour (works phone → 4K without media queries): the video sits in an
 * aspect-ratio box that fills its container up to a max width, so it scales fluidly; the
 * alignment oval is drawn in percentage units so it tracks the video at any size; and controls
 * stack vertically under `sm` and sit inline above it.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Camera, CameraOff, RefreshCw, ShieldCheck } from "lucide-react";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";

export type FaceCaptureState = "idle" | "starting" | "ready" | "captured" | "denied" | "unavailable";

/** Imperative surface for multi-frame flows (the challenge–response dialog): lets the parent
 *  grab an EXTRA frame from the live stream without the user pressing anything, and read the
 *  active camera's label (sent to the server as the virtual-camera review signal). */
export interface FaceCaptureHandle {
  captureFrame: () => Promise<Blob | null>;
  getDeviceLabel: () => string | null;
  isLive: () => boolean;
}

/** Chrome's Shape Detection API — the progressive-enhancement half of hands-free capture.
 *  Detection here is ONLY "when to press the shutter"; every security judgement stays
 *  server-side, so a platform without this simply falls back to the manual button. */
interface BrowserFaceDetector {
  detect: (source: HTMLVideoElement) => Promise<Array<{ boundingBox: { x: number; y: number; width: number; height: number } }>>;
}
declare global {
  interface Window {
    FaceDetector?: new (options?: { fastMode?: boolean; maxDetectedFaces?: number }) => BrowserFaceDetector;
  }
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
   *  centered, large-enough face holds still for a few consecutive ticks. Only activates where
   *  window.FaceDetector exists (Chromium's Shape Detection API); elsewhere the manual button
   *  remains, unchanged. Re-arms automatically when `busy` drops back to false. */
  autoCapture?: boolean;
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
    autoCapture = false
  }: FaceCaptureProps,
  ref
) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [state, setState] = useState<FaceCaptureState>("idle");
  const [error, setError] = useState<string | null>(null);
  /** Hands-free scan phase: null = not scanning, "searching" = no usable face yet,
   *  "locking" = face seen, holding for stability before the shutter fires. */
  const [scanPhase, setScanPhase] = useState<"searching" | "locking" | null>(null);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const start = useCallback(async () => {
    setError(null);
    // getUserMedia only exists on a secure origin (https, or localhost). Saying so explicitly
    // is far more useful than the browser's generic "undefined is not a function".
    if (!navigator.mediaDevices?.getUserMedia) {
      setState("unavailable");
      setError("Camera access needs a secure connection (HTTPS). Ask your admin to enable HTTPS for this site.");
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

  /** Grabs one un-mirrored JPEG frame off the live stream, or null when the camera isn't up. */
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

  // Face-ID feel, part 2: hands-free shutter. A detection loop watches the live stream and
  // fires ONE capture once a single face is (a) big enough to be the subject rather than a
  // bystander, (b) roughly centered in the guide oval, and (c) stable for 3 consecutive ticks
  // (~1s) — the same "hold still… got it" cadence phone face-unlock trains people to expect.
  // Detection here decides only WHEN to press the shutter; whether the face is the right one
  // is still entirely the server's call. No FaceDetector support → this effect stays inert and
  // the manual button carries on.
  const supportsAutoCapture = autoCapture && typeof window !== "undefined" && Boolean(window.FaceDetector);
  useEffect(() => {
    if (!supportsAutoCapture || state !== "ready" || busy) {
      setScanPhase(null);
      return;
    }

    let cancelled = false;
    let stableTicks = 0;
    let fired = false;
    const detector = new window.FaceDetector!({ fastMode: true, maxDetectedFaces: 2 });
    setScanPhase("searching");

    const interval = setInterval(async () => {
      const video = videoRef.current;
      if (cancelled || fired || !video || !video.videoWidth) return;
      try {
        const faces = await detector.detect(video);
        if (cancelled || fired) return;

        const usable =
          faces.length === 1 &&
          (() => {
            const box = faces[0].boundingBox;
            const areaShare = (box.width * box.height) / (video.videoWidth * video.videoHeight);
            const cx = (box.x + box.width / 2) / video.videoWidth;
            const cy = (box.y + box.height / 2) / video.videoHeight;
            // ≥8% of the frame ≈ arm's-length selfie distance; center within the middle band.
            return areaShare >= 0.08 && cx > 0.25 && cx < 0.75 && cy > 0.2 && cy < 0.8;
          })();

        if (usable) {
          stableTicks += 1;
          setScanPhase("locking");
          if (stableTicks >= 3) {
            fired = true;
            setScanPhase(null);
            capture();
          }
        } else {
          stableTicks = 0;
          setScanPhase("searching");
        }
      } catch {
        // A detector error (unsupported source, transient) just means this tick is skipped —
        // the manual button is always there.
      }
    }, 350);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [supportsAutoCapture, state, busy, capture]);

  useImperativeHandle(
    ref,
    () => ({
      captureFrame: grabFrame,
      getDeviceLabel: () => streamRef.current?.getVideoTracks()[0]?.label ?? null,
      isLive: () => state === "ready"
    }),
    [grabFrame, state]
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
            ref={videoRef}
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

          {live && !overlayText && scanPhase && (
            <div role="status" className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-3 pb-3 pt-8 text-center">
              <p className="text-sm font-semibold text-white drop-shadow">
                {scanPhase === "locking" ? "Hold still…" : "Looking for you — face the camera"}
              </p>
            </div>
          )}

          {live && overlayText && (
            /* Challenge instruction + countdown, announced for screen readers too. */
            <div role="status" className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-3 pb-3 pt-8 text-center">
              <p className="text-sm font-semibold text-white drop-shadow sm:text-base">{overlayText}</p>
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

      {/* Stacks on phones, inline from sm up. */}
      <div className="flex w-full max-w-sm flex-col gap-2 sm:flex-row sm:justify-center">
        {showStart ? (
          <Button type="button" onClick={start} className="w-full sm:w-auto">
            <Camera className="mr-2 h-4 w-4" />
            {state === "idle" ? "Turn on camera" : "Try again"}
          </Button>
        ) : (
          <>
            <Button type="button" onClick={capture} disabled={!live || busy} className="w-full sm:w-auto">
              {busy ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}
              {busy ? "Checking…" : captureLabel}
            </Button>
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
          </>
        )}
      </div>
    </div>
  );
});
