/**
 * WHAT: the modal that stands between "user pressed Submit/Approve" and the action actually
 * happening, when the workspace's face-verification policy covers them. Captures the frame(s),
 * sends them for server-side verification, and on success hands the caller a single-use
 * `verificationId` to include with the protected request.
 * WHY a dialog rather than an inline panel: the check is a deliberate interruption — it should
 * be obvious that identity is being confirmed, and it must be dismissible without silently
 * submitting anything.
 *
 * CHALLENGE FLOW (when the workspace has challenge–response on): one click captures the neutral
 * frame, THEN the server-issued instruction appears over the live preview, and the second frame
 * is grabbed automatically the moment the demanded head movement actually happens — the user
 * never presses a second button. The instruction is fetched only AFTER the first frame exists, so
 * a replayed recording can't have known what movement would be demanded. All enforcement is
 * server-side (services/face.service.ts); this component only choreographs capture.
 *
 * The gesture frame used to be taken on a fixed 3-second countdown. It is now taken at the PEAK
 * of the measured rotation, with a live meter showing the person how far they still have to turn.
 * See GESTURE_WINDOW_MS for the production numbers that motivated the change — it was the single
 * largest source of failed checks in the product.
 *
 * Retry posture matches the server's (see face.service.ts): a failed check is NOT a lockout.
 * The user can retry; after `maxAttempts` consecutive failures the server flags the attempt for
 * admin review, and the dialog says so plainly instead of pretending nothing happened —
 * lighting and glasses make honest failures common, so the copy never accuses.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";
import { FaceCapture, type FaceCaptureHandle } from "./FaceCapture";
import { faceApi, type FaceChallenge, type FaceOutcome } from "../services/api";
import { cn } from "../lib/utils";
import { isSecureContext } from "../lib/clipboard";
import { useFaceStatus } from "../lib/use-face-status";

interface FaceVerificationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  context: "TIMESHEET" | "TICKET" | "APPROVAL";
  /** Called with the single-use verification id once the check passes. */
  onVerified: (verificationId: string) => void;
  /** What the user is about to do, e.g. "submit this timesheet". */
  actionLabel?: string;
}

const FRIENDLY: Record<FaceOutcome, string> = {
  PASSED: "Identity confirmed.",
  NO_FACE: "No face detected — make sure your face is clearly visible and well lit.",
  MULTIPLE_FACES: "More than one face is in frame — please make sure you're alone.",
  NO_MATCH:
    "We couldn't confirm it's you. Better lighting and a centred face help — and if this keeps happening, retrain your face model from Profile → Face verification to cover more angles.",
  SPOOF_SUSPECTED: "That didn't look like a live capture. Look directly at the camera rather than holding up a photo or screen.",
  CHALLENGE_FAILED: "We couldn't see the requested head movement — face the camera first, then make the movement clearly.",
  LOW_QUALITY: "We couldn't see you clearly enough — adjust and try again.",
  NOT_ENROLLED: "You haven't set up face verification yet — do that in your profile first.",
  ERROR: "Something went wrong during verification. Please try again."
};

/**
 * How long to wait for the head movement before giving up on it.
 *
 * This REPLACED a fixed 3-second countdown, and the reason is the most instructive number in this
 * feature: in production the challenge failed 107 times against 69 passes, with recorded yaw
 * deltas of 0.02-0.26 radians against a 0.35 requirement. The countdown grabbed whatever frame
 * existed when the timer expired — which, for someone who turned early and relaxed, or who turned
 * slowly and was still moving, was routinely a frame with almost no rotation in it. People were
 * being failed for the timing of their movement rather than its absence.
 *
 * Now the shutter is fired by the movement itself, at the peak of the turn, and this is only the
 * ceiling on how long to keep watching. Generous on purpose: an unhurried, correct capture beats
 * a fast wrong one, and the challenge's own server-side lifetime (90s) is the real bound.
 */
const GESTURE_WINDOW_MS = 9000;

/** Hands-free attempts before the dialog falls back to the manual button. A ceiling, because
 *  an auto-retrying scanner pointed at the WRONG face would otherwise hammer the rate limit
 *  and pile failure rows into the review log with zero user intent behind them. */
const MAX_AUTO_ATTEMPTS = 2;

export function FaceVerificationDialog({ open, onOpenChange, context, onVerified, actionLabel = "continue" }: FaceVerificationDialogProps) {
  const captureRef = useRef<FaceCaptureHandle | null>(null);
  const cancelledRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [tone, setTone] = useState<"info" | "error" | "success">("info");
  const [flagged, setFlagged] = useState(false);
  const [overlay, setOverlay] = useState<string | null>(null);
  /** 0-1 progress through the demanded head movement, mirrored under the preview so the person
   *  can see they are getting there. The whole point of the rework. */
  const [poseProgress, setPoseProgress] = useState(0);
  /** Set when this attempt starts, so the server can be told what the human actually waited
   *  for — the number the <1s p50 budget is tracked against. */
  const startedAtRef = useRef<number | null>(null);

  const status = useFaceStatus(open);
  const challengeOn = status.data?.challengeEnabled ?? true;

  /** getUserMedia only exists on secure origins (https, or localhost) — a browser rule no
   *  setting can lift. When the admin has enabled the audited bypass, offer to proceed without
   *  the check rather than presenting a camera that can never start. */
  const [skipping, setSkipping] = useState(false);
  const insecureSkipAvailable = !isSecureContext() && (status.data?.insecureContextBypass ?? false);

  const handleSkip = useCallback(async () => {
    setSkipping(true);
    try {
      const { verificationId } = await faceApi.skipVerification(context);
      onVerified(verificationId);
      onOpenChange(false);
    } catch (err) {
      setTone("error");
      setMessage(
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
          "Could not record the skip — try again, or contact your admin."
      );
    } finally {
      setSkipping(false);
    }
  }, [context, onVerified, onOpenChange]);

  // Reset on each open — a stale "couldn't confirm it's you" from last time would be alarming.
  useEffect(() => {
    if (open) {
      cancelledRef.current = false;
      setAttempts(0);
      setMessage(null);
      setTone("info");
      setFlagged(false);
      setBusy(false);
      setOverlay(null);
    } else {
      cancelledRef.current = true;
    }
  }, [open]);

  // Hands-free while the first attempts are honest misses; manual after the ceiling so a
  // wrong-face loop can't keep firing on its own.
  const autoScanActive = attempts < MAX_AUTO_ATTEMPTS;

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  /**
   * Watches the live head pose and returns the frame at the PEAK of the movement, rather than
   * whichever frame a timer landed on.
   *
   * "Peak" matters: people overshoot and settle back, so the best evidence that the movement
   * happened is the largest delta seen during the window, not the delta at the end of it. The
   * server's own axis-dominance rule is mirrored here so the client never submits a frame that
   * satisfies the magnitude but fails the axis test.
   */
  const awaitPose = useCallback(
    async (challenge: FaceChallenge, neutral: { yaw: number; pitch: number }): Promise<Blob | null> => {
      const deadline = Date.now() + GESTURE_WINDOW_MS;
      let best: { blob: Blob; delta: number } | null = null;

      while (Date.now() < deadline && !cancelledRef.current) {
        const reading = captureRef.current?.getReading();
        if (reading && reading.faceCount === 1) {
          const yawDelta = Math.abs(reading.yaw - neutral.yaw);
          const pitchDelta = Math.abs(reading.pitch - neutral.pitch);
          const onAxis = challenge.axis === "yaw" ? yawDelta : pitchDelta;
          const offAxis = challenge.axis === "yaw" ? pitchDelta : yawDelta;

          setPoseProgress(Math.max(0, Math.min(1, onAxis / challenge.minDelta)));

          if (onAxis >= challenge.minDelta && onAxis >= offAxis) {
            const blob = await captureRef.current?.captureFrame();
            if (blob && (!best || onAxis > best.delta)) best = { blob, delta: onAxis };
            // Keep watching briefly past the line to catch the true peak, then stop. Without
            // this the frame is taken the instant the threshold is crossed, which is the
            // shallowest qualifying angle rather than the clearest one.
            if (best && onAxis < best.delta) break;
          }
        }
        await sleep(80);
      }
      setPoseProgress(0);
      return best?.blob ?? null;
    },
    []
  );

  const handleCapture = useCallback(
    async (neutralFrame: Blob) => {
      setBusy(true);
      setMessage(null);
      startedAtRef.current = Date.now();
      try {
        const frames: Blob[] = [neutralFrame];
        // Provenance evidence (Phase C): when each frame was captured, by the client's clock.
        // A replayed recording can only have been captured BEFORE its challenge existed.
        const neutralCapturedAt = Date.now();
        let gestureCapturedAt: number | undefined;
        let challengeId: string | undefined;

        if (challengeOn) {
          // The instruction is requested only now — AFTER the neutral frame exists — so a
          // pre-recorded video can't have anticipated it.
          const challenge = await faceApi.challenge(context);
          challengeId = challenge.challengeId;

          // The pose the neutral frame was taken at. Every delta below is measured against this,
          // exactly as the server measures it against the neutral frame it receives.
          const neutralPose = captureRef.current?.getReading();
          setOverlay(challenge.prompt);

          const gestureFrame = neutralPose
            ? await awaitPose(challenge, neutralPose)
            : // No tracker (no WebGL, models blocked): fall back to the old timed grab. Worse,
              // but it is the behaviour that shipped, and it is better than refusing to verify.
              await (async () => {
                setOverlay(`${challenge.prompt} — capturing in 3…`);
                await sleep(3000);
                return (await captureRef.current?.captureFrame()) ?? null;
              })();

          gestureCapturedAt = Date.now();
          setOverlay(null);
          if (cancelledRef.current) return;
          if (!gestureFrame) {
            setTone("error");
            setMessage(
              "We didn't see the head movement in time. Face the camera, then turn clearly and hold it for a moment."
            );
            return;
          }
          frames.push(gestureFrame);
        }

        const result = await faceApi.verify({
          frames,
          context,
          challengeId,
          deviceLabel: captureRef.current?.getDeviceLabel(),
          clientDurationMs: startedAtRef.current ? Date.now() - startedAtRef.current : undefined,
          neutralCapturedAt,
          gestureCapturedAt
        });
        if (cancelledRef.current) return;

        if (result.outcome === "PASSED" && result.verificationId) {
          setTone("success");
          setMessage(FRIENDLY.PASSED);
          onVerified(result.verificationId);
          onOpenChange(false);
          return;
        }
        // LOW_QUALITY means "we couldn't see you", not "we don't believe you" — so it doesn't
        // count as a failed attempt and doesn't get the error tone. Treating an unusable frame
        // as a failure is exactly what made this feel accusatory.
        if (result.outcome === "LOW_QUALITY") {
          setTone("info");
          setMessage(result.message ?? FRIENDLY.LOW_QUALITY);
          return;
        }
        setAttempts((n) => n + 1);
        setFlagged(Boolean(result.flagged));
        setTone("error");
        setMessage(result.message ?? FRIENDLY[result.outcome] ?? FRIENDLY.ERROR);
      } catch {
        if (cancelledRef.current) return;
        setAttempts((n) => n + 1);
        setTone("error");
        setMessage(FRIENDLY.ERROR);
      } finally {
        setOverlay(null);
        setBusy(false);
      }
    },
    [challengeOn, context, onOpenChange, onVerified]
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Caps at sm on desktop but goes near-full-width on phones, and scrolls rather than
          clipping if the viewport is short (landscape phones especially). */}
      <DialogContent className="max-h-[92vh] w-[calc(100vw-2rem)] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            Confirm it's you
          </DialogTitle>
          <DialogDescription>
            Your workspace requires a quick identity check before you {actionLabel}.
            {challengeOn
              ? " Look at the camera — the check starts by itself, then follow the short on-screen movement."
              : " Look at the camera — the photo is taken automatically when you're in frame."}
          </DialogDescription>
        </DialogHeader>

        <FaceCapture
          ref={captureRef}
          onCapture={handleCapture}
          busy={busy}
          hint={
            message ??
            (attempts >= MAX_AUTO_ATTEMPTS ? "Auto-scan paused after repeated misses — use the button when you're ready." : undefined)
          }
          hintTone={tone}
          captureLabel={challengeOn ? "Start check" : "Verify me"}
          overlayText={overlay}
          autoStart
          autoCapture={autoScanActive}
        />

        {/* The movement meter, repeated below the preview. The overlay version sits on a dark
            gradient over live video, which is exactly where a thin progress bar is hardest to
            read — and this is the one signal the person most needs while their head is turned
            away from the screen. */}
        {overlay && poseProgress > 0 && (
          <div className="grid gap-1.5" role="status" aria-live="polite">
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "h-full rounded-full transition-[width] duration-100",
                  poseProgress >= 1 ? "bg-success" : "bg-primary"
                )}
                style={{ width: `${Math.round(poseProgress * 100)}%` }}
              />
            </div>
            <p className="text-center text-xs text-muted-foreground">
              {poseProgress >= 1 ? "Got it — hold there" : "Keep turning until the bar fills"}
            </p>
          </div>
        )}

        {flagged && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              Several checks in a row didn't match, so this has been flagged for an administrator to review. You can keep trying — if
              it still won't work, contact your admin.
            </p>
          </div>
        )}

        {attempts > 0 && (
          <p className="text-center text-xs text-muted-foreground">
            {attempts} failed {attempts === 1 ? "attempt" : "attempts"} in this session
          </p>
        )}

        {insecureSkipAvailable && (
          <div className="rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm">
            <p className="text-muted-foreground">
              The camera can't open here because this connection is plain <strong>http</strong> — that's the
              browser's rule, not this app's. Your admin has allowed proceeding without the check on such
              connections. <strong>The skip is recorded</strong> in the verification log.
            </p>
            <Button variant="outline" className="mt-2 w-full" onClick={() => void handleSkip()} disabled={skipping || busy}>
              {skipping ? "Recording skip…" : "Continue without camera check"}
            </Button>
          </div>
        )}

        <div className="flex justify-end">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
