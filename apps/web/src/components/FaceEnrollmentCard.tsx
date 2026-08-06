/**
 * Profile → Face verification. Where an employee enrolls (with explicit consent), sees their
 * enrollment status, and withdraws consent.
 *
 * WHY consent is a real gate and not a formality: storing a face template without informed
 * consent is the specific thing GDPR Art.9 / Illinois BIPA / India's DPDP Act penalise. The
 * checkbox is unticked by default, the capture button stays disabled until it's ticked, and the
 * exact wording shown here is stored alongside the enrollment. "Delete my face data" is
 * deliberately prominent rather than buried — withdrawal has to be as easy as granting.
 *
 * Renders nothing at all when the workspace hasn't enabled the feature, so profiles stay clean
 * for the overwhelming majority of deployments that never turn this on.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Download, ScanFace, ShieldAlert, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { faceApi } from "../services/api";
import { useFaceStatus } from "../lib/use-face-status";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Checkbox } from "./ui/checkbox";
import { Label } from "./ui/label";
import { Skeleton } from "./ui/skeleton";
import { GuidedFaceEnrollment } from "./GuidedFaceEnrollment";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from "./ui/alert-dialog";

type TrainingReport = {
  templatesStored: number;
  framesSubmitted: number;
  frameResults: Array<{ index: number; accepted: boolean; quality: number | null; reason: string | null }>;
};

export function FaceEnrollmentCard() {
  const queryClient = useQueryClient();
  const status = useFaceStatus();
  const [consented, setConsented] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The last enrollment's per-shot verdicts — shown until dismissed, so "did the training
   *  actually take?" has a visible answer rather than a toast that vanished. */
  const [report, setReport] = useState<TrainingReport | null>(null);


  /**
   * Enrollment stores a SET of templates, one per head position, captured by the guided wizard.
   *
   * This used to be a burst — the pressed frame plus three more 280ms apart — on the theory that
   * natural micro-variation between them would broaden the template set. It does not: nobody
   * moves meaningfully in under a second, so all four frames described one angle in one light,
   * and a later check taken at any other angle scored 0.52-0.82 against a 0.75 bar. Pose variety
   * is the thing that actually helps, and it has to be asked for.
   *
   * The single-frame path below is kept for browsers with no WebGL, where the wizard cannot run.
   */
  const enroll = useMutation({
    mutationFn: async (frames: Blob[]) => faceApi.enroll(frames),
    onSuccess: (result) => {
      toast.success("Face model trained", {
        description: `${result.templatesStored} of ${result.framesSubmitted} ${result.framesSubmitted === 1 ? "shot" : "shots"} stored — more angles mean fewer failed checks later.`
      });
      setReport({
        templatesStored: result.templatesStored,
        framesSubmitted: result.framesSubmitted,
        frameResults: result.frameResults ?? []
      });
      setError(null);
      setCapturing(false);
      setConsented(false);
      queryClient.invalidateQueries({ queryKey: ["face", "status"] });
      // Enrollment may be the last onboarding requirement — lift the first-run gate immediately
      // instead of leaving a completed user staring at a popup that says they aren't done.
      queryClient.invalidateQueries({ queryKey: ["auth", "onboarding-status"] });
    },
    onError: (err: { response?: { data?: { message?: string } } }) => {
      const message = err?.response?.data?.message ?? "Enrollment failed. Please try again.";
      setError(message);
      toast.error("Couldn't complete setup", { description: message });
    }
  });

  const remove = useMutation({
    mutationFn: faceApi.deleteMyEnrollment,
    onSuccess: () => {
      toast.success("Your face data has been deleted");
      queryClient.invalidateQueries({ queryKey: ["face", "status"] });
    },
    onError: () => toast.error("Could not delete your face data")
  });

  if (status.isLoading) return <Skeleton className="h-48 w-full" />;
  const s = status.data;
  // Nothing to show if the workspace hasn't enabled this, and nothing to ask of a user the
  // policy doesn't cover. Approval coverage counts — an approver-only manager still needs
  // somewhere to enroll.
  if (!s?.enabled) return null;
  const covered = s.requiredForTimesheet || s.requiredForTicket || s.requiredForApproval;
  if (!covered && !s.enrolled) return null;

  const enrolledAndCurrent = s.enrolled && !s.needsReEnrollment;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ScanFace className="h-5 w-5" />
          Face verification
        </CardTitle>
        <CardDescription>
          Your workspace asks you to confirm your identity with a quick camera check when you{" "}
          {[
            s.requiredForTimesheet ? "submit a timesheet" : null,
            s.requiredForTicket ? "work on tickets" : null,
            s.requiredForApproval ? "approve timesheets" : null
          ]
            .filter(Boolean)
            .join(", ")
            .replace(/, ([^,]*)$/, " or $1") || "perform protected actions"}
          .
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {enrolledAndCurrent ? (
          <>
            <div className="flex items-start gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-medium">
                  You're set up — your face model holds {s.templateCount} reference{" "}
                  {s.templateCount === 1 ? "angle" : "angles"}.
                </p>
                <p>
                  Enrolled {s.enrolledAt ? new Date(s.enrolledAt).toLocaleDateString() : "recently"}. Captures are kept for{" "}
                  {s.imageRetentionDays === 0 ? "no time at all (images are never stored)" : `${s.imageRetentionDays} days`}, then
                  deleted automatically.
                </p>
              </div>
            </div>

            {/* An enrollment from before the guided wizard holds one angle in one light — the
                measured cause of the marginal 0.80-0.84 scores in the review log. Offered, never
                forced: a thin model is degraded accuracy, not a lockout. */}
            {s.needsBetterEnrollment && !capturing && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <p>
                  Your face model was captured before guided training existed, so it covers only{" "}
                  {s.templateCount === 1 ? "a single angle" : "two angles"}. Retraining takes about fifteen
                  seconds and makes checks far more reliable.
                </p>
              </div>
            )}

            {report && <TrainingReportPanel report={report} onDismiss={() => setReport(null)} />}

            {capturing ? (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Retrain your face model — this replaces the current reference set.
                </p>
                {error && <p className="text-sm text-destructive">{error}</p>}
                {/* The wizard carries its own Cancel — a second one below it was a duplicate. */}
                <GuidedFaceEnrollment
                  busy={enroll.isPending}
                  onComplete={(frames) => enroll.mutate(frames)}
                  onCancel={() => setCapturing(false)}
                />
              </div>
            ) : (
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button
                  variant={s.needsBetterEnrollment ? "default" : "outline"}
                  onClick={() => setCapturing(true)}
                  className="w-full sm:w-auto"
                >
                  <ScanFace className="mr-2 h-4 w-4" />
                  Retrain face model
                </Button>
                <Button
                  variant="outline"
                  className="w-full sm:w-auto"
                  onClick={async () => {
                    // Data-subject access, self-service: everything held about your face
                    // verification (metadata only — never the template), as a JSON download.
                    try {
                      const data = await faceApi.exportMyData();
                      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = `face-data-export-${new Date().toISOString().slice(0, 10)}.json`;
                      a.click();
                      URL.revokeObjectURL(url);
                    } catch {
                      toast.error("Could not export your face data");
                    }
                  }}
                >
                  <Download className="mr-2 h-4 w-4" />
                  Download my data
                </Button>
                <DeleteFaceDataButton onConfirm={() => remove.mutate()} pending={remove.isPending} />
              </div>
            )}
          </>
        ) : (
          <>
            {s.needsReEnrollment && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <p>Your enrollment was made with an older version and needs to be redone before verification will work.</p>
              </div>
            )}

            <div className="rounded-lg border border-border bg-muted/30 p-4">
              <p className="mb-3 text-sm text-muted-foreground">{s.consentText}</p>
              <div className="flex items-start gap-2">
                <Checkbox id="face-consent" checked={consented} onCheckedChange={(v) => setConsented(v === true)} className="mt-0.5" />
                <Label htmlFor="face-consent" className="cursor-pointer text-sm font-normal leading-snug">
                  I have read and consent to the above.
                </Label>
              </div>
            </div>

            {consented ? (
              <>
                {error && <p className="mb-3 text-sm text-destructive">{error}</p>}
                <GuidedFaceEnrollment
                  busy={enroll.isPending}
                  onComplete={(frames) => enroll.mutate(frames)}
                  onCancel={() => setConsented(false)}
                />
              </>
            ) : (
              <p className="text-center text-sm text-muted-foreground">Tick the box above to turn on your camera.</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The per-shot outcome of the last training run. A toast can say "3 images stored"; only a
 * persistent report can say WHICH shot failed and why, which is what makes a retake targeted
 * rather than a shrug-and-redo-everything.
 */
function TrainingReportPanel({ report, onDismiss }: { report: TrainingReport; onDismiss: () => void }) {
  const allGood = report.templatesStored === report.framesSubmitted;
  return (
    // min-w-0 + wrapping headers: this panel lives inside a CSS-grid page column, whose children
    // default to min-width:auto — the exact mechanism by which a long rejection reason was
    // pushing the whole card wider than a phone screen.
    <div className="min-w-0 rounded-lg border border-border bg-muted/30 p-3" role="status">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 text-sm font-medium">
          Training {allGood ? "complete" : "finished"} — {report.templatesStored} of {report.framesSubmitted}{" "}
          {report.framesSubmitted === 1 ? "shot" : "shots"} stored
        </p>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
      <ul className="grid gap-1.5">
        {report.frameResults.map((f) => (
          <li key={f.index} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            {f.accepted ? (
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
            )}
            <span className="shrink-0 font-medium">Shot {f.index + 1}</span>
            {f.accepted ? (
              <span className="flex min-w-24 flex-1 items-center gap-2 text-muted-foreground">
                <span className="h-1.5 w-full max-w-24 overflow-hidden rounded-full bg-muted">
                  <span
                    className="block h-full rounded-full bg-emerald-500/70"
                    style={{ width: `${Math.round((f.quality ?? 0) * 100)}%` }}
                  />
                </span>
                <span className="whitespace-nowrap">quality {(f.quality ?? 0).toFixed(2)}</span>
              </span>
            ) : (
              // Full width on phones — an indented, wrapping line people can actually read —
              // and inline-truncated (title carries the full text) where the row has room.
              <span
                className="basis-full pl-5 text-muted-foreground sm:basis-auto sm:min-w-0 sm:flex-1 sm:truncate sm:pl-0"
                title={f.reason ?? undefined}
              >
                {f.reason}
              </span>
            )}
          </li>
        ))}
      </ul>
      {!allGood && (
        <p className="mt-2 text-xs text-muted-foreground">
          The stored shots are enough to verify with. Retrain whenever you like to replace the set with a
          fuller one.
        </p>
      )}
    </div>
  );
}

function DeleteFaceDataButton({ onConfirm, pending }: { onConfirm: () => void; pending: boolean }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" className="w-full text-destructive hover:text-destructive sm:w-auto" disabled={pending}>
          <Trash2 className="mr-2 h-4 w-4" />
          Delete my face data
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete your face data?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently deletes your stored face template and every captured image, and withdraws your consent. If your
            workspace still requires face verification, you won't be able to submit until you enroll again.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
            Delete permanently
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
