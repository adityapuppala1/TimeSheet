/**
 * WHAT: the "Billing" tab in Workspace Settings — this org's current plan tier and seat usage,
 * self-serve plan-change buttons, a link into Stripe's hosted Customer Portal, and the last twelve
 * invoices. Split out as its own file for the same reason every other settings domain is.
 * WHY upgrades might be unavailable: `checkoutAvailable` reflects whether a platform admin has
 * configured a Stripe Price ID for that tier yet (PlanTiers.tsx's billing settings card) — an
 * org can still be manually assigned a tier by a platform admin either way.
 * WHY there are two plan-change paths: a workspace with no subscription is sent to a hosted
 * Checkout page; one that already pays has its existing subscription changed in place, because
 * opening a second Checkout for it is how you end up billing a customer for two plans at once.
 * `hasSubscription` from `/billing/status` is what decides, and the copy on the buttons has to
 * follow it — promising "a Stripe Checkout page" to somebody who will never see one is the small
 * lie that makes people distrust the whole screen.
 */
import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CreditCard, ExternalLink, Receipt } from "lucide-react";
import { useSearchParams } from "react-router";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { StripeMark } from "../../components/ui/connector-marks";
import { Skeleton } from "../../components/ui/skeleton";
import { toast } from "../../components/ui/toaster";
import { billingApi, type BillingInvoice } from "../../services/api";

const TIER_LABEL: Record<string, string> = { STARTER: "Starter", TEAM: "Team", ENTERPRISE: "Enterprise" };

/** How long to wait before asking the server a second time what the plan is now.
 *  See `useEffect` below — this exists because Stripe's webhook and Stripe's redirect are two
 *  independent races and the browser usually wins the first one. */
const WEBHOOK_SETTLE_MS = 4000;

/**
 * Stripe reports money in MINOR units, and "minor unit" is not always 1/100: JPY and KRW have no
 * subunit at all, so dividing by 100 would show a ¥5,000 invoice as ¥50. `Intl` already knows how
 * many decimal places a currency has, so the exponent is asked for rather than assumed.
 */
function formatMoney(minorUnits: number, currency: string): string {
  const code = (currency || "usd").toUpperCase();
  try {
    const formatter = new Intl.NumberFormat(undefined, { style: "currency", currency: code });
    const digits = formatter.resolvedOptions().minimumFractionDigits ?? 2;
    return formatter.format(minorUnits / 10 ** digits);
  } catch {
    // An unknown currency code throws rather than degrading, and a billing screen that renders
    // nothing is worse than one that renders a plain number.
    return `${(minorUnits / 100).toFixed(2)} ${code}`;
  }
}

/** Stripe's invoice statuses, toned. `paid` is the only good one; `open` is money we are still
 *  waiting for, and the rest are dead documents rather than problems. */
function invoiceTone(status: string | null): "success" | "warning" | "muted" {
  if (status === "paid") return "success";
  if (status === "open" || status === "past_due") return "warning";
  return "muted";
}

function InvoiceRow({ invoice }: { invoice: BillingInvoice }) {
  // `amount_paid` is 0 on an invoice that hasn't been paid yet, and showing "$0.00" for a bill that
  // is genuinely due reads as "you owe nothing" — so an unpaid invoice shows what is DUE.
  const amount = invoice.status === "paid" ? invoice.amountPaid : invoice.amountDue;
  const link = invoice.hostedInvoiceUrl ?? invoice.invoicePdf;
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-border py-2 text-sm first:border-t-0">
      <span className="min-w-0 flex-1 truncate">
        <span className="text-foreground">{new Date(invoice.created).toLocaleDateString()}</span>
        {invoice.number && <span className="ml-2 text-xs text-muted-foreground">{invoice.number}</span>}
      </span>
      <span className="tabular-nums text-foreground">{formatMoney(amount, invoice.currency)}</span>
      <Badge variant={invoiceTone(invoice.status)}>{invoice.status ?? "unknown"}</Badge>
      {link && (
        /* Links OUT to Stripe's own hosted page rather than streaming the PDF through this app:
           the document is Stripe's, it is always current there, and a download started by this
           SPA is silently inert in the sandboxed contexts this UI also renders in. */
        <a
          href={link}
          target="_blank"
          rel="noreferrer"
          className="focus-ring inline-flex items-center gap-1 rounded text-xs text-primary hover:underline"
        >
          View <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </li>
  );
}

export function BillingSettingsCard({ readOnly }: { readOnly: boolean }) {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ["billing", "status"], queryFn: billingApi.status });

  // Only asked for once there is a Stripe customer — the server answers `[]` either way, but a
  // request per settings visit for every workspace that has never been billed is a request for
  // nothing.
  const invoices = useQuery({
    queryKey: ["billing", "invoices"],
    queryFn: billingApi.invoices,
    enabled: Boolean(status.data?.hasStripeCustomer)
  });

  const refreshBilling = () => {
    queryClient.invalidateQueries({ queryKey: ["billing", "status"] });
    queryClient.invalidateQueries({ queryKey: ["billing", "invoices"] });
  };

  const [searchParams, setSearchParams] = useSearchParams();
  const outcome = searchParams.get("billing");
  // StrictMode runs effects twice on mount with identical props, and the URL is only cleaned on the
  // render AFTER `setSearchParams` — so without this the customer gets two identical toasts.
  const announced = useRef(false);

  /**
   * Stripe sends the browser back to `/app/settings?billing=success` (or `…=cancelled`), and until
   * this existed nothing read that at all: a customer who had just paid was returned to an
   * unchanged settings page with no confirmation of any kind, which is indistinguishable from a
   * failed payment.
   */
  useEffect(() => {
    if (!outcome || announced.current) return;
    announced.current = true;

    if (outcome === "success") {
      toast.success("Payment received", { description: "Your plan is being activated — a receipt is on its way to your workspace admins." });
      refreshBilling();
    } else if (outcome === "cancelled") {
      toast.info("Checkout cancelled", { description: "Nothing changed and you haven't been charged." });
    }

    // Strip the marker. A refresh, or a Back into this URL, would otherwise re-announce a payment
    // that happened days ago — and `replace` keeps the parameterised URL out of history entirely.
    setSearchParams(
      (params) => {
        const next = new URLSearchParams(params);
        next.delete("billing");
        return next;
      },
      { replace: true }
    );

    if (outcome !== "success") return;
    // THE REDIRECT AND THE WEBHOOK ARE A RACE, and the redirect usually wins: Stripe bounces the
    // browser back the instant the payment clears, while `planTier` is only written when the
    // webhook lands a moment later. One refetch on arrival is therefore often a refetch of the OLD
    // tier, so it is asked once more after a beat rather than leaving the customer looking at the
    // plan they just stopped being on.
    const timer = window.setTimeout(refreshBilling, WEBHOOK_SETTLE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcome]);

  const checkout = useMutation({
    mutationFn: (tier: "TEAM" | "ENTERPRISE") => billingApi.checkoutSession(tier),
    onSuccess: (data) => {
      // TWO SHAPES, one per server path. Reading `url` unconditionally is how the in-place path
      // would navigate to `undefined` and blank the tab.
      if (data.mode === "checkout") {
        window.location.href = data.url;
        return;
      }
      toast.success("Plan change submitted", {
        description: "Your existing subscription was updated — the new plan appears here as soon as Stripe confirms it."
      });
      refreshBilling();
      // Same race as the redirect path, same answer.
      window.setTimeout(refreshBilling, WEBHOOK_SETTLE_MS);
    },
    onError: (err: any) => {
      const message = err?.response?.data?.message ?? "Try again.";
      toast.error("Couldn't change your plan", { description: message });
    }
  });

  const portal = useMutation({
    mutationFn: () => billingApi.portalSession(),
    onSuccess: (data) => {
      window.location.href = data.url;
    },
    onError: (err: any) => {
      const message = err?.response?.data?.message ?? "Try again.";
      toast.error("Couldn't open the billing portal", { description: message });
    }
  });

  const hasSubscription = Boolean(status.data?.hasSubscription);
  const invoiceRows = invoices.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CreditCard className="h-4 w-4 text-primary" />
          Plan & billing
        </CardTitle>
        <CardDescription>Your workspace's current plan, seat usage and invoices.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {status.isLoading && <Skeleton className="h-24 w-full" />}
        {!status.isLoading && status.data && (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <Badge variant="success">{TIER_LABEL[status.data.planTier] ?? status.data.planTier}</Badge>
              <span className="text-sm text-muted-foreground">
                {status.data.activeSeats} / {status.data.seatLimit} seats used
              </span>
              {!readOnly && status.data.hasStripeCustomer && (
                /* The one button that covers card updates, billing address, tax ids, receipts and
                   cancellation — none of which this product implements, and none of which it
                   should. It renders on `hasStripeCustomer` rather than on `hasSubscription`
                   because a workspace whose subscription has ended still needs to reach its own
                   invoice history. */
                <Button size="sm" variant="outline" className="ml-auto" disabled={portal.isPending} onClick={() => portal.mutate()}>
                  Manage billing
                  <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
                </Button>
              )}
            </div>

            {!readOnly && status.data.planTier !== "ENTERPRISE" && (
              /* The Stripe mark sits with the PLAN-CHANGE buttons, not on the card header. The
                 header is "Plan & billing", which is this product's own concept; what happens when
                 one of these is pressed depends on whether there is already a subscription, and
                 saying which before the click is the honest place for it. */
              <div className="grid gap-2">
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <StripeMark className="h-3.5 w-3.5 shrink-0" />
                  {hasSubscription
                    ? "Payment is handled by Stripe — this changes the subscription you already have, straight away. No new checkout, and the difference is prorated on your next invoice."
                    : "Payment is handled by Stripe — these open a Stripe Checkout page."}
                </p>
                <div className="flex flex-wrap gap-2">
                  {status.data.planTier === "STARTER" && (
                    <Button
                      size="sm"
                      disabled={!status.data.checkoutAvailable.TEAM || checkout.isPending}
                      onClick={() => checkout.mutate("TEAM")}
                    >
                      {hasSubscription ? "Switch to Team" : "Upgrade to Team"}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!status.data.checkoutAvailable.ENTERPRISE || checkout.isPending}
                    onClick={() => checkout.mutate("ENTERPRISE")}
                  >
                    {hasSubscription ? "Switch to Enterprise" : "Upgrade to Enterprise"}
                  </Button>
                </div>
              </div>
            )}

            {invoiceRows.length > 0 && (
              <div className="grid gap-1.5">
                <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <Receipt className="h-3.5 w-3.5 shrink-0" />
                  Recent invoices
                </p>
                <ul className="rounded-md border border-border px-3">
                  {invoiceRows.map((invoice) => (
                    <InvoiceRow key={invoice.id} invoice={invoice} />
                  ))}
                </ul>
              </div>
            )}

            {!status.data.checkoutAvailable.TEAM && !status.data.checkoutAvailable.ENTERPRISE && (
              <p className="text-xs text-muted-foreground">
                Self-serve upgrades aren't configured on this deployment yet — contact your platform administrator to change plans.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
