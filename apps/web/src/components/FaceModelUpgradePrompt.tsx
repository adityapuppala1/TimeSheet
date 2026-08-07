/**
 * WHAT: the app-wide prompt that walks a single-pose user through the guided four-pose wizard,
 * in place, without sending them anywhere.
 *
 * WHY IT IS A DIALOG AND NOT ANOTHER BANNER: the measured failure is concentrated in exactly this
 * population — a quarter of real attempts came back NO_MATCH, and most enrollments hold one angle.
 * A person retrying a check against a one-angle reference set gets the same marginal score every
 * time, so the fix is never "try again", it is fifteen seconds in the wizard. Profile already
 * carried an amber hint and the verification dialog carried a link, and neither moved the number:
 * a hint on a page you have no reason to open is a hint nobody reads.
 *
 * WHY IT IS STILL NOT A GATE, and this is the line that must not move: a thin model is degraded
 * accuracy, not a security failure. Enforcement is the `enforcementMode` setting's job. This
 * dialog is dismissible, snoozes for a day, and never touches whether a timesheet can be
 * submitted — closing it costs the user nothing but their own reliability.
 *
 * WHO renders this: layouts/AppLayout.tsx, once, for the whole authenticated app.
 */
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ScanFace } from "lucide-react";
import { toast } from "sonner";
import { faceApi } from "../services/api";
import { useFaceStatus } from "../lib/use-face-status";
import { useAuthStore } from "../store/auth";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { GuidedFaceEnrollment } from "./GuidedFaceEnrollment";

/** Per-user so a shared machine doesn't snooze the prompt for the next person to sign in. */
const snoozeKey = (userId: string) => `face.retrain-snooze.${userId}`;
/** A day. Long enough not to be a nag, short enough that "later" doesn't mean "never" — the whole
 *  point is that the passive surfaces already tried "whenever you feel like it". */
const SNOOZE_MS = 24 * 60 * 60 * 1000;

function snoozedUntil(userId: string): number {
  const raw = localStorage.getItem(snoozeKey(userId));
  const value = raw ? Number(raw) : 0;
  return Number.isFinite(value) ? value : 0;
}

export function FaceModelUpgradePrompt() {
  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();
  const status = useFaceStatus(Boolean(user));
  const [open, setOpen] = useState(false);
  const [started, setStarted] = useState(false);

  const s = status.data;
  // Only ever the enrolled-but-thin case. Not-enrolled is OnboardingGate's job (it blocks, because
  // that one genuinely stops work), and a stale model is a different ask with different wording.
  const eligible = Boolean(
    user &&
      s?.enabled &&
      s.enrolled &&
      !s.needsReEnrollment &&
      s.needsBetterEnrollment &&
      (s.requiredForTimesheet || s.requiredForTicket || s.requiredForApproval)
  );

  useEffect(() => {
    if (!eligible || !user) return;
    if (Date.now() < snoozedUntil(user.id)) return;
    setOpen(true);
  }, [eligible, user?.id]);

  const enroll = useMutation({
    mutationFn: async (frames: Blob[]) => faceApi.enroll(frames),
    onSuccess: (result) => {
      toast.success("Face model retrained", {
        description: `${result.templatesStored} angles stored — identity checks should stop failing now.`
      });
      queryClient.invalidateQueries({ queryKey: ["face", "status"] });
      setStarted(false);
      setOpen(false);
    },
    onError: (error: { response?: { data?: { message?: string } } }) => {
      toast.error("Couldn't retrain", { description: error?.response?.data?.message ?? "Please try again." });
    }
  });

  if (!eligible || !user) return null;

  const dismiss = () => {
    localStorage.setItem(snoozeKey(user.id), String(Date.now() + SNOOZE_MS));
    setStarted(false);
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : dismiss())}>
      {/* Not `[&>button]:hidden` — the corner close stays reachable, and routes to the same
          snooze. A prompt you cannot close is a gate, and this is deliberately not one. */}
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScanFace className="h-5 w-5" />
            Your identity checks are failing for a fixable reason
          </DialogTitle>
          <DialogDescription>
            Your face model holds {s!.templateCount === 1 ? "a single angle" : "two angles"}, captured before guided
            training existed. Checks taken from any other angle score just under the bar, which is why they come back
            as "no match" no matter how many times you retry. Four quick head positions replaces the whole reference
            set — about fifteen seconds.
          </DialogDescription>
        </DialogHeader>

        {started ? (
          <GuidedFaceEnrollment busy={enroll.isPending} onComplete={(frames) => enroll.mutate(frames)} onCancel={dismiss} />
        ) : (
          <DialogFooter className="gap-2 sm:justify-between">
            <Button variant="ghost" onClick={dismiss}>
              Not now
            </Button>
            <Button onClick={() => setStarted(true)}>
              <ScanFace className="mr-2 h-4 w-4" />
              Retrain now
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
