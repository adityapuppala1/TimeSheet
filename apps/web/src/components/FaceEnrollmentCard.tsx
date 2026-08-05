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

export function FaceEnrollmentCard() {
  const queryClient = useQueryClient();
  const status = useFaceStatus();
  const [consented, setConsented] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);


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
      toast.success("Face verification set up", {
        description: `${result.templatesStored} reference ${result.templatesStored === 1 ? "image" : "images"} stored — more variation means fewer failed checks later.`
      });
      setError(null);
      setCapturing(false);
      setConsented(false);
      queryClient.invalidateQueries({ queryKey: ["face", "status"] });
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
                <p className="font-medium">You're set up.</p>
                <p>
                  Enrolled {s.enrolledAt ? new Date(s.enrolledAt).toLocaleDateString() : "recently"}. Captures are kept for{" "}
                  {s.imageRetentionDays === 0 ? "no time at all (images are never stored)" : `${s.imageRetentionDays} days`}, then
                  deleted automatically.
                </p>
              </div>
            </div>

            {capturing ? (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Retake your reference photos — this replaces the current set.
                </p>
                {error && <p className="text-sm text-destructive">{error}</p>}
                <GuidedFaceEnrollment
                  busy={enroll.isPending}
                  onComplete={(frames) => enroll.mutate(frames)}
                  onCancel={() => setCapturing(false)}
                />
                <div className="flex justify-center">
                  <Button variant="ghost" onClick={() => setCapturing(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button variant="outline" onClick={() => setCapturing(true)} className="w-full sm:w-auto">
                  <ScanFace className="mr-2 h-4 w-4" />
                  Retake photo
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
