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
import { AlertCircle, CheckCircle2, Circle, Clock, Loader2, LogOut, MapPin, ScanFace, X } from "lucide-react";
import { durationText, minutesLate } from "../lib/attendance-status";
import { cn } from "../lib/utils";
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
  isGateExempt,
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

/** Where each checklist item stands, from the phase the flow is in. */
type StepState = "idle" | "active" | "done" | "failed";

function stepStates(phase: Phase, wantsLocation: boolean, wantsFace: boolean, locationGranted: boolean): { location: StepState; face: StepState } {
  let location: StepState = "idle";
  if (phase === "locating") location = "active";
  else if (phase === "location-blocked") location = "failed";
  else if (phase === "face" || phase === "face-failed" || phase === "submitting" || phase === "done") location = wantsLocation && locationGranted ? "done" : "idle";
  let face: StepState = "idle";
  if (phase === "face") face = "active";
  else if (phase === "face-failed") face = "failed";
  else if ((phase === "submitting" || phase === "done") && wantsFace) face = "done";
  return { location, face };
}

type StepItem = { key: string; icon: typeof MapPin; label: string; state: StepState };

const STEP_COPY: Record<StepState, string> = { idle: "Waiting", active: "In progress", done: "Done", failed: "Needs attention" };

/** The inline 2-step checklist under the button: spinner while it runs, a check when done. */
function StepChecklist({ items }: Readonly<{ items: StepItem[] }>) {
  if (items.length === 0) return null;
  return (
    <ol className="grid gap-2" aria-label="Punch-in checks">
      {items.map((step) => (
        <li
          key={step.key}
          className={cn(
            "flex min-h-[44px] items-center gap-3 rounded-lg border px-3 text-sm",
            step.state === "done" && "border-success/40 bg-success/5",
            step.state === "failed" && "border-destructive/40 bg-destructive/5",
            step.state === "idle" && "border-border",
            step.state === "active" && "border-primary/50 bg-primary/5"
          )}
        >
          <span className="grid h-5 w-5 shrink-0 place-items-center" aria-hidden="true">
            {step.state === "done" && <CheckCircle2 className="h-5 w-5 text-success" />}
            {step.state === "active" && <Loader2 className="h-4 w-4 text-primary motion-safe:animate-spin" />}
            {step.state === "failed" && <AlertCircle className="h-5 w-5 text-destructive" />}
            {step.state === "idle" && <Circle className="h-4 w-4 text-muted-foreground" />}
          </span>
          <step.icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1">{step.label}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{STEP_COPY[step.state]}</span>
        </li>
      ))}
    </ol>
  );
}

/** The one place in the app where seconds tick: the punch-in dialog, where the moment matters. */
function LiveClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className="grid justify-items-center gap-1 py-1 text-center">
      <p className="text-5xl font-black leading-none tracking-tight tabular-nums" aria-label={`The time is ${now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}>
        {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
      </p>
      <p className="text-sm text-muted-foreground">{now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}</p>
    </div>
  );
}

/** How long the success state stays before the dialog closes itself. */
export const SUCCESS_AUTOCLOSE_MS = 2000;

function PunchInDone({ punchedAt, lateMinutes, onDone }: Readonly<{ punchedAt: string | null; lateMinutes: number; onDone?: () => void }>) {
  const reduced = usePrefersReducedMotion();
  const time = punchedAt ? new Date(punchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  useEffect(() => {
    if (!onDone) return;
    const id = window.setTimeout(onDone, SUCCESS_AUTOCLOSE_MS);
    return () => window.clearTimeout(id);
  }, [onDone]);
  return (
    <div className="grid justify-items-center gap-3 py-6 text-center" role="status" aria-live="polite">
      <span className={`grid h-14 w-14 place-items-center rounded-full bg-success/15 text-success ${reduced ? "" : "punch-in-check"}`}>
        <CheckCircle2 className="h-8 w-8" aria-hidden="true" />
      </span>
      <p className="text-lg font-semibold">Punched in{time ? ` ${time}` : ""}</p>
      <p className="text-sm text-muted-foreground">
        {lateMinutes > 0 ? `${durationText(lateMinutes)} after the expected start. No action needed.` : "Have a good day."}
      </p>
      {onDone && (
        <Button variant="ghost" className="min-h-[44px]" onClick={onDone}>
          Close
        </Button>
      )}
    </div>
  );
}

/**
 * Already punched in: "In since 09:02 · 7h 39m" and a secondary Punch out. Used by the Today card on
 * My attendance and wherever a punched-in state is shown. Duration updates once a minute.
 */
export function PunchedInPanel({ record, onChanged, className }: Readonly<{ record: NonNullable<MyToday["record"]>; onChanged?: () => void; className?: string }>) {
  const queryClient = useQueryClient();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  const out = useMutation({
    mutationFn: attendanceApi.punchOut,
    onSuccess: (result) => {
      toast.success(result.updated ? "Punched out" : "You were already punched out");
      runInBackground(queryClient.invalidateQueries({ queryKey: MY_TODAY_QUERY_KEY }));
      runInBackground(queryClient.invalidateQueries({ queryKey: ["attendance", "me"] }));
      onChanged?.();
    },
    onError: (err: unknown) => toast.error("Could not punch out", { description: (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? "Try again." })
  });
  const since = new Date(record.punchInAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const until = record.punchOutAt ? new Date(record.punchOutAt) : now;
  const minutes = Math.max(0, Math.floor((until.getTime() - new Date(record.punchInAt).getTime()) / 60_000));
  const duration = durationText(minutes);
  return (
    <div className={cn("flex min-w-0 flex-wrap items-center justify-between gap-3", className)}>
      <p className="min-w-0 text-sm" aria-live="polite">
        {record.punchOutAt ? (
          <>
            <span className="font-semibold">Out at {new Date(record.punchOutAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            <span className="text-muted-foreground"> · in {since} · {duration}</span>
          </>
        ) : (
          <>
            <span className="font-semibold">In since {since}</span>
            <span className="text-muted-foreground"> · {duration}</span>
          </>
        )}
      </p>
      {!record.punchOutAt && record.source === "WEB" && (
        <Button variant="outline" className="min-h-[44px]" disabled={out.isPending} onClick={() => out.mutate()}>
          <LogOut className="mr-2 h-4 w-4" aria-hidden="true" />
          {out.isPending ? "Punching out…" : "Punch out"}
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
  onPhaseChange,
  onSkip
}: Readonly<{ today: MyToday; onDone?: () => void; onPhaseChange?: (phase: Phase) => void; onSkip?: () => void }>) {
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

  const states = stepStates(phase, wantsLocation, wantsFace, coords.current.lat != null);
  const stepItems: StepItem[] = [
    ...(wantsLocation
      ? [{ key: "LOCATION", icon: MapPin, label: required ? "Confirm your work location" : "Confirm your work location (optional)", state: states.location }]
      : []),
    ...(wantsFace ? [{ key: "FACE", icon: ScanFace, label: "Confirm it's you", state: states.face }] : [])
  ];
  const allowFlagged = today.faceFailureRule === "ALLOW_FLAGGED";
  const lateMinutes = today.latenessEnabled && punchedAt ? minutesLate(punchedAt, today.expectedStartMinute) : 0;
  if (phase === "done") return <PunchInDone punchedAt={punchedAt} lateMinutes={lateMinutes} onDone={onDone} />;
  const busy = phase === "locating" || phase === "submitting" || phase === "face";

  return (
    <div className="grid gap-4">
      <LiveClock />

      <Button
        autoFocus
        className="h-[56px] w-full text-base"
        onClick={() => {
          if (phase === "face-failed") {
            afterLocation();
            return;
          }
          runInBackground(start());
        }}
        disabled={busy}
        aria-busy={busy}
      >
        {busy ? <Loader2 className="mr-2 h-5 w-5 motion-safe:animate-spin" aria-hidden="true" /> : <Clock className="mr-2 h-5 w-5" aria-hidden="true" />}
        {primaryLabel(phase, Boolean(today.consentNeeded) && wantsLocation)}
      </Button>

      <StepChecklist items={stepItems} />

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

      {phase === "face-failed" && allowFlagged && (
        <Button variant="outline" className="min-h-[44px] w-full" onClick={() => punch.mutate(null)}>
          Punch in anyway
        </Button>
      )}
      {onSkip && !busy && (
        <button type="button" onClick={onSkip} className="focus-ring min-h-[44px] justify-self-center rounded-md px-3 text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
          Not now
        </button>
      )}

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
    dismissal: reopenRequested ? "none" : dismissal,
    role: user?.role
  });
  // Keep the dialog up through its own Done step, even though the refreshed status now says "notice".
  const keepOpen = activePhase === "done" || activePhase === "submitting" || activePhase === "face";
  const ownSurface = data?.punchInMode === "MANDATORY" && !isGateExempt(user?.role) ? "gate" : "dialog";
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
  const description = data.holidayName ? `Today is ${data.holidayName}.` : "Ready to start your day?";
  const body = <PunchInSteps today={data} onDone={finish} onPhaseChange={setActivePhase} onSkip={surface === "dialog" ? dismiss : undefined} />;

  if (surface === "gate") return <PunchInGateOverlay title={title} body={body} />;

  if (isPhone) {
    return (
      <Sheet open onOpenChange={(open) => !open && dismiss()}>
        <SheetContent side="bottom" className="max-h-[85dvh] overflow-y-auto rounded-t-2xl pb-[max(1.5rem,env(safe-area-inset-bottom))]">
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
      <DialogContent className="max-w-[440px]">
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
        <p className="mt-3 text-xs text-muted-foreground">
          Can&apos;t punch in because location or the camera isn&apos;t working on this device? Follow the steps above,
          try another device, or ask your administrator — you can sign out below meanwhile.
        </p>
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
  const optionalForViewer = data?.punchInMode === "OPTIONAL" || (data?.punchInMode === "MANDATORY" && isGateExempt(user?.role));
  if (!user || !data?.enabled || !optionalForViewer || data.record || !data.isWorkingDay) return null;
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
