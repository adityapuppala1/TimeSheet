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
import { Link } from "react-router";
import { ScanFace, ShieldAlert, ShieldCheck } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";
import { FaceCapture, type FaceCaptureHandle } from "./FaceCapture";
import { faceApi, type FaceChallenge, type FaceOutcome } from "../services/api";
import { awaitPose, poseCoaching, type PoseBlock } from "../lib/face-pose";
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
  /** Never returned by /face/verify — POST /face/skip mints it directly (see the insecure-context
   *  bypass). Present so this map stays exhaustive over FaceOutcome, and worded honestly in case
   *  it ever does reach the fallback below: the submission went through UNCHECKED. */
  SKIPPED_INSECURE: "The camera check was skipped because this connection isn't secure — your submission was recorded as unverified.",
  ERROR: "Something went wrong during verification. Please try again."
};

/**
 * How long to wait for the head movement before giving up on it.
 *
 * This REPLACED a fixed 3-second countdown, and the reason is the most instructive number in this
 * feature. Of the 107 recorded CHALLENGE_FAILED attempts, 19 came from a real browser (the rest
 * were a scripted load posting one frame twice, or a stale challenge id). EVERY ONE of those 19
 * fell SHORT on the demanded axis — mean 0.09 rad against a 0.35 yaw requirement, 0.12 against a
 * 0.22 pitch one, roughly a quarter of the way. Not one failed for turning far enough in the
 * wrong direction. People were not refusing to move their heads; they had no way to know how far
 * was far enough, and the countdown then grabbed whatever frame the timer landed on.
 *
 * Now the shutter is fired by the movement itself, at the peak of the turn, and this is only the
 * ceiling on how long to keep watching. Raised from 9s to match enrollment's per-step window: the
 * meter means the window is now spent doing something useful — reading the instruction, moving,
 * watching the bar — rather than waiting out a timer, and an unhurried correct capture beats a
 * fast wrong one. The challenge's own server-side lifetime (90s) is the real bound.
 */
const GESTURE_WINDOW_MS = 12_000;

/**
 * Fire the shutter this far ABOVE the server's stated minimum.
 *
 * The client measures pose from the preview stream; the server re-measures from the two JPEGs it
 * receives, at a different instant and a different resolution. Firing exactly on the line lands a
 * meaningful share of captures on the wrong side of it — and a check refused after the meter read
 * "done" makes the feature look broken rather than strict, which is worse than showing no meter.
 * 1.15 is about 3° of extra yaw: unnoticeable to perform, comfortably outside the disagreement.
 *
 * This only ever TIGHTENS what the client submits. The server still measures the delta itself and
 * still decides; nothing here can make a movement acceptable that the server would refuse.
 */
const CHALLENGE_FIRE_MARGIN = 1.15;

/**
 * Turns a missed movement into something the person can act on next time.
 *
 * The old copy said "we couldn't see the head movement" whether they had moved 5% of the way or
 * had tilted when asked to turn — and the measured failures were overwhelmingly the former, with
 * a meaningful minority of the latter (8 of the 19 real-browser failures had the wrong axis
 * dominating). A number and a direction are the two things that make the retry different from
 * the attempt.
 *
 * The percentage is against the same point the meter fills to, so the message and the bar can
 * never tell the person two different stories about how close they got.
 */
function describeMiss(block: PoseBlock, bestDelta: number, challenge: FaceChallenge): string {
  switch (block) {
    case "no-face":
      return "We lost sight of your face while you moved. Keep looking towards the camera as you turn, and try again.";
    case "multiple-faces":
      return "Someone else came into frame during the check. Make sure you're alone in shot, then try again.";
    case "wrong-axis":
      return challenge.axis === "yaw"
        ? "That read as a tilt rather than a turn. Keep your head level and turn to one side until the bar fills."
        : "That read as a turn rather than a tilt. Keep facing the camera and lift your chin until the bar fills.";
    default: {
      const pct = Math.min(99, Math.round((bestDelta / (challenge.minDelta * CHALLENGE_FIRE_MARGIN)) * 100));
      const move = challenge.axis === "yaw" ? "Turn your head to one side" : "Tilt your head up";
      return pct >= 15
        ? `You got about ${pct}% of the way. ${move} a little further and hold it until the bar fills.`
        : `We didn't see the movement. ${move} until the bar fills, then hold it for a moment.`;
    }
  }
}

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
  /** The last refusal, so the dialog can offer the fix that actually matches it — a thin
   *  enrollment and a missed head-turn need completely different advice. */
  const [lastOutcome, setLastOutcome] = useState<FaceOutcome | null>(null);
  const [overlay, setOverlay] = useState<string | null>(null);
  /** The live state of the head movement: how far through, what is currently blocking, and how
   *  long is left. The whole point of the rework — the requirement was always this, it was just
   *  invisible until the frame had already been judged. */
  const [pose, setPose] = useState<{ progress: number; block: PoseBlock }>({ progress: 0, block: "short" });
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  /** The challenge being performed right now — kept in state because the coaching copy needs its
   *  axis, and the meter needs to know it is running at all. */
  const [activeChallenge, setActiveChallenge] = useState<FaceChallenge | null>(null);
  /** Set when this attempt starts, so the server can be told what the human actually waited
   *  for — the number the <1s p50 budget is tracked against. */
  const startedAtRef = useRef<number | null>(null);
  /** Wall-clock end of the movement window, so the countdown and the loop can't disagree. */
  const gestureDeadlineRef = useRef<number | null>(null);

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
      setLastOutcome(null);
      setBusy(false);
      setOverlay(null);
      setActiveChallenge(null);
      setSecondsLeft(null);
      setPose({ progress: 0, block: "short" });
    } else {
      cancelledRef.current = true;
    }
  }, [open]);

  // The countdown that goes with the meter. Time pressure has to be VISIBLE: a window that
  // expires silently is indistinguishable from a check that has hung, and both end with the
  // person closing the dialog.
  useEffect(() => {
    if (!activeChallenge) {
      setSecondsLeft(null);
      return;
    }
    const tick = () => {
      const remaining = gestureDeadlineRef.current ? gestureDeadlineRef.current - Date.now() : 0;
      setSecondsLeft(Math.max(0, Math.ceil(remaining / 1000)));
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [activeChallenge]);

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
        let missReason: string | null = null;

        if (challengeOn) {
          // The instruction is requested only now — AFTER the neutral frame exists — so a
          // pre-recorded video can't have anticipated it.
          const challenge = await faceApi.challenge(context);
          challengeId = challenge.challengeId;

          // The pose the neutral frame was taken at. Every delta below is measured against this,
          // exactly as the server measures it against the neutral frame it receives.
          const neutralPose = captureRef.current?.getReading();
          const trackerLive = Boolean(neutralPose && neutralPose.faceCount > 0);
          setOverlay(challenge.prompt);

          let gestureFrame: Blob | null = null;
          if (trackerLive && neutralPose) {
            gestureDeadlineRef.current = Date.now() + GESTURE_WINDOW_MS;
            setActiveChallenge(challenge);
            setPose({ progress: 0, block: "short" });
            // ONE implementation of this loop, shared with guided enrollment. The dialog used to
            // carry its own copy that fired exactly on the server's minimum and mis-handled the
            // peak hold — two loops that disagreed about where the line is.
            const result = await awaitPose({
              getReading: () => captureRef.current?.getReading(),
              captureFrame: async () => (await captureRef.current?.captureFrame()) ?? null,
              neutral: neutralPose,
              target: {
                axis: challenge.axis,
                minDelta: challenge.minDelta,
                // Both mirror rules the server enforces, so the client never submits a frame it
                // can already tell will be refused.
                requireDominance: true,
                fireMargin: CHALLENGE_FIRE_MARGIN
              },
              windowMs: GESTURE_WINDOW_MS,
              onProgress: (progress, block) => setPose({ progress, block }),
              isCancelled: () => cancelledRef.current
            });
            gestureFrame = result.blob;
            if (!gestureFrame) missReason = describeMiss(result.block, result.bestAttemptDelta, challenge);
          } else {
            // No tracker (no WebGL, models blocked): fall back to the old timed grab. Worse, but
            // it is the behaviour that shipped, and it is better than refusing to verify.
            setOverlay(`${challenge.prompt} — capturing in 3…`);
            await sleep(3000);
            gestureFrame = (await captureRef.current?.captureFrame()) ?? null;
          }

          gestureCapturedAt = Date.now();
          setOverlay(null);
          setActiveChallenge(null);
          if (cancelledRef.current) return;
          if (!gestureFrame) {
            // Counts toward the ceiling even though no attempt row exists server-side. Without
            // this the hands-free scanner re-arms the moment `busy` drops, so somebody who can't
            // produce the movement is put straight back into another window — an unbreakable
            // loop that burns a fresh challenge each pass and never offers the manual button.
            setAttempts((n) => n + 1);
            setTone("error");
            // Naming what actually went wrong is the difference between a person learning the
            // movement and a person concluding the check is broken. The old copy said the same
            // thing whether they turned 5% of the way or tilted instead of turning.
            setMessage(missReason ?? "We didn't see the head movement in time. Face the camera, then move clearly and hold it for a moment.");
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
        setLastOutcome(result.outcome);
        setTone("error");
        setMessage(result.message ?? FRIENDLY[result.outcome] ?? FRIENDLY.ERROR);
      } catch {
        if (cancelledRef.current) return;
        setAttempts((n) => n + 1);
        setTone("error");
        setMessage(FRIENDLY.ERROR);
      } finally {
        setOverlay(null);
        setActiveChallenge(null);
        setBusy(false);
      }
    },
    [challengeOn, context, onOpenChange, onVerified]
  );

  const poseMeter = activeChallenge
    ? {
        progress: pose.progress,
        satisfied: pose.block === "ready",
        coaching: poseCoaching(pose.block, activeChallenge.axis, pose.progress),
        secondsLeft
      }
    : null;

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
          poseMeter={poseMeter}
          autoStart
          autoCapture={autoScanActive}
          // The dialog's own Cancel closes and unmounting stops the camera — FaceCapture's
          // "Turn off" here was a duplicate that read like a second cancel.
          controls="capture-only"
        />

        {/* The movement meter, repeated below the preview. The overlay version sits on a dark
            gradient over live video, which is exactly where a thin progress bar is hardest to
            read — and this is the one signal the person most needs while their head is turned
            away from the screen. Rendered from the FIRST tick rather than waiting for progress
            to be non-zero: appearing only once you have already moved is backwards, because not
            knowing to move is the failure being fixed. */}
        {poseMeter && (
          <div className="grid gap-1.5">
            <div
              role="progressbar"
              aria-label="Head movement progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(poseMeter.progress * 100)}
              className="h-2 w-full overflow-hidden rounded-full bg-muted"
            >
              <div
                className={cn(
                  "h-full rounded-full motion-safe:transition-[width,background-color] motion-safe:duration-100",
                  poseMeter.satisfied ? "bg-success" : "bg-primary"
                )}
                style={{ width: `${Math.round(poseMeter.progress * 100)}%` }}
              />
            </div>
            {/* aria-live on the text only. The bar's own value updates ~12 times a second, and a
                live region over it would talk continuously; the coaching line changes only when
                the advice actually changes. */}
            <p className="text-center text-xs text-muted-foreground" role="status" aria-live="polite">
              {poseMeter.coaching}
              {secondsLeft != null && !poseMeter.satisfied ? ` · ${secondsLeft}s left` : ""}
            </p>
          </div>
        )}

        {/* THE FIX THAT MATCHES THE FAILURE. A no-match against a single-angle enrollment is not
            a "try again" problem — retrying the same thin reference set from the same chair
            produces the same marginal score, which is what the 0.80-0.84 cluster in the review
            log is. Shown only when the server says the model is thin, so it never nags somebody
            whose enrollment is already good. */}
        {lastOutcome === "NO_MATCH" && status.data?.needsBetterEnrollment && (
          <div className="flex items-start gap-2 rounded-lg border border-primary/40 bg-primary/5 p-3 text-sm">
            <ScanFace className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <div className="min-w-0">
              <p className="text-muted-foreground">
                Your face model holds only {status.data.templateCount === 1 ? "one angle" : "two angles"}, which makes
                checks from any other angle marginal. Retraining takes about fifteen seconds and is the thing most
                likely to fix this.
              </p>
              <Button asChild variant="outline" size="sm" className="mt-2">
                <Link to="/profile" onClick={() => onOpenChange(false)}>
                  Retrain my face model
                </Link>
              </Button>
            </div>
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
