/**
 * WHAT: the "Billing" tab in Workspace Settings — shows this org's current plan tier and seat
 * usage, with self-serve "Upgrade" buttons that start a Stripe Checkout session
 * (billing.controller.ts). Split out as its own file for the same reason every other settings
 * domain is.
 * WHY upgrades might be unavailable: `checkoutAvailable` reflects whether a platform admin has
 * configured a Stripe Price ID for that tier yet (PlanTiers.tsx's billing settings card) — an
 * org can still be manually assigned a tier by a platform admin either way.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { CreditCard } from "lucide-react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Skeleton } from "../../components/ui/skeleton";
import { toast } from "../../components/ui/toaster";
import { billingApi } from "../../services/api";

const TIER_LABEL: Record<string, string> = { STARTER: "Starter", TEAM: "Team", ENTERPRISE: "Enterprise" };

export function BillingSettingsCard({ readOnly }: { readOnly: boolean }) {
  const status = useQuery({ queryKey: ["billing", "status"], queryFn: billingApi.status });

  const checkout = useMutation({
    mutationFn: (tier: "TEAM" | "ENTERPRISE") => billingApi.checkoutSession(tier),
    onSuccess: (data) => {
      window.location.href = data.url;
    },
    onError: (err: any) => {
      const message = err?.response?.data?.message ?? "Try again.";
      toast.error("Couldn't start checkout", { description: message });
    }
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CreditCard className="h-4 w-4 text-primary" />
          Plan & billing
        </CardTitle>
        <CardDescription>Your workspace's current plan and seat usage.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {status.isLoading && <Skeleton className="h-24 w-full" />}
        {!status.isLoading && status.data && (
          <>
            <div className="flex items-center gap-3">
              <Badge variant="success">{TIER_LABEL[status.data.planTier] ?? status.data.planTier}</Badge>
              <span className="text-sm text-muted-foreground">
                {status.data.activeSeats} / {status.data.seatLimit} seats used
              </span>
            </div>

            {!readOnly && status.data.planTier !== "ENTERPRISE" && (
              <div className="flex flex-wrap gap-2">
                {status.data.planTier === "STARTER" && (
                  <Button
                    size="sm"
                    disabled={!status.data.checkoutAvailable.TEAM || checkout.isPending}
                    onClick={() => checkout.mutate("TEAM")}
                  >
                    Upgrade to Team
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!status.data.checkoutAvailable.ENTERPRISE || checkout.isPending}
                  onClick={() => checkout.mutate("ENTERPRISE")}
                >
                  Upgrade to Enterprise
                </Button>
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
