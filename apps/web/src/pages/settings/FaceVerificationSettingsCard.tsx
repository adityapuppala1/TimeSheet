/**
 * Workspace Settings → Face verification. Master switch, scope, calibration thresholds,
 * retention, consent wording, and the review log of flagged attempts.
 *
 * Follows this app's established settings-card conventions: switches save immediately (no Save
 * button), numeric/text groups keep local state behind an explicit Save, non-super-admins see
 * the card read-only rather than not at all.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Eye,
  Lock,
  Save,
  ScanFace,
  ShieldAlert,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  VideoOff,
  Wand2,
  Wifi
} from "lucide-react";
import { toast } from "sonner";
import {
  faceApi,
  settingsApi,
  type FaceAttemptRow,
  type FaceReviewAiSummary,
  type FaceThresholdRecommendation,
  type FaceVerificationSettings
} from "../../services/api";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Skeleton } from "../../components/ui/skeleton";
import { Switch } from "../../components/ui/switch";
import { Textarea } from "../../components/ui/textarea";
import { Badge } from "../../components/ui/badge";
import { useDebouncedValue } from "../../hooks/use-debounced-value";

const OUTCOME_TONE: Record<string, string> = {
  PASSED: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  NO_MATCH: "bg-destructive/10 text-destructive",
  SPOOF_SUSPECTED: "bg-destructive/10 text-destructive",
  CHALLENGE_FAILED: "bg-destructive/10 text-destructive",
  MULTIPLE_FACES: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  NO_FACE: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  NOT_ENROLLED: "bg-muted text-muted-foreground",
  /** The audited insecure-context pass-through — amber, not muted: every one of these is a
   *  submission that went UNCHECKED, which is exactly what this log exists to make visible. */
  SKIPPED_INSECURE: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  ERROR: "bg-muted text-muted-foreground"
};

/** The fields the calibration form owns. Used to decide whether a save should re-seed those
 *  inputs — a toggle save must never clobber a number somebody is midway through typing. */
const TUNING_KEYS = [
  "matchThreshold",
  "antispoofThreshold",
  "livenessThreshold",
  "maxAttempts",
  "verificationTtlSeconds",
  "imageRetentionDays"
] as const;

export function FaceVerificationSettingsCard({ readOnly = false }: { readOnly?: boolean }) {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["settings", "face-verification"], queryFn: settingsApi.getFaceVerification });

  const update = useMutation({
    mutationFn: settingsApi.updateFaceVerification,
    onSuccess: (updated, variables) => {
      toast.success("Saved");
      queryClient.invalidateQueries({ queryKey: ["settings", "face-verification"] });

      // Re-seed the text inputs from the SERVER's answer, but only for the section that was
      // actually saved. The server clamps values (a threshold typed as 5 comes back as 0.99), so
      // showing what it stored rather than what was typed is the honest thing — and scoping it to
      // the saved section is what stops a toggle save from wiping a half-typed number in the box
      // next to it.
      const vars = (variables ?? {}) as Record<string, unknown>;
      if (TUNING_KEYS.some((key) => key in vars)) seedTuning(updated);
      if ("consentText" in vars) setConsentText(updated.consentText ?? "");
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

  function seedTuning(s: FaceVerificationSettings) {
    setTuning({
      matchThreshold: String(s.matchThreshold),
      antispoofThreshold: String(s.antispoofThreshold),
      livenessThreshold: String(s.livenessThreshold),
      maxAttempts: String(s.maxAttempts),
      verificationTtlSeconds: String(s.verificationTtlSeconds),
      imageRetentionDays: String(s.imageRetentionDays)
    });
  }

  /**
   * Seed the free-text fields from the server ONCE, on first load.
   *
   * THIS USED TO RUN ON EVERY CHANGE TO `settings.data`, AND IT SILENTLY DISCARDED EDITS. Any
   * toggle on this card saves and then invalidates this query; the refetch produced a new object,
   * the effect fired, and every number the admin had typed but not yet saved was reset to the
   * stored value. React Query also refetches on window focus by default, so merely switching tabs
   * and coming back wiped in-progress typing.
   *
   * The failure was worse than losing keystrokes. The "Save calibration" button sends whatever is
   * in this state — so the sequence "type a new threshold, flip an unrelated switch, press Save"
   * silently re-saved the OLD value and reported success. The setting appeared not to persist,
   * and the thing that had actually happened was that it was never sent.
   *
   * Now: seeded once here, and re-seeded in the mutation's onSuccess for the specific section that
   * was saved. A background refetch can no longer touch what somebody is typing.
   */
  const hydrated = useRef(false);
  useEffect(() => {
    const s = settings.data;
    if (!s || hydrated.current) return;
    hydrated.current = true;
    seedTuning(s);
    setConsentText(s.consentText ?? "");
  }, [settings.data]);

  if (settings.isLoading) return <Skeleton className="h-64 w-full" />;
  const s = settings.data;
  const enabled = s?.enabled ?? false;
  const allowedByPlan = s?.allowedByPlan ?? false;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ScanFace className="h-5 w-5" />
            Face verification
            {!allowedByPlan && (
              <Badge variant="outline" className="ml-1 font-normal">
                <Lock className="mr-1 h-3 w-3" />
                Enterprise
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            Require a live camera check confirming the person submitting a timesheet or ticket — or approving a timesheet — is the
            account holder, closing the gap where one employee acts on another's behalf.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!allowedByPlan && (
            /* Entitlement gate, matching the SSO/chat convention: configuration below stays
               editable (an org mid-upgrade can stage everything), only ENABLING is blocked. */
            <div className="flex items-start gap-2 rounded-lg border border-primary/40 bg-primary/5 p-3 text-sm">
              <Lock className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <p>
                Face verification is an <strong>Enterprise plan</strong> feature.
                {enabled
                  ? " Your plan no longer includes it: identity checks have stopped being enforced, and stored face data will be purged after a 30-day grace period unless the plan is upgraded."
                  : " You can stage the configuration below now — enabling it activates the moment your workspace is on Enterprise."}{" "}
                Upgrade from the <strong>Billing</strong> tab.
              </p>
            </div>
          )}

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
            <Switch checked={enabled} disabled={readOnly || (!enabled && !allowedByPlan)} onCheckedChange={(v) => update.mutate({ enabled: v })} />
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
                <Label>Require on ticket actions</Label>
                <p className="text-sm text-muted-foreground">Creating a ticket and moving it between statuses. Comments and edits are never gated.</p>
              </div>
              <Switch
                checked={s?.requireForTicket ?? false}
                disabled={readOnly || !enabled}
                onCheckedChange={(v) => update.mutate({ requireForTicket: v })}
              />
            </div>
            <div className="flex items-center justify-between rounded-lg border border-border bg-muted/30 p-4">
              <div className="space-y-0.5 pr-4">
                <Label>Require on timesheet approval</Label>
                <p className="text-sm text-muted-foreground">Checks the approver — approval is where hours become payable.</p>
              </div>
              <Switch
                checked={s?.requireForApproval ?? false}
                disabled={readOnly || !enabled}
                onCheckedChange={(v) => update.mutate({ requireForApproval: v })}
              />
            </div>
            <div className="flex items-center justify-between rounded-lg border border-border bg-muted/30 p-4">
              <div className="space-y-0.5 pr-4">
                <Label>Movement challenge (anti-replay)</Label>
                <p className="text-sm text-muted-foreground">
                  Each check also demands a short random head movement, defeating replayed videos through virtual cameras.
                </p>
              </div>
              <Switch
                checked={s?.challengeEnabled ?? true}
                disabled={readOnly || !enabled}
                onCheckedChange={(v) => update.mutate({ challengeEnabled: v })}
              />
            </div>
            <div className="flex items-center justify-between rounded-lg border border-border bg-muted/30 p-4">
              <div className="space-y-0.5 pr-4">
                <Label>Auto-resolve honest failures</Label>
                <p className="text-sm text-muted-foreground">
                  Clears a flagged attempt on its own only when the same person clearly passed within the hour and nothing about
                  it looked like an injection attempt. Never touches a suspected virtual camera or timing mismatch.
                </p>
              </div>
              <Switch
                checked={s?.autoTriageHonestFailures ?? false}
                disabled={readOnly || !enabled}
                onCheckedChange={(v) => update.mutate({ autoTriageHonestFailures: v })}
              />
            </div>
            <div className="flex items-center justify-between rounded-lg border border-warning/40 bg-warning/5 p-4">
              <div className="space-y-0.5 pr-4">
                <Label>Allow skipping on plain-http connections</Label>
                <p className="text-sm text-muted-foreground">
                  Browsers only open the camera on <strong>https</strong> (or localhost) — that rule can't be
                  lifted by any setting here. With this on, someone whose connection is plain http may proceed{" "}
                  <strong>without</strong> the face check; every skip is recorded in the verification log below
                  as <em>skipped insecure</em>. This weakens the control — meant for LAN pilots until you serve
                  the app over https, then switch it back off.
                </p>
              </div>
              <Switch
                checked={s?.insecureContextBypass ?? false}
                disabled={readOnly || !enabled}
                onCheckedChange={(v) => update.mutate({ insecureContextBypass: v })}
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

      {enabled && <FaceStatsCard />}
      <FaceReviewLog readOnly={readOnly} />
    </div>
  );
}

/**
 * The evidence a threshold decision should rest on: this workforce's actual similarity
 * distribution, split into passed vs rejected. A well-separated pair of clusters with the
 * threshold in the valley between them is what "correctly calibrated" looks like; overlap means
 * the threshold is cutting into real people. CSS bars, deliberately — a dependency-free chart
 * is plenty for 12 buckets.
 */
function FaceStatsCard() {
  const stats = useQuery({ queryKey: ["face", "stats"], queryFn: faceApi.stats });
  const data = stats.data;
  if (stats.isLoading) return <Skeleton className="h-40 w-full" />;
  if (!data || data.total === 0) return null;

  const maxCount = Math.max(1, ...data.histogram.map((b) => b.passed + b.rejected));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BarChart3 className="h-5 w-5" />
          Match-score distribution
        </CardTitle>
        <CardDescription>
          Last 90 days, {data.total} attempts. Tune the match threshold into the gap between the rejected (red) and passed (green)
          clusters — if the colours overlap, the threshold is cutting into real people.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-end gap-1 overflow-x-auto rounded-lg border border-border bg-muted/30 p-3" style={{ minHeight: "7rem" }}>
          {data.histogram.map((bucket) => {
            const total = bucket.passed + bucket.rejected;
            const height = total === 0 ? 2 : Math.max(6, Math.round((total / maxCount) * 88));
            const passedShare = total === 0 ? 0 : bucket.passed / total;
            return (
              <div key={bucket.from} className="flex min-w-8 flex-1 flex-col items-center justify-end gap-1" title={`${bucket.from}–${bucket.to}: ${bucket.passed} passed, ${bucket.rejected} rejected`}>
                <div className="flex w-full flex-col justify-end overflow-hidden rounded-sm" style={{ height }}>
                  <div className="w-full bg-emerald-500/80" style={{ height: `${passedShare * 100}%` }} />
                  <div className="w-full bg-red-500/70" style={{ height: `${(1 - passedShare) * 100}%` }} />
                </div>
                <span className="text-[10px] tabular-nums text-muted-foreground">{bucket.from.toFixed(2)}</span>
              </div>
            );
          })}
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            ["Flagged pending", data.flaggedPending],
            ["Virtual camera", data.virtualCameraSuspected],
            ["New network", data.unfamiliarNetwork],
            ["Total checks", data.total]
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg border border-border bg-muted/30 p-3 text-center">
              <p className="text-lg font-bold tabular-nums">{value}</p>
              <p className="text-xs text-muted-foreground">{label}</p>
            </div>
          ))}
        </div>

        {/* Operational accuracy — the four numbers that make "did that change help?" answerable.
            Each carries its healthy target inline, because a bare percentage tells an admin
            nothing about whether to act. */}
        {data.accuracy && (
          <div>
            <p className="mb-2 text-sm font-medium">Accuracy &amp; speed</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <AccuracyTile
                label="Retake rate"
                value={data.accuracy.retakeRatePct != null ? `${data.accuracy.retakeRatePct}%` : "—"}
                target="target < 15%"
                bad={(data.accuracy.retakeRatePct ?? 0) > 15}
                title="Captures refused as unjudgeable (too dark, face too small) and asked to retake. High means the capture experience needs work, not that people are failing."
              />
              <AccuracyTile
                label="Non-match rate"
                value={data.accuracy.fnmrProxyPct != null ? `${data.accuracy.fnmrProxyPct}%` : "—"}
                target="target < 2%"
                bad={(data.accuracy.fnmrProxyPct ?? 0) > 2}
                title="Rejections as a share of judged checks. A proxy for false rejections — a genuine impostor rejection lands here too, so treat it as a trend line, not an absolute."
              />
              <AccuracyTile
                label="Verify p50"
                value={data.accuracy.timeToVerifyMsP50 != null ? `${(data.accuracy.timeToVerifyMsP50 / 1000).toFixed(1)}s` : "—"}
                target="target < 1s"
                bad={(data.accuracy.timeToVerifyMsP50 ?? 0) > 1000}
                title="Median wait the person actually experienced, camera-ready to verdict."
              />
              <AccuracyTile
                label="Verify p95"
                value={data.accuracy.timeToVerifyMsP95 != null ? `${(data.accuracy.timeToVerifyMsP95 / 1000).toFixed(1)}s` : "—"}
                target="target < 2s"
                bad={(data.accuracy.timeToVerifyMsP95 ?? 0) > 2000}
                title="The slow tail — what your least-lucky users wait."
              />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              From {data.accuracy.samples.judged} judged checks
              {data.accuracy.samples.timed > 0 ? `, ${data.accuracy.samples.timed} timed` : ", none timed yet"}.
              Timings only exist for checks made since this build.
            </p>
          </div>
        )}

        <PolicyCopilot />
      </CardContent>
    </Card>
  );
}

/**
 * The "policy copilot": a threshold recommendation computed arithmetically from this workspace's
 * own passed/rejected distribution (see recommendMatchThreshold's header for the method), with an
 * optional AI narration of those same numbers layered on top. The recommendation is fully useful
 * with AI switched off — the button works with or without the AI tab enabled.
 */
function PolicyCopilot() {
  const [result, setResult] = useState<FaceThresholdRecommendation | null>(null);
  const recommend = useMutation({
    mutationFn: faceApi.policyRecommendation,
    onSuccess: setResult,
    onError: () => toast.error("Could not compute a recommendation")
  });

  return (
    <div className="rounded-lg border border-border bg-muted/30 p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Policy copilot</p>
          <p className="text-xs text-muted-foreground">A threshold recommendation computed from this workspace's own scores.</p>
        </div>
        <Button variant="outline" size="sm" disabled={recommend.isPending} onClick={() => recommend.mutate()}>
          <Wand2 className={`mr-2 h-3.5 w-3.5 ${recommend.isPending ? "animate-pulse" : ""}`} />
          Get recommendation
        </Button>
      </div>
      {result && (
        <div className="mt-3 space-y-2 text-sm">
          <p>{result.summary}</p>
          {result.recommendedThreshold != null && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="rounded-lg border border-border bg-background p-2 text-center">
                <p className="text-xs text-muted-foreground">Current</p>
                <p className="font-bold tabular-nums">{result.currentThreshold.toFixed(2)}</p>
              </div>
              <div className="rounded-lg border border-primary/40 bg-primary/5 p-2 text-center">
                <p className="text-xs text-muted-foreground">Recommended</p>
                <p className="font-bold tabular-nums">{result.recommendedThreshold.toFixed(2)}</p>
              </div>
              <div className="rounded-lg border border-border bg-background p-2 text-center">
                <p className="text-xs text-muted-foreground">Reject rate now</p>
                <p className="font-bold tabular-nums">{result.currentRejectRatePct ?? "—"}%</p>
              </div>
              <div className="rounded-lg border border-border bg-background p-2 text-center">
                <p className="text-xs text-muted-foreground">Projected</p>
                <p className="font-bold tabular-nums">{result.projectedRejectRatePct ?? "—"}%</p>
              </div>
            </div>
          )}
          {result.narrative && (
            <div className="rounded-lg border border-border bg-background p-3">
              <p className="text-xs font-semibold uppercase text-muted-foreground">AI narration</p>
              <p className="mt-1 text-sm">{result.narrative}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** One accuracy number with its target inline — a bare percentage doesn't tell an admin whether
 *  to act, and the amber state is what makes the dashboard worth glancing at. */
function AccuracyTile({ label, value, target, bad, title }: { label: string; value: string; target: string; bad: boolean; title: string }) {
  return (
    <div className={`rounded-lg border p-3 text-center ${bad ? "border-amber-500/40 bg-amber-500/10" : "border-border bg-muted/30"}`} title={title}>
      <p className={`text-lg font-bold tabular-nums ${bad ? "text-amber-600 dark:text-amber-400" : ""}`}>{value}</p>
      <p className="text-xs font-medium">{label}</p>
      <p className="text-[11px] text-muted-foreground">{target}</p>
    </div>
  );
}

const LOG_PAGE_SIZES = [10, 20, 50, 100];

/** Must stay in step with ATTEMPT_SORT_FIELDS in face.controller.ts — the server rejects anything
 *  outside its own allowlist, so a typo here is a 422 rather than a silent unsorted result. */
type AttemptSortField = "createdAt" | "similarity" | "livenessScore" | "outcome" | "context";

/** The values `FaceVerificationAttempt.outcome` and `.context` actually take. Listed rather than
 *  derived from the current page of rows: a filter that only offers the values already on screen
 *  can't be used to FIND the ones that aren't. */
// Taken from OUTCOME_TONE above, which is the existing source of truth for this enum — an earlier
// draft of this list invented plausible-sounding values (REJECTED_NO_MATCH and friends) that the
// column has never held, which would have produced filters that silently match nothing.
const ATTEMPT_OUTCOMES = Object.keys(OUTCOME_TONE);
const ATTEMPT_CONTEXTS = ["TIMESHEET", "TICKET", "APPROVAL"];

/** A sortable column header. Renders a real <button> inside the <th> so it's keyboard-reachable
 *  and announces its state, rather than a click handler on a bare cell. */
function SortableTh({
  field,
  sort,
  onSort,
  children
}: {
  field: AttemptSortField;
  sort: { by: AttemptSortField; dir: "asc" | "desc" };
  onSort: (field: AttemptSortField) => void;
  children: ReactNode;
}) {
  const active = sort.by === field;
  return (
    <th className="p-2 font-medium" aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button
        type="button"
        onClick={() => onSort(field)}
        className="inline-flex items-center gap-1 rounded hover:text-foreground focus-ring"
      >
        {children}
        {active ? (
          sort.dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
        ) : (
          <ArrowUpDown className="h-3 w-3 opacity-40" />
        )}
      </button>
    </th>
  );
}

/** The audit surface — recent attempts, flagged ones first, with the scores behind each decision.
 *  Paginated server-side (see the /face/attempts handler for why this one log can't page in the
 *  browser like the DataTable surfaces do). */
function FaceReviewLog({ readOnly }: { readOnly: boolean }) {
  const queryClient = useQueryClient();
  const [flaggedOnly, setFlaggedOnly] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [searchInput, setSearchInput] = useState("");
  const [outcome, setOutcome] = useState("all");
  const [context, setContext] = useState("all");
  const [sort, setSort] = useState<{ by: AttemptSortField; dir: "asc" | "desc" }>({ by: "createdAt", dir: "desc" });

  // Debounced so typing a name doesn't fire a query per keystroke against a server-paged endpoint.
  const search = useDebouncedValue(searchInput, 300);

  const attempts = useQuery({
    queryKey: ["face", "attempts", { flaggedOnly, page, pageSize, search, outcome, context, sort }],
    queryFn: () =>
      faceApi.listAttempts({
        flaggedOnly,
        page,
        pageSize,
        search: search || undefined,
        outcome: outcome === "all" ? undefined : outcome,
        context: context === "all" ? undefined : context,
        sortBy: sort.by,
        sortDir: sort.dir
      }),
    // Keeps the previous page rendered while the next one loads, so paging doesn't flash the
    // empty state — the same feel as the client-paged tables elsewhere.
    placeholderData: (prev) => prev
  });

  // Any change to the SHAPE of the result set returns to page 1 — staying on page 4 of a set that
  // now has one page shows a truthful-but-useless empty table.
  useEffect(() => {
    setPage(1);
  }, [search, outcome, context, flaggedOnly, pageSize, sort]);

  const toggleSort = (by: AttemptSortField) =>
    setSort((prev) => (prev.by === by ? { by, dir: prev.dir === "asc" ? "desc" : "asc" } : { by, dir: "desc" }));

  const anyFilterActive = Boolean(search) || outcome !== "all" || context !== "all" || !flaggedOnly;
  const resetFilters = () => {
    setSearchInput("");
    setOutcome("all");
    setContext("all");
    setFlaggedOnly(true);
    setSort({ by: "createdAt", dir: "desc" });
  };

  const rows = attempts.data?.rows ?? [];
  const total = attempts.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const firstShown = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastShown = Math.min(page * pageSize, total);

  // Anything that changes the size or shape of the result set resets to page 1 — landing on a
  // page that no longer exists shows a truthful-but-useless empty table. Done in the handlers
  // rather than as a render-time setState, which risks an update loop.
  const changeFilter = (next: boolean) => {
    setFlaggedOnly(next);
    setPage(1);
  };
  const changePageSize = (next: number) => {
    setPageSize(next);
    setPage(1);
  };

  const review = useMutation({
    mutationFn: (id: string) => faceApi.reviewAttempt(id),
    onSuccess: () => {
      toast.success("Marked reviewed");
      queryClient.invalidateQueries({ queryKey: ["face", "attempts"] });
    },
    onError: () => toast.error("Could not update")
  });

  const autoTriage = useMutation({
    mutationFn: faceApi.autoTriage,
    onSuccess: ({ resolved }) => {
      toast.success(resolved > 0 ? `Cleared ${resolved} honest failure${resolved === 1 ? "" : "s"}` : "Nothing to clear right now");
      queryClient.invalidateQueries({ queryKey: ["face", "attempts"] });
    },
    onError: () => toast.error("Could not run auto-triage")
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5" />
              Verification log
            </CardTitle>
            <CardDescription>Recent identity checks and their scores. Use this to calibrate the match threshold.</CardDescription>
          </div>
          {!readOnly && (
            <Button
              variant="outline"
              size="sm"
              disabled={autoTriage.isPending}
              onClick={() => autoTriage.mutate()}
              title="Clears flags on failures where the same person clearly passed within the hour and nothing looked like an injection attempt"
            >
              <Wand2 className={`mr-2 h-3.5 w-3.5 ${autoTriage.isPending ? "animate-pulse" : ""}`} />
              Auto-triage now
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Filter bar. Stacks on a phone and sits on one row from `sm` up — the same shape the
            DataTable surfaces use, so this log stops being the one table without controls. */}
        <div className="grid gap-2 rounded-lg border border-border bg-muted/30 p-3">
          <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
            <div className="relative min-w-0">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                className="h-9 pl-8"
                placeholder="Search by name or email..."
                aria-label="Search verification log"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
              />
            </div>
            <Select value={outcome} onValueChange={setOutcome}>
              <SelectTrigger className="h-9 w-full sm:w-[150px]" aria-label="Filter by outcome">
                <SelectValue placeholder="Outcome" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All outcomes</SelectItem>
                {ATTEMPT_OUTCOMES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {value.replaceAll("_", " ").toLowerCase()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={context} onValueChange={setContext}>
              <SelectTrigger className="h-9 w-full sm:w-[140px]" aria-label="Filter by context">
                <SelectValue placeholder="Context" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All contexts</SelectItem>
                {ATTEMPT_CONTEXTS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {value.toLowerCase()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Switch id="face-flagged-only" checked={flaggedOnly} onCheckedChange={setFlaggedOnly} />
              <Label htmlFor="face-flagged-only" className="cursor-pointer">Flagged only</Label>
            </div>
            {anyFilterActive && (
              <Button variant="ghost" size="sm" className="h-8" onClick={resetFilters}>
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" />Reset
              </Button>
            )}
          </div>
        </div>

        {attempts.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : rows.length === 0 ? (
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
                    {/* "User" isn't sortable: the search box above already answers "whose?", and a
                        name sort over a server-paged log invites scrolling for someone rather than
                        searching for them. */}
                    <th className="p-2 font-medium">User</th>
                    <SortableTh field="createdAt" sort={sort} onSort={toggleSort}>When</SortableTh>
                    <SortableTh field="context" sort={sort} onSort={toggleSort}>Context</SortableTh>
                    <SortableTh field="outcome" sort={sort} onSort={toggleSort}>Outcome</SortableTh>
                    <SortableTh field="similarity" sort={sort} onSort={toggleSort}>Match</SortableTh>
                    <SortableTh field="livenessScore" sort={sort} onSort={toggleSort}>Live</SortableTh>
                    <th className="p-2" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((a) => (
                    <tr key={a.id} className="border-t border-border">
                      <td className="p-2">
                        <div className="font-medium">{a.user.name}</div>
                        <div className="text-xs text-muted-foreground">{a.user.email}</div>
                      </td>
                      <td className="p-2 text-muted-foreground">{new Date(a.createdAt).toLocaleString()}</td>
                      <td className="p-2 text-muted-foreground">{a.context}</td>
                      <td className="p-2">
                        <div className="flex flex-wrap items-center gap-1">
                          <Badge className={OUTCOME_TONE[a.outcome] ?? ""} variant="secondary">
                            {a.outcome.replaceAll("_", " ").toLowerCase()}
                          </Badge>
                          {a.virtualCameraSuspected && (
                            <span title={`Suspected virtual camera${a.deviceLabel ? `: ${a.deviceLabel}` : ""}`}>
                              <VideoOff className="h-3.5 w-3.5 text-destructive" />
                            </span>
                          )}
                          {a.unfamiliarNetwork && (
                            <span title="First time verifying from this network">
                              <Wifi className="h-3.5 w-3.5 text-amber-500" />
                            </span>
                          )}
                          {a.provenanceSuspect && (
                            <span title={a.provenanceNote ?? "Capture timing didn't line up with its challenge — worth a look"}>
                              <ShieldAlert className="h-3.5 w-3.5 text-amber-500" />
                            </span>
                          )}
                          {a.autoResolvedReason && (
                            <span title={a.autoResolvedReason}>
                              <Wand2 className="h-3.5 w-3.5 text-muted-foreground" />
                            </span>
                          )}
                        </div>
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

            {/* Sorting for the card layout. The sortable <th>s only exist in the table above, so
                without this a phone user has filters and search but no sort at all — the gap this
                whole change set exists to close. */}
            <div className="flex items-center gap-2 sm:hidden">
              <Label htmlFor="face-log-sort" className="shrink-0 text-xs text-muted-foreground">Sort by</Label>
              <Select
                value={`${sort.by}:${sort.dir}`}
                onValueChange={(v) => {
                  const [by, dir] = v.split(":") as [AttemptSortField, "asc" | "desc"];
                  setSort({ by, dir });
                }}
              >
                <SelectTrigger id="face-log-sort" className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="createdAt:desc">Newest first</SelectItem>
                  <SelectItem value="createdAt:asc">Oldest first</SelectItem>
                  <SelectItem value="similarity:asc">Match score, lowest first</SelectItem>
                  <SelectItem value="similarity:desc">Match score, highest first</SelectItem>
                  <SelectItem value="livenessScore:asc">Liveness, lowest first</SelectItem>
                  <SelectItem value="outcome:asc">Outcome</SelectItem>
                  <SelectItem value="context:asc">Context</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2 sm:hidden">
              {rows.map((a) => (
                <div key={a.id} className="rounded-lg border border-border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{a.user.name}</p>
                      <p className="truncate text-xs text-muted-foreground">{a.user.email}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {a.virtualCameraSuspected && (
                        <span title={`Suspected virtual camera${a.deviceLabel ? `: ${a.deviceLabel}` : ""}`}>
                          <VideoOff className="h-3.5 w-3.5 text-destructive" />
                        </span>
                      )}
                      {a.unfamiliarNetwork && (
                        <span title="First time verifying from this network">
                          <Wifi className="h-3.5 w-3.5 text-amber-500" />
                        </span>
                      )}
                      {a.provenanceSuspect && (
                        <span title={a.provenanceNote ?? "Capture timing didn't line up with its challenge — worth a look"}>
                          <ShieldAlert className="h-3.5 w-3.5 text-amber-500" />
                        </span>
                      )}
                      <Badge className={OUTCOME_TONE[a.outcome] ?? ""} variant="secondary">
                        {a.outcome.replaceAll("_", " ").toLowerCase()}
                      </Badge>
                    </div>
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

            {/* Same footer shape as DataTable's (showing X-Y of N · page-size select · prev/next)
                so the log reads like every other table in the app, even though the paging is
                server-side here. */}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-muted-foreground">
                Showing {firstShown}-{lastShown} of {total}
                {attempts.isFetching && <span className="ml-2 opacity-70">updating…</span>}
              </p>
              <div className="flex items-center gap-2">
                <Select value={String(pageSize)} onValueChange={(v) => changePageSize(Number(v))}>
                  {/* Slightly wider than DataTable's 90px: "100 / page" clips at that width. */}
                  <SelectTrigger className="h-8 w-[106px] text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {LOG_PAGE_SIZES.map((size) => (
                      <SelectItem key={size} value={String(size)}>{size} / page</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button variant="outline" size="sm" aria-label="Previous page" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
                  <ChevronLeft className="h-3.5 w-3.5" />
                </Button>
                <span className="text-xs tabular-nums text-muted-foreground">
                  Page {page} of {pageCount}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label="Next page"
                  onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                  disabled={page >= pageCount}
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function AttemptActions({ attempt, readOnly, onReview }: { attempt: FaceAttemptRow; readOnly: boolean; onReview: () => void }) {
  const [aiOpen, setAiOpen] = useState(false);
  const [aiResult, setAiResult] = useState<FaceReviewAiSummary | null>(null);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureUrl, setCaptureUrl] = useState<string | null>(null);

  // The image route is authenticated, so the capture is fetched as a blob through the api client
  // (which carries the bearer token) and shown in-app. The old window.open() navigated with no
  // Authorization header and served every admin a JSON 401 instead of the image.
  const viewCapture = useMutation({
    mutationFn: () => faceApi.attemptImage(attempt.id),
    onSuccess: (blob) => {
      setCaptureUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(blob);
      });
      setCaptureOpen(true);
    },
    onError: (err: { response?: { status?: number } }) =>
      toast.error("Could not load the capture", {
        description:
          err?.response?.status === 404
            ? "This image has been purged by the retention policy."
            : "The image could not be fetched — try refreshing the page."
      })
  });

  const closeCapture = (open: boolean) => {
    setCaptureOpen(open);
    if (!open) {
      setCaptureUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
    }
  };

  const aiSummary = useMutation({
    mutationFn: () => faceApi.aiSummary(attempt.id),
    onSuccess: (result) => {
      setAiResult(result);
      setAiOpen(true);
    },
    onError: (err: { response?: { data?: { message?: string } } }) =>
      toast.error("Could not generate a summary", {
        description: err?.response?.data?.message ?? "AI may be disabled for this workspace (Workspace Settings → AI)."
      })
  });

  const RISK_TONE: Record<FaceReviewAiSummary["risk"], string> = {
    LOW: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    MEDIUM: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    HIGH: "bg-destructive/10 text-destructive"
  };

  return (
    <div className="flex items-center justify-end gap-1">
      {attempt.hasImage && (
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9"
          title="View capture"
          disabled={viewCapture.isPending}
          onClick={() => viewCapture.mutate()}
        >
          <Eye className={`h-4 w-4 ${viewCapture.isPending ? "animate-pulse" : ""}`} />
        </Button>
      )}
      {!readOnly && (
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9"
          title="AI review summary — history, signals, and a recommendation (needs the AI toggle in the AI tab)"
          disabled={aiSummary.isPending}
          onClick={() => aiSummary.mutate()}
        >
          <Sparkles className={`h-4 w-4 ${aiSummary.isPending ? "animate-pulse" : ""}`} />
        </Button>
      )}
      {attempt.flaggedForReview && !readOnly && (
        <Button variant="outline" size="sm" onClick={onReview}>
          Mark reviewed
        </Button>
      )}

      <Dialog open={aiOpen} onOpenChange={setAiOpen}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              AI review summary
            </DialogTitle>
            <DialogDescription>
              Drafted from this person's attempt history and signals — metadata only, never images. The decision stays yours.
            </DialogDescription>
          </DialogHeader>
          {aiResult && (
            <div className="space-y-3 text-sm">
              <Badge className={RISK_TONE[aiResult.risk]} variant="secondary">
                {aiResult.risk} risk
              </Badge>
              <p>{aiResult.summary}</p>
              <div className="rounded-lg border border-border bg-muted/30 p-3">
                <p className="text-xs font-semibold uppercase text-muted-foreground">Recommendation</p>
                <p className="mt-1">{aiResult.recommendation}</p>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={captureOpen} onOpenChange={closeCapture}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Eye className="h-4 w-4 text-primary" />
              Verification capture
            </DialogTitle>
            <DialogDescription>
              The frame stored for this check — {new Date(attempt.createdAt).toLocaleString()}, outcome{" "}
              {attempt.outcome.toLowerCase().replace(/_/g, " ")}. Served through the authenticated
              image route; it is never publicly addressable.
            </DialogDescription>
          </DialogHeader>
          {captureUrl && (
            <img
              src={captureUrl}
              alt="Stored verification capture"
              className="max-h-[60vh] w-full rounded-lg border border-border object-contain"
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
