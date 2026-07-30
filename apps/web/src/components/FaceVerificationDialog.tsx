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
 * frame, THEN the server-issued instruction appears over the live preview with a short
 * countdown, and a second frame is grabbed automatically — the user never presses a second
 * button. The instruction is fetched only AFTER the first frame exists, so a replayed recording
 * can't have known what movement would be demanded. All enforcement is server-side
 * (services/face.service.ts); this component only choreographs capture.
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
import { faceApi, type FaceOutcome } from "../services/api";
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
  NO_MATCH: "We couldn't confirm it's you. Try again with better lighting and your face centred.",
  SPOOF_SUSPECTED: "That didn't look like a live capture. Look directly at the camera rather than holding up a photo or screen.",
  CHALLENGE_FAILED: "We couldn't see the requested head movement — face the camera first, then make the movement clearly.",
  LOW_QUALITY: "We couldn't see you clearly enough — adjust and try again.",
  NOT_ENROLLED: "You haven't set up face verification yet — do that in your profile first.",
  ERROR: "Something went wrong during verification. Please try again."
};

/** Seconds between showing the instruction and grabbing the gesture frame — long enough to
 *  physically turn a head, short enough that holding the pose isn't uncomfortable. */
const GESTURE_COUNTDOWN_SECONDS = 3;

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
  /** Set when this attempt starts, so the server can be told what the human actually waited
   *  for — the number the <1s p50 budget is tracked against. */
  const startedAtRef = useRef<number | null>(null);

  const status = useFaceStatus(open);
  const challengeOn = status.data?.challengeEnabled ?? true;

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

          for (let remaining = GESTURE_COUNTDOWN_SECONDS; remaining > 0; remaining--) {
            if (cancelledRef.current) return;
            setOverlay(`${challenge.prompt} — capturing in ${remaining}…`);
            await sleep(1000);
          }
          setOverlay("Hold it…");
          const gestureFrame = await captureRef.current?.captureFrame();
          gestureCapturedAt = Date.now();
          setOverlay(null);
          if (cancelledRef.current) return;
          if (!gestureFrame) {
            setTone("error");
            setMessage("The camera stopped before the second frame — please try again.");
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

        <div className="flex justify-end">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
