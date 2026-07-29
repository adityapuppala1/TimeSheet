/**
 * Workspace Settings → Face verification. Master switch, scope, calibration thresholds,
 * retention, consent wording, and the review log of flagged attempts.
 *
 * Follows this app's established settings-card conventions: switches save immediately (no Save
 * button), numeric/text groups keep local state behind an explicit Save, non-super-admins see
 * the card read-only rather than not at all.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Eye, Save, ScanFace, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { faceApi, settingsApi, type FaceAttemptRow } from "../../services/api";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Skeleton } from "../../components/ui/skeleton";
import { Switch } from "../../components/ui/switch";
import { Textarea } from "../../components/ui/textarea";
import { Badge } from "../../components/ui/badge";

const OUTCOME_TONE: Record<string, string> = {
  PASSED: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  NO_MATCH: "bg-destructive/10 text-destructive",
  SPOOF_SUSPECTED: "bg-destructive/10 text-destructive",
  MULTIPLE_FACES: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  NO_FACE: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  NOT_ENROLLED: "bg-muted text-muted-foreground",
  ERROR: "bg-muted text-muted-foreground"
};

export function FaceVerificationSettingsCard({ readOnly = false }: { readOnly?: boolean }) {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["settings", "face-verification"], queryFn: settingsApi.getFaceVerification });

  const update = useMutation({
    mutationFn: settingsApi.updateFaceVerification,
    onSuccess: () => {
      toast.success("Saved");
      queryClient.invalidateQueries({ queryKey: ["settings", "face-verification"] });
    },
    onError: (err: { response?: { data?: { message?: string } } }) =>
      toast.error("Could not save", { description: err?.response?.data?.message ?? "Try again." })
  });

  const [tuning, setTuning] = useState({
    matchThreshold: "0.75",
    antispoofThreshold: "0.5",
    livenessThreshold: "0.6",
    maxAttempts: "3",
    verificationTtlSeconds: "300",
    imageRetentionDays: "30"
  });
  const [consentText, setConsentText] = useState("");

  useEffect(() => {
    const s = settings.data;
    if (!s) return;
    setTuning({
      matchThreshold: String(s.matchThreshold),
      antispoofThreshold: String(s.antispoofThreshold),
      livenessThreshold: String(s.livenessThreshold),
      maxAttempts: String(s.maxAttempts),
      verificationTtlSeconds: String(s.verificationTtlSeconds),
      imageRetentionDays: String(s.imageRetentionDays)
    });
    setConsentText(s.consentText ?? "");
  }, [settings.data]);

  if (settings.isLoading) return <Skeleton className="h-64 w-full" />;
  const s = settings.data;
  const enabled = s?.enabled ?? false;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ScanFace className="h-5 w-5" />
            Face verification
          </CardTitle>
          <CardDescription>
            Require a live camera check confirming the person submitting a timesheet or ticket is the account holder — closing the
            gap where one employee submits on another's behalf.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Biometric data carries real legal obligations. Saying so at the point of decision is
              far more useful than burying it in docs the person flipping this switch won't read. */}
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              This collects <strong>biometric data</strong>, which is regulated (GDPR Art.9, Illinois BIPA, India's DPDP Act and
              others). Employees are asked for explicit consent before enrolling, can withdraw it at any time, and captured images
              are auto-deleted on the retention schedule below. Check your obligations before enabling this for real staff.
            </p>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border bg-muted/30 p-4">
            <div className="space-y-0.5 pr-4">
              <Label>Enable face verification</Label>
              <p className="text-sm text-muted-foreground">Everything below is inactive while this is off.</p>
            </div>
            <Switch checked={enabled} disabled={readOnly} onCheckedChange={(v) => update.mutate({ enabled: v })} />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex items-center justify-between rounded-lg border border-border bg-muted/30 p-4">
              <div className="space-y-0.5 pr-4">
                <Label>Require on timesheet submit</Label>
              </div>
              <Switch
                checked={s?.requireForTimesheet ?? true}
                disabled={readOnly || !enabled}
                onCheckedChange={(v) => update.mutate({ requireForTimesheet: v })}
              />
            </div>
            <div className="flex items-center justify-between rounded-lg border border-border bg-muted/30 p-4">
              <div className="space-y-0.5 pr-4">
                <Label>Require on ticket create</Label>
              </div>
              <Switch
                checked={s?.requireForTicket ?? false}
                disabled={readOnly || !enabled}
                onCheckedChange={(v) => update.mutate({ requireForTicket: v })}
              />
            </div>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border bg-muted/30 p-4">
            <div className="space-y-0.5 pr-4">
              <Label>Apply to everyone</Label>
              <p className="text-sm text-muted-foreground">
                On: every active user must enroll and verify. Off: only users you switch on individually in{" "}
                <strong>Users → edit → Require face verification</strong>.
              </p>
            </div>
            <Switch
              checked={s?.enforcementMode === "ALL"}
              disabled={readOnly || !enabled}
              onCheckedChange={(v) => update.mutate({ enforcementMode: v ? "ALL" : "SELECTED" })}
            />
          </div>

          <div className="rounded-lg border border-border bg-muted/30 p-4">
            <p className="mb-3 text-sm font-medium">Calibration</p>
            <p className="mb-3 text-sm text-muted-foreground">
              Match threshold is how similar a capture must be to the enrolled face. Measured against this model: two different
              people score around <strong>0.23–0.67</strong>, the same person around <strong>0.83+</strong>. The default 0.75 sits
              in that gap. Every attempt records its score in the log below, so you can tune this against your own staff rather
              than a default.
            </p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {(
                [
                  ["matchThreshold", "Match threshold", "0.3 – 0.99"],
                  ["antispoofThreshold", "Anti-spoof floor", "0 – 0.99"],
                  ["livenessThreshold", "Liveness floor", "0 – 0.99"],
                  ["maxAttempts", "Failures before flagging", "1 – 10"],
                  ["verificationTtlSeconds", "Check valid for (seconds)", "30 – 3600"],
                  ["imageRetentionDays", "Keep images (days)", "0 = never store"]
                ] as const
              ).map(([key, label, hint]) => (
                <div key={key} className="grid gap-1.5">
                  <Label htmlFor={`face-${key}`}>{label}</Label>
                  <Input
                    id={`face-${key}`}
                    inputMode="decimal"
                    value={tuning[key]}
                    disabled={readOnly || !enabled}
                    onChange={(e) => setTuning((t) => ({ ...t, [key]: e.target.value }))}
                  />
                  <p className="text-xs text-muted-foreground">{hint}</p>
                </div>
              ))}
            </div>
            <Button
              className="mt-3"
              disabled={readOnly || !enabled || update.isPending}
              onClick={() =>
                update.mutate({
                  matchThreshold: Number(tuning.matchThreshold),
                  antispoofThreshold: Number(tuning.antispoofThreshold),
                  livenessThreshold: Number(tuning.livenessThreshold),
                  maxAttempts: Number(tuning.maxAttempts),
                  verificationTtlSeconds: Number(tuning.verificationTtlSeconds),
                  imageRetentionDays: Number(tuning.imageRetentionDays)
                })
              }
            >
              <Save className="mr-2 h-4 w-4" />
              Save calibration
            </Button>
          </div>

          <div className="rounded-lg border border-border bg-muted/30 p-4">
            <Label htmlFor="face-consent">Consent wording</Label>
            <p className="mb-2 mt-1 text-sm text-muted-foreground">
              Shown on the enrollment screen and stored verbatim with each enrollment, so there's a durable record of exactly what
              each person agreed to. Leave blank to use the built-in default.
            </p>
            <Textarea
              id="face-consent"
              rows={4}
              value={consentText}
              disabled={readOnly || !enabled}
              placeholder="Leave blank to use the default consent wording."
              onChange={(e) => setConsentText(e.target.value)}
            />
            <Button
              className="mt-3"
              disabled={readOnly || !enabled || update.isPending}
              onClick={() => update.mutate({ consentText: consentText.trim() || null })}
            >
              <Save className="mr-2 h-4 w-4" />
              Save wording
            </Button>
          </div>
        </CardContent>
      </Card>

      <FaceReviewLog readOnly={readOnly} />
    </div>
  );
}

/** The audit surface — recent attempts, flagged ones first, with the scores behind each decision. */
function FaceReviewLog({ readOnly }: { readOnly: boolean }) {
  const queryClient = useQueryClient();
  const [flaggedOnly, setFlaggedOnly] = useState(true);
  const attempts = useQuery({
    queryKey: ["face", "attempts", flaggedOnly],
    queryFn: () => faceApi.listAttempts({ flaggedOnly, take: 50 })
  });

  const review = useMutation({
    mutationFn: (id: string) => faceApi.reviewAttempt(id),
    onSuccess: () => {
      toast.success("Marked reviewed");
      queryClient.invalidateQueries({ queryKey: ["face", "attempts"] });
    },
    onError: () => toast.error("Could not update")
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5" />
          Verification log
        </CardTitle>
        <CardDescription>Recent identity checks and their scores. Use this to calibrate the match threshold.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between rounded-lg border border-border bg-muted/30 p-3">
          <Label htmlFor="face-flagged-only">Flagged only</Label>
          <Switch id="face-flagged-only" checked={flaggedOnly} onCheckedChange={setFlaggedOnly} />
        </div>

        {attempts.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : !attempts.data?.length ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {flaggedOnly ? "Nothing flagged for review." : "No verification attempts recorded yet."}
          </p>
        ) : (
          <>
            {/* Desktop table / mobile cards — same dual-rendering fallback the Tickets and Team
                pages use below the sm breakpoint. */}
            <div className="hidden overflow-x-auto sm:block">
              <table className="w-full text-sm">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="p-2 font-medium">User</th>
                    <th className="p-2 font-medium">When</th>
                    <th className="p-2 font-medium">Context</th>
                    <th className="p-2 font-medium">Outcome</th>
                    <th className="p-2 font-medium">Match</th>
                    <th className="p-2 font-medium">Live</th>
                    <th className="p-2" />
                  </tr>
                </thead>
                <tbody>
                  {attempts.data.map((a) => (
                    <tr key={a.id} className="border-t border-border">
                      <td className="p-2">
                        <div className="font-medium">{a.user.name}</div>
                        <div className="text-xs text-muted-foreground">{a.user.email}</div>
                      </td>
                      <td className="p-2 text-muted-foreground">{new Date(a.createdAt).toLocaleString()}</td>
                      <td className="p-2 text-muted-foreground">{a.context}</td>
                      <td className="p-2">
                        <Badge className={OUTCOME_TONE[a.outcome] ?? ""} variant="secondary">
                          {a.outcome.replaceAll("_", " ").toLowerCase()}
                        </Badge>
                      </td>
                      <td className="p-2 tabular-nums">{a.similarity != null ? a.similarity.toFixed(3) : "—"}</td>
                      <td className="p-2 tabular-nums">{a.livenessScore != null ? a.livenessScore.toFixed(2) : "—"}</td>
                      <td className="p-2 text-right">
                        <AttemptActions attempt={a} readOnly={readOnly} onReview={() => review.mutate(a.id)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="space-y-2 sm:hidden">
              {attempts.data.map((a) => (
                <div key={a.id} className="rounded-lg border border-border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{a.user.name}</p>
                      <p className="truncate text-xs text-muted-foreground">{a.user.email}</p>
                    </div>
                    <Badge className={OUTCOME_TONE[a.outcome] ?? ""} variant="secondary">
                      {a.outcome.replaceAll("_", " ").toLowerCase()}
                    </Badge>
                  </div>
                  <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <div className="flex justify-between">
                      <dt>When</dt>
                      <dd>{new Date(a.createdAt).toLocaleString()}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt>Context</dt>
                      <dd>{a.context}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt>Match</dt>
                      <dd className="tabular-nums">{a.similarity != null ? a.similarity.toFixed(3) : "—"}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt>Live</dt>
                      <dd className="tabular-nums">{a.livenessScore != null ? a.livenessScore.toFixed(2) : "—"}</dd>
                    </div>
                  </dl>
                  <div className="mt-2 flex justify-end">
                    <AttemptActions attempt={a} readOnly={readOnly} onReview={() => review.mutate(a.id)} />
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function AttemptActions({ attempt, readOnly, onReview }: { attempt: FaceAttemptRow; readOnly: boolean; onReview: () => void }) {
  return (
    <div className="flex items-center justify-end gap-1">
      {attempt.hasImage && (
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9"
          title="View capture"
          onClick={() => window.open(faceApi.attemptImageUrl(attempt.id), "_blank", "noopener")}
        >
          <Eye className="h-4 w-4" />
        </Button>
      )}
      {attempt.flaggedForReview && !readOnly && (
        <Button variant="outline" size="sm" onClick={onReview}>
          Mark reviewed
        </Button>
      )}
    </div>
  );
}
