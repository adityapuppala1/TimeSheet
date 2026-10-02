/**
 * WHAT a workspace sees when its trial has ended or a renewal failed — the screen behind the
 * server's 402 + `PLAN_LAPSED` — and, for the one person who can, the place it is paid from.
 *
 * WHY IT EXISTS AT ALL. Without it the API's refusals render as a page full of broken panels with
 * nothing saying why, which reads as "this product is down" rather than "this account needs a
 * card". The distinction matters most to the person who was about to pay.
 *
 * WHY IT TAKES PAYMENT ITSELF. "Choose a plan" used to link to /app/settings?tab=billing, inside the
 * app shell — whose notifications bell and project sidebar call routes a lapsed workspace is refused,
 * and every refusal navigates back here (services/api.ts). The admin who had decided to pay was
 * bounced in a loop, as was a customer returning from a successful Checkout before the webhook had
 * landed. So this page mounts nothing but itself and calls only what GRACE leaves open
 * (middleware/auth.ts): `/auth/*`, `/billing/standing` for everyone, and — for a super admin —
 * billing status, Checkout, the billing portal and the timesheet exports. Atlassian and Slack handle
 * a lapsed workspace the same way: the billing owner pays in place.
 *
 * WHAT THE COPY HAS TO DO, in order:
 *  1. Say the data is safe, first and unprompted. The assumption a customer arrives with is that
 *     their work has been deleted, and every sentence after that one is read through it.
 *  2. Name who can fix it — by name, from `/billing/standing`. An employee staring at a button they
 *     cannot use will file a support ticket the admin never hears about.
 *  3. Offer the one action, to the one person who has it: a plan for a trial that ended, the billing
 *     portal for a renewal that failed (utils/plan-lapsed.ts says which and why).
 *
 * There is deliberately no countdown, no "act now", and no price. This page is shown to people who
 * have already lost access; pressure here is just unpleasant.
 */
import { CheckCircle2, CreditCard, FileSpreadsheet, LifeBuoy, Loader2, Lock, LogOut, Repeat } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Navigate, useLocation, useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ForcedPasswordChange } from "../components/ForcedPasswordChange";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Skeleton } from "../components/ui/skeleton";
import { toast } from "../components/ui/toaster";
import { exportStamp, saveBlob } from "../lib/download";
import { isPasswordChangeRequired } from "../lib/password-change-gate";
import { runInBackground } from "../lib/run-in-background";
import { authApi, billingApi, reportApi } from "../services/api";
import { useAuthStore } from "../store/auth";
import { loginUrlFor } from "../utils/return-to";
import {
  canSwitchToSuperAdmin,
  contactLine,
  lapsedActions,
  lapsedPageMode,
  PAYMENT_POLL_MS,
  paymentWaitState,
  type BillingContact,
  type PaidTier
} from "../utils/plan-lapsed";

const TIER_LABEL: Record<PaidTier, string> = { TEAM: "Team", ENTERPRISE: "Enterprise" };
const STANDING_KEY = ["billing", "standing"] as const;

export function PlanLapsedPage() {
  const user = useAuthStore((s) => s.user);
  const hydrated = useAuthStore((s) => s.hydrated);
  const location = useLocation();
  const [params] = useSearchParams();
  const billingParam = params.get("billing");
  // Held at the change-password screen, every call this page makes is refused — so none is made.
  const passwordChangeRequired = isPasswordChangeRequired(user);
  const standing = useQuery({ queryKey: STANDING_KEY, queryFn: billingApi.standing, enabled: Boolean(user) && !passwordChangeRequired });

  // The session is restored by App.tsx's AuthBootstrap; until it settles, nothing is decided. A
  // visitor with no session — an email link opened in a fresh browser — signs in and comes back here.
  if (!hydrated) return <Frame><Skeleton className="h-40 w-full" /></Frame>;
  if (!user) return <Navigate to={loginUrlFor(location)} replace />;

  const mode = lapsedPageMode(billingParam, standing.data?.status, passwordChangeRequired);
  // The same screen AppLayout holds such a session at; once the password is changed it refreshes the
  // signed-in user, and this page re-renders as itself.
  if (mode === "change-password") return <ForcedPasswordChange />;
  if (mode === "finishing") return <FinishingPayment />;
  if (mode === "active") return <OpenAgain />;
  return (
    <Lapsed
      role={user.role}
      canSwitch={canSwitchToSuperAdmin(user)}
      contacts={standing.data?.contacts}
      contactsLoading={standing.isLoading}
      cancelled={billingParam === "cancelled"}
    />
  );
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-10">
      <Card className="w-full max-w-lg">{children}</Card>
    </div>
  );
}

function SignOutButton() {
  const logoutStore = useAuthStore((s) => s.logout);
  const queryClient = useQueryClient();
  const signOut = async () => {
    try {
      await authApi.logout();
    } catch {
      // Local cleanup still happens — a session the server already forgot is still one to leave.
    }
    logoutStore();
    queryClient.clear();
    window.location.assign("/login");
  };
  return (
    <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => runInBackground(signOut())}>
      <LogOut className="h-4 w-4" />
      Sign out
    </Button>
  );
}

function WhoCanRenew({ contacts, loading }: { contacts?: BillingContact[]; loading: boolean }) {
  if (loading) return <Skeleton className="h-5 w-3/4" />;
  return (
    <p className="text-sm leading-6 text-muted-foreground">
      Your workspace's plan has lapsed, and only a workspace admin can renew it. {contactLine(contacts)}
    </p>
  );
}

/** For somebody who holds super admin but is acting in another role (see canSwitchToSuperAdmin). The
 *  server reads the active role on every request, so the switch opens billing straight away. */
function SwitchToSuperAdmin({ role }: { role: string }) {
  const setUser = useAuthStore((s) => s.setUser);
  const queryClient = useQueryClient();
  const switchRole = useMutation({
    mutationFn: () => authApi.switchRole("SUPER_ADMIN"),
    onSuccess: (updated) => {
      setUser(updated);
      runInBackground(queryClient.invalidateQueries());
    },
    onError: (err: any) => toast.error("Couldn't switch role", { description: err?.response?.data?.message ?? "Try again." })
  });
  return (
    <div className="grid gap-2">
      <p className="text-sm leading-6 text-muted-foreground">
        You're signed in as {role.replace("_", " ").toLowerCase()}, but you also hold the super admin role — the one that can renew the plan.
      </p>
      <Button size="lg" className="justify-self-start" disabled={switchRole.isPending} onClick={() => switchRole.mutate()}>
        <Repeat className="h-4 w-4" />
        Switch to super admin
      </Button>
    </div>
  );
}

function Lapsed({
  role,
  canSwitch,
  contacts,
  contactsLoading,
  cancelled
}: {
  role: string;
  canSwitch: boolean;
  contacts?: BillingContact[];
  contactsLoading: boolean;
  cancelled: boolean;
}) {
  const isAdmin = role === "SUPER_ADMIN";
  return (
    <Frame>
      <CardHeader>
        <div className="mb-1 grid h-10 w-10 place-items-center rounded-lg bg-warning/10 text-warning-ink">
          <Lock className="h-5 w-5" />
        </div>
        <CardTitle>This workspace is paused</CardTitle>
        <CardDescription>Its plan has lapsed — either a free trial ended, or a renewal payment didn't go through.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        <p className="rounded-lg border border-border bg-card p-3.5 text-sm leading-6">
          <strong>Nothing has been deleted.</strong> Every timesheet, ticket, project and document is exactly where you
          left it, and will stay there. Choosing a plan puts the workspace back precisely as it was.
        </p>

        {cancelled && (
          <p className="text-sm text-muted-foreground" role="status">
            Checkout was cancelled — nothing changed, and you haven't been charged.
          </p>
        )}

        {isAdmin ? (
          <AdminActions role={role} />
        ) : (
          <div className="grid gap-2">
            {canSwitch ? <SwitchToSuperAdmin role={role} /> : <WhoCanRenew contacts={contacts} loading={contactsLoading} />}
            <Button variant="outline" asChild className="justify-self-start">
              <a href="/find-workspace">
                <LifeBuoy className="h-4 w-4" />
                Sign in to a different workspace
              </a>
            </Button>
          </div>
        )}

        <SignOutButton />
      </CardContent>
    </Frame>
  );
}

function AdminActions({ role }: { role: string }) {
  const [, setParams] = useSearchParams();
  const billing = useQuery({ queryKey: ["billing", "status"], queryFn: billingApi.status });
  const actions = lapsedActions(role, billing.data, billing.isError);

  const checkout = useMutation({
    mutationFn: (tier: PaidTier) => billingApi.checkoutSession(tier),
    onSuccess: (data) => {
      if (data.mode === "checkout") {
        window.location.href = data.url;
        return;
      }
      // An existing subscription was changed in place: nothing to collect, so wait for Stripe's
      // confirmation exactly as a return from Checkout does.
      setParams({ billing: "success" }, { replace: true });
    },
    onError: (err: any) => toast.error("Couldn't start checkout", { description: err?.response?.data?.message ?? "Try again." })
  });

  const portal = useMutation({
    mutationFn: () => billingApi.portalSession(),
    onSuccess: (data) => {
      window.location.href = data.url;
    },
    onError: (err: any) => toast.error("Couldn't open the billing portal", { description: err?.response?.data?.message ?? "Try again." })
  });

  const exportData = useMutation({
    mutationFn: (type: "csv" | "xlsx") => reportApi.download(type),
    onSuccess: (result, type) => {
      saveBlob(result.blob, `timesheets-${exportStamp()}.${type}`);
      if (result.truncated) {
        toast.info("The export is partial", { description: `It holds the most recent ${result.rowsIncluded.toLocaleString()} entries of ${result.totalMatching.toLocaleString() || "more"}.` });
      }
    },
    onError: (err: any) => toast.error("Couldn't export", { description: err?.response?.data?.message ?? "Try again." })
  });

  if (!actions) return null;
  const busy = checkout.isPending || portal.isPending;

  return (
    <div className="grid gap-4">
      {billing.isLoading && <Skeleton className="h-10 w-full" />}

      {actions.unavailable && (
        <div className="grid gap-2">
          <p className="text-sm leading-6 text-muted-foreground">
            This workspace's billing couldn't be loaded just now, so there's nothing to pay with yet. Try again in a moment — if it
            keeps failing, sign out and back in.
          </p>
          <Button variant="outline" className="justify-self-start" disabled={billing.isFetching} onClick={() => runInBackground(billing.refetch())}>
            Try again
          </Button>
        </div>
      )}

      {actions.plans.length > 0 && (
        <div className="grid gap-2">
          <p className="text-sm font-medium">Choose a plan</p>
          <div className="flex flex-wrap gap-2">
            {actions.plans.map((tier, index) => (
              <Button key={tier} size="lg" variant={index === 0 ? "default" : "outline"} disabled={busy} onClick={() => checkout.mutate(tier)}>
                {TIER_LABEL[tier]}
              </Button>
            ))}
          </div>
          <p className="text-xs leading-5 text-muted-foreground">Payment is handled by Stripe, on its own checkout page. The workspace opens again as soon as it confirms.</p>
        </div>
      )}

      {actions.portal && (
        <div className="grid gap-2">
          <Button size="lg" className="justify-self-start" disabled={busy} onClick={() => portal.mutate()}>
            <CreditCard className="h-4 w-4" />
            Update payment method
          </Button>
          <p className="text-xs leading-5 text-muted-foreground">
            The last renewal didn't go through. Update the card in Stripe's billing portal and the workspace opens again once the payment is taken.
          </p>
        </div>
      )}

      {actions.checkoutUnconfigured && (
        <p className="text-sm leading-6 text-muted-foreground">
          Plans can't be bought on this deployment yet — contact your platform administrator to renew it.
        </p>
      )}

      {actions.exports && (
        <div className="grid gap-2 border-t border-border pt-4">
          <p className="text-xs leading-5 text-muted-foreground">Your data stays yours whether or not there's a plan. Export every timesheet entry:</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={exportData.isPending} onClick={() => exportData.mutate("xlsx")}>
              <FileSpreadsheet className="h-4 w-4" />
              Excel
            </Button>
            <Button variant="outline" size="sm" disabled={exportData.isPending} onClick={() => exportData.mutate("csv")}>
              <FileSpreadsheet className="h-4 w-4" />
              CSV
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Back from Stripe. The browser usually arrives before Stripe's webhook has unlocked the workspace,
 * so this waits — polling the same status the auth gate uses — and opens the Billing tab, whose own
 * "Payment received" toast takes over, the moment it is ACTIVE. It says plainly when confirmation is
 * slow instead of spinning forever, and offers no second Checkout: paying again before the first
 * payment is confirmed is how a customer ends up with two subscriptions.
 */
function FinishingPayment() {
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const poll = useQuery({
    queryKey: [...STANDING_KEY, "after-payment", startedAt],
    queryFn: billingApi.standing,
    refetchInterval: (query) => (paymentWaitState(startedAt, Date.now(), query.state.data?.status) === "waiting" ? PAYMENT_POLL_MS : false)
  });
  const state = paymentWaitState(startedAt, Math.max(poll.dataUpdatedAt, poll.errorUpdatedAt, startedAt), poll.data?.status);

  useEffect(() => {
    if (state === "active") window.location.assign("/app/settings?billing=success");
  }, [state]);

  return (
    <Frame>
      <CardHeader>
        <div className="mb-1 grid h-10 w-10 place-items-center rounded-lg bg-primary/10 text-primary">
          {state === "timed-out" ? <CreditCard className="h-5 w-5" /> : <Loader2 className="h-5 w-5 motion-safe:animate-spin" />}
        </div>
        <CardTitle>{state === "timed-out" ? "Still waiting for Stripe" : "Finishing your payment…"}</CardTitle>
        <CardDescription>
          {state === "timed-out"
            ? "Stripe hasn't confirmed the payment yet. That usually takes seconds; it can take longer when the bank asks for an extra check."
            : "Stripe is confirming the payment. The workspace opens as soon as it does — this usually takes a few seconds."}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {state === "timed-out" && (
          <>
            <p className="text-sm leading-6 text-muted-foreground">
              Please don't pay again in the meantime. If the workspace still hasn't opened in a few minutes, check the
              receipt email from Stripe and contact support with it.
            </p>
            <Button className="justify-self-start" onClick={() => setStartedAt(Date.now())}>
              Check again
            </Button>
          </>
        )}
        <SignOutButton />
      </CardContent>
    </Frame>
  );
}

/** The workspace is ACTIVE — somebody paid, or an operator restored it. A status cache a few seconds
 *  stale on another server can still send a person here, so this offers the way in rather than
 *  redirecting by itself, which could loop for those few seconds. */
function OpenAgain() {
  return (
    <Frame>
      <CardHeader>
        <div className="mb-1 grid h-10 w-10 place-items-center rounded-lg bg-success/10 text-success-ink">
          <CheckCircle2 className="h-5 w-5" />
        </div>
        <CardTitle>This workspace is open again</CardTitle>
        <CardDescription>Its plan is active. Everything is where you left it.</CardDescription>
      </CardHeader>
      <CardContent>
        <Button asChild>
          <a href="/app">Open the workspace</a>
        </Button>
      </CardContent>
    </Frame>
  );
}
