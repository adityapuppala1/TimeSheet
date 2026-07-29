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
import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, CameraOff, RefreshCw, ShieldCheck } from "lucide-react";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";

export type FaceCaptureState = "idle" | "starting" | "ready" | "captured" | "denied" | "unavailable";

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
}

export function FaceCapture({ onCapture, busy = false, hint, hintTone = "info", captureLabel = "Capture", className }: FaceCaptureProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [state, setState] = useState<FaceCaptureState>("idle");
  const [error, setError] = useState<string | null>(null);

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

  const capture = useCallback(() => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // The preview is mirrored for a natural "looking in a mirror" feel, but the frame we send
    // must NOT be — the server compares it against an un-mirrored enrollment image.
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        if (blob) onCapture(blob);
      },
      "image/jpeg",
      0.9
    );
  }, [onCapture]);

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
            /* Alignment guide, percentage-sized so it tracks the video at every viewport. */
            <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="h-[78%] w-[58%] rounded-[50%] border-2 border-dashed border-white/70 shadow-[0_0_0_9999px_rgba(0,0,0,0.28)]" />
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
}
