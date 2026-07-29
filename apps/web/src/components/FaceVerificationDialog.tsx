/**
 * WHAT: the modal that stands between "user pressed Submit" and the submission actually
 * happening, when the workspace's face-verification policy covers them. Captures a frame,
 * sends it for server-side verification, and on success hands the caller a single-use
 * `verificationId` to include with the submit.
 * WHY a dialog rather than an inline panel: the check is a deliberate interruption — it should
 * be obvious that identity is being confirmed, and it must be dismissible without silently
 * submitting anything.
 *
 * Retry posture matches the server's (see face.service.ts): a failed check is NOT a lockout.
 * The user can retry; after `maxAttempts` consecutive failures the server flags the attempt for
 * admin review, and the dialog says so plainly instead of pretending nothing happened —
 * lighting and glasses make honest failures common, so the copy never accuses.
 */
import { useCallback, useEffect, useState } from "react";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";
import { FaceCapture } from "./FaceCapture";
import { faceApi, type FaceOutcome } from "../services/api";

interface FaceVerificationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  context: "TIMESHEET" | "TICKET";
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
  NOT_ENROLLED: "You haven't set up face verification yet — do that in your profile first.",
  ERROR: "Something went wrong during verification. Please try again."
};

export function FaceVerificationDialog({ open, onOpenChange, context, onVerified, actionLabel = "continue" }: FaceVerificationDialogProps) {
  const [busy, setBusy] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [tone, setTone] = useState<"info" | "error" | "success">("info");
  const [flagged, setFlagged] = useState(false);

  // Reset on each open — a stale "couldn't confirm it's you" from last time would be alarming.
  useEffect(() => {
    if (open) {
      setAttempts(0);
      setMessage(null);
      setTone("info");
      setFlagged(false);
      setBusy(false);
    }
  }, [open]);

  const handleCapture = useCallback(
    async (blob: Blob) => {
      setBusy(true);
      setMessage(null);
      try {
        const result = await faceApi.verify(blob, context);
        if (result.outcome === "PASSED" && result.verificationId) {
          setTone("success");
          setMessage(FRIENDLY.PASSED);
          onVerified(result.verificationId);
          onOpenChange(false);
          return;
        }
        setAttempts((n) => n + 1);
        setFlagged(Boolean(result.flagged));
        setTone("error");
        setMessage(result.message ?? FRIENDLY[result.outcome] ?? FRIENDLY.ERROR);
      } catch {
        setAttempts((n) => n + 1);
        setTone("error");
        setMessage(FRIENDLY.ERROR);
      } finally {
        setBusy(false);
      }
    },
    [context, onOpenChange, onVerified]
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
            Your workspace requires a quick identity check before you {actionLabel}. Look at the camera and capture a photo.
          </DialogDescription>
        </DialogHeader>

        <FaceCapture onCapture={handleCapture} busy={busy} hint={message ?? undefined} hintTone={tone} captureLabel="Verify me" />

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
