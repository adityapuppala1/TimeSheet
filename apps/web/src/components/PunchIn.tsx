/**
 * WHAT: the punch-in experience (V17 A2) — the dialog (bottom sheet on a phone), the mandatory
 * overlay, the dismissible banner and the "already punched in" notice.
 *
 * HOW IT DECIDES WHAT TO SHOW: lib/punch-in-gate.ts#decidePunchIn, a pure function. This file only
 * renders its answer and publishes `holdsOthers` so the tour and the face-model prompt wait.
 *
 * THE STEPS: Location (consent wording first time, then the browser's geolocation with a timeout)
 * → Face (the existing FaceVerificationDialog with context PUNCH_IN — no second matcher) → Done.
 * Every rule is enforced server-side (attendance-punch.service.ts); this only choreographs, so a
 * hand-written client gains nothing by skipping a step.
 *
 * MOTION: the Done check is opacity + transform only, and static under prefers-reduced-motion.
 */
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Circle, Clock, LogOut, MapPin, ScanFace, X } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router";
import { toast } from "sonner";
import { useAuthStore } from "../store/auth";
import { authApi } from "../services/api";
import { attendanceApi, MY_TODAY_QUERY_KEY, type MyToday, type PunchInPayload } from "../services/attendance-api";
import {
  decidePunchIn,
  PUNCH_IN_ESCAPE_HATCH,
  punchNotice,
  readDismissal,
  usePunchInGate,
  writeDismissal
} from "../lib/punch-in-gate";
import { localDateKey } from "../lib/local-day";
import { useMediaQuery } from "../lib/use-media-query";
import { usePrefersReducedMotion } from "../lib/use-motion";
import { signOut, SIGN_OUT_UNCONFIRMED } from "../lib/sign-out";
import { runInBackground } from "../lib/run-in-background";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "./ui/sheet";
import { FaceVerificationDialog } from "./FaceVerificationDialog";

/** Long enough for a phone to get a GPS fix indoors, short enough that nobody waits on a spinner. */
const GEO_TIMEOUT_MS = 10_000;

export function useMyToday() {
  const user = useAuthStore((s) => s.user);
  return useQuery({
    queryKey: MY_TODAY_QUERY_KEY,
    queryFn: attendanceApi.myToday,
    enabled: Boolean(user),
    staleTime: 60_000,
    retry: false
  });
}

function getPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      reject(new Error("unsupported"));
      return;
    }
    // Location IS the feature here: the admin chose OPTIONAL/REQUIRED, and the consent wording is
    // shown before the first read.
    // eslint-disable-next-line sonarjs/no-intrusive-permissions
    navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: GEO_TIMEOUT_MS, maximumAge: 60_000 });
  });
}

type Phase = "ready" | "locating" | "location-blocked" | "face" | "face-failed" | "submitting" | "done";

const BUSY_LABEL: Partial<Record<Phase, string>> = {
  locating: "Getting your location…",
  submitting: "Punching in…",
  "location-blocked": "Try again",
  "face-failed": "Try again"
};

function primaryLabel(phase: Phase, consentFirst: boolean): string {
  const busy = BUSY_LABEL[phase];
  if (busy) return busy;
  return consentFirst ? "Agree and punch in" : "Punch in";
}

/** How many of the listed steps are complete, for the checkmarks. */
function completedSteps(phase: Phase, wantsLocation: boolean): number {
  if (phase === "face" || phase === "face-failed" || phase === "submitting") return wantsLocation ? 1 : 0;
  return 0;
}

type StepItem = { key: string; icon: typeof MapPin; label: string };

function StepList({ items, completed }: Readonly<{ items: StepItem[]; completed: number }>) {
  if (items.length === 0) return null;
  return (
    <ol className="grid gap-2" aria-label="Punch-in steps">
      {items.map((step, i) => {
        const done = i < completed;
        return (
          <li key={step.key} className={`flex items-center gap-3 rounded-lg border p-3 text-sm ${done ? "border-success/40 bg-success/5" : "border-border"}`}>
            {done ? <CheckCircle2 className="h-4 w-4 shrink-0 text-success" /> : <Circle className="h-4 w-4 shrink-0 text-muted-foreground" />}
            <step.icon className="h-4 w-4 shrink-0 text-primary" />
            <span className="min-w-0">{step.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

function PunchInDone({ punchedAt, onDone }: Readonly<{ punchedAt: string | null; onDone?: () => void }>) {
  const reduced = usePrefersReducedMotion();
  const time = punchedAt ? new Date(punchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  return (
    <div className="grid justify-items-center gap-3 py-4 text-center" role="status" aria-live="polite">
      <span className={`grid h-14 w-14 place-items-center rounded-full bg-success/15 text-success ${reduced ? "" : "punch-in-check"}`}>
        <CheckCircle2 className="h-8 w-8" />
      </span>
      <p className="text-base font-semibold">You're punched in{time ? ` at ${time}` : ""}</p>
      <p className="text-sm text-muted-foreground">Have a good day.</p>
      {onDone && (
        <Button className="mt-1 w-full sm:w-auto" onClick={onDone}>
          Continue
        </Button>
      )}
    </div>
  );
}

function FaceFailedNotice({ allowFlagged }: Readonly<{ allowFlagged: boolean }>) {
  return (
    <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm" role="alert">
      <p>
        {allowFlagged
          ? "The identity check didn't complete. You can try again, or punch in anyway — the punch will be flagged for review."
          : "Your workspace needs a successful identity check to punch in. Try again in good light, facing the camera."}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Steps — shared by the dialog, the sheet and the mandatory overlay.
 * ------------------------------------------------------------------ */

export function PunchInSteps({
  today,
  onDone,
  onPhaseChange
}: Readonly<{ today: MyToday; onDone?: () => void; onPhaseChange?: (phase: Phase) => void }>) {
  const queryClient = useQueryClient();
  const [phase, setPhaseState] = useState<Phase>("ready");
  const [error, setError] = useState<string | null>(null);
  const [locationNote, setLocationNote] = useState<string | null>(null);
  const [faceOpen, setFaceOpen] = useState(false);
  const [punchedAt, setPunchedAt] = useState<string | null>(null);
  const coords = useRef<Pick<PunchInPayload, "lat" | "lng" | "accuracyM">>({});
  const verified = useRef(false);

  const setPhase = (next: Phase) => {
    setPhaseState(next);
    onPhaseChange?.(next);
  };

  const steps = today.steps ?? [];
  const wantsLocation = steps.includes("LOCATION");
  const wantsFace = steps.includes("FACE");
  const required = today.locationMode === "REQUIRED";

  const punch = useMutation({
    mutationFn: (verificationId: string | null) =>
      attendanceApi.punchIn({ ...coords.current, consentAccepted: today.consentNeeded ? true : undefined, verificationId }),
    onMutate: () => setPhase("submitting"),
    onSuccess: (result) => {
      setPunchedAt(result.record.punchInAt);
      setPhase("done");
      runInBackground(queryClient.invalidateQueries({ queryKey: MY_TODAY_QUERY_KEY }));
    },
    onError: (err: unknown) => {
      const message = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
      setError(message ?? "Could not punch in. Please try again.");
      setPhase("ready");
    }
  });

  const afterLocation = () => {
    if (wantsFace) {
      verified.current = false;
      setPhase("face");
      setFaceOpen(true);
      return;
    }
    punch.mutate(null);
  };

  const start = async () => {
    setError(null);
    if (!wantsLocation) {
      afterLocation();
      return;
    }
    setPhase("locating");
    try {
      const pos = await getPosition();
      coords.current = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: pos.coords.accuracy };
      setLocationNote(null);
      afterLocation();
    } catch {
      coords.current = {};
      if (required) {
        setPhase("location-blocked");
        return;
      }
      setLocationNote("Location unavailable — punching in without it.");
      afterLocation();
    }
  };

  const stepItems = [
    ...(wantsLocation ? [{ key: "LOCATION", icon: MapPin, label: required ? "Share your location" : "Share your location (optional)" }] : []),
    ...(wantsFace ? [{ key: "FACE", icon: ScanFace, label: "Confirm it's you" }] : [])
  ];
  if (phase === "done") return <PunchInDone punchedAt={punchedAt} onDone={onDone} />;
  const allowFlagged = today.faceFailureRule === "ALLOW_FLAGGED";

  return (
    <div className="grid gap-4">
      <StepList items={stepItems} completed={completedSteps(phase, wantsLocation)} />

      {wantsLocation && today.consentNeeded && phase === "ready" && (
        <div className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          <p className="mb-1 font-semibold text-foreground">About your location</p>
          <p className="whitespace-pre-line">{today.consentText}</p>
        </div>
      )}

      {phase === "location-blocked" && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm" role="alert">
          <p className="font-semibold">Your workspace needs your location to punch in.</p>
          <p className="mt-1 text-muted-foreground">
            Allow location for this site — click the location or lock icon in your browser's address bar, choose Allow,
            then try again. On a phone, also check that location services are on.
          </p>
        </div>
      )}

      {phase === "face-failed" && <FaceFailedNotice allowFlagged={allowFlagged} />}

      {locationNote && <p className="text-xs text-muted-foreground">{locationNote}</p>}
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {phase === "face-failed" && allowFlagged && (
          <Button variant="outline" onClick={() => punch.mutate(null)}>
            Punch in anyway
          </Button>
        )}
        <Button
          onClick={() => {
            if (phase === "face-failed") {
              afterLocation();
              return;
            }
            runInBackground(start());
          }}
          disabled={phase === "locating" || phase === "submitting" || phase === "face"}
        >
          <Clock className="mr-2 h-4 w-4" />
          {primaryLabel(phase, Boolean(today.consentNeeded) && wantsLocation)}
        </Button>
      </div>

      {wantsFace && (
        <FaceVerificationDialog
          open={faceOpen}
          context="PUNCH_IN"
          actionLabel="punch in"
          onVerified={(id) => {
            verified.current = true;
            punch.mutate(id);
          }}
          onOpenChange={(open) => {
            setFaceOpen(open);
            if (!open && !verified.current) setPhase("face-failed");
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Controller — mounted once in AppLayout.
 * ------------------------------------------------------------------ */

export function PunchInController() {
  const user = useAuthStore((s) => s.user);
  const location = useLocation();
  const today = useMyToday();
  // OnboardingGate's own query key, so this costs no extra request.
  const onboarding = useQuery({
    queryKey: ["auth", "onboarding-status"],
    queryFn: authApi.onboardingStatus,
    enabled: Boolean(user),
    staleTime: 3_000
  });
  const onboardingBlocked = Boolean(onboarding.data?.blocked);
  // A failed onboarding read must not hold everything forever; only "still loading" holds.
  const onboardingLoading = onboarding.isPending && !onboarding.isError;
  const isPhone = !useMediaQuery("(min-width: 640px)");
  const { dismissal, setDismissal, setHoldsOthers, reopenRequested, requestReopen } = usePunchInGate();
  const [activePhase, setActivePhase] = useState<Phase>("ready");
  const noticeShown = useRef(false);
  const localDay = localDateKey(new Date());

  // Restore today's dismissal for this person (a new day or a new user starts clean).
  useEffect(() => {
    if (user) setDismissal(readDismissal(user.id, localDay));
  }, [user, localDay, setDismissal]);

  const data = today.isError ? null : today.data;
  const decision = decidePunchIn({
    today: data,
    onboardingBlocked,
    onboardingLoading,
    pathname: location.pathname,
    dismissal: reopenRequested ? "none" : dismissal
  });
  // Keep the dialog up through its own Done step, even though the refreshed status now says "notice".
  const keepOpen = activePhase === "done" || activePhase === "submitting" || activePhase === "face";
  const ownSurface = data?.punchInMode === "MANDATORY" ? "gate" : "dialog";
  const surface = keepOpen && decision.surface === "notice" ? ownSurface : decision.surface;

  useEffect(() => {
    setHoldsOthers(decision.holdsOthers || keepOpen);
  }, [decision.holdsOthers, keepOpen, setHoldsOthers]);

  // "Punched in 08:50 via Biometric" — once per session, and not after punching in right here.
  useEffect(() => {
    if (decision.surface !== "notice" || noticeShown.current || activePhase !== "ready" || !data?.record) return;
    noticeShown.current = true;
    toast(punchNotice(data.record), { icon: <Clock className="h-4 w-4" /> });
  }, [decision.surface, activePhase, data?.record]);

  if (!user || !data || surface === "none" || surface === "notice" || surface === "banner") return null;

  const dismiss = () => {
    requestReopen(false);
    setActivePhase("ready");
    if (activePhase === "done") return;
    setDismissal("dialog");
    writeDismissal(user.id, localDay, "dialog");
  };
  const finish = () => {
    requestReopen(false);
    setActivePhase("ready");
  };

  const title = `Good ${greeting()}, ${user.name?.split(" ")[0] ?? "there"}`;
  const description = data.holidayName ? `Today is ${data.holidayName}.` : "Punch in to start your day.";
  const body = <PunchInSteps today={data} onDone={finish} onPhaseChange={setActivePhase} />;

  if (surface === "gate") return <PunchInGateOverlay title={title} body={body} />;

  if (isPhone) {
    return (
      <Sheet open onOpenChange={(open) => !open && dismiss()}>
        <SheetContent side="bottom" className="max-h-[90dvh] overflow-y-auto rounded-t-2xl pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          <SheetHeader className="text-left">
            <SheetTitle>{title}</SheetTitle>
            <SheetDescription>{description}</SheetDescription>
          </SheetHeader>
          <div className="mt-4">{body}</div>
        </SheetContent>
      </Sheet>
    );
  }
  return (
    <Dialog open onOpenChange={(open) => !open && dismiss()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}

function greeting(now = new Date()): string {
  const h = now.getHours();
  if (h < 12) return "morning";
  if (h < 17) return "afternoon";
  return "evening";
}

/** Modelled on OnboardingGate: only the profile and sign-out are reachable. Below dialogs (z-45 <
 *  z-50) so the face check and SessionEndedDialog open on top of it. */
function PunchInGateOverlay({ title, body }: Readonly<{ title: string; body: React.ReactNode }>) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const logoutStore = useAuthStore((s) => s.logout);

  const handleSignOut = async () => {
    const outcome = await signOut({
      endSession: authApi.logout,
      clearLocal: () => {
        logoutStore();
        queryClient.clear();
      }
    });
    if (outcome === "signed-out") toast.success("Signed out");
    else toast.error(SIGN_OUT_UNCONFIRMED.title, { description: SIGN_OUT_UNCONFIRMED.description });
    void navigate("/login");
  };

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="punch-in-gate-title"
      className="fixed inset-0 z-45 grid place-items-end bg-background/85 backdrop-blur-xs sm:place-items-center sm:p-4"
    >
      <div className="w-full max-w-md rounded-t-2xl border border-border bg-card p-6 shadow-lg sm:rounded-xl">
        <h2 id="punch-in-gate-title" className="text-lg font-black tracking-tight">
          {title}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">Your workspace asks everyone to punch in before starting work.</p>
        <div className="mt-4">{body}</div>
        <div className="mt-4 flex items-center justify-between gap-2 border-t border-border pt-3 text-xs">
          <Link to={PUNCH_IN_ESCAPE_HATCH} className="text-primary underline-offset-2 hover:underline">
            Go to my profile
          </Link>
          <button type="button" onClick={() => runInBackground(handleSignOut())} className="focus-ring inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
            <LogOut className="h-3.5 w-3.5" /> Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Banner — rendered alongside MaintenanceBanner/PasswordChangeBanner once the dialog is dismissed.
 * ------------------------------------------------------------------ */

export function PunchInBanner() {
  const user = useAuthStore((s) => s.user);
  const today = useMyToday();
  const { dismissal, setDismissal, requestReopen, reopenRequested } = usePunchInGate();
  const data = today.data;
  if (!user || !data?.enabled || data.punchInMode !== "OPTIONAL" || data.record || !data.isWorkingDay) return null;
  if (dismissal !== "dialog" || reopenRequested) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-primary/30 bg-primary/5 px-4 py-2 text-sm">
      <p className="flex min-w-0 items-center gap-2">
        <Clock className="h-4 w-4 shrink-0 text-primary" />
        <span className="min-w-0">You haven't punched in today.</span>
      </p>
      <div className="flex items-center gap-1">
        <Button size="sm" variant="outline" onClick={() => requestReopen(true)}>
          Punch in
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label="Dismiss for today"
          onClick={() => {
            setDismissal("banner");
            writeDismissal(user.id, localDateKey(new Date()), "banner");
          }}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
