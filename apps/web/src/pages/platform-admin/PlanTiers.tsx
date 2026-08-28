/**
 * WHAT: the platform-admin console's plan-tier configuration screen — everything
 * `services/plan-limits.service.ts` reads as a tier DEFAULT: seat limit, AI budget ceiling, the
 * SSO and chat allow-lists, ten boolean capabilities and seven quotas.
 *
 * WHY IT IS GENERATED RATHER THAN HAND-LISTED: this screen used to render four knobs and one
 * feature checkbox while the platform enforced twenty-one entitlements. The gap was structural,
 * not an oversight anyone could see — the PATCH body schema was `.strict()` and had never been
 * widened either, so the fifteen missing ones returned 400 even if a client sent them. V6's
 * planning layer, V8's goals and change management and 3.5.0's practice update were all
 * reachable only through a database migration.
 *
 * The form now renders from `PLAN_CAPABILITIES` / `PLAN_QUOTAS` in `platform-admin-api.ts`, so
 * adding an entitlement to that list is what puts it on this page. A per-field `useState` is
 * exactly the shape that stopped anyone adding the sixteenth.
 *
 * SCOPE, unchanged: an individual org can still override seat limit and AI budget on its own
 * record (see `Organizations.tsx`); everything else here is tier-only, with no per-org override.
 *
 * WHO calls the backing API: `controllers/platform-admin.controller.ts`'s plan-tier-limits
 * routes, via `platformAdminPlanTierApi`.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { UNLIMITED_PLAN_ITEMS } from "@timesheet/shared";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Checkbox } from "../../components/ui/checkbox";
/* The same marks the tenant app uses, so a platform admin ticking "Slack" here sees the mark the
   workspace admin will see when they configure it. */
import { CHAT_PLATFORM_MARKS, SSO_PROVIDER_MARKS } from "../../components/ui/connector-marks";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Skeleton } from "../../components/ui/skeleton";
import { toast } from "../../components/ui/toaster";
import { ConsolePage } from "./console-ui";
import { PLAN_CAPABILITIES, PLAN_QUOTAS, platformAdminBillingApi, platformAdminPlanTierApi, type ChatPlatform, type PlanCapabilityKey, type PlanQuotaKey, type PlanTierLimitRow, type SsoProvider } from "../../services/platform-admin-api";

const TIER_LABEL: Record<PlanTierLimitRow["tier"], string> = { STARTER: "Starter", TEAM: "Team", ENTERPRISE: "Enterprise" };
const ALL_PROVIDERS: SsoProvider[] = ["GOOGLE", "MICROSOFT", "SAML", "LDAP"];
const PROVIDER_LABEL: Record<SsoProvider, string> = { GOOGLE: "Google", MICROSOFT: "Microsoft / Azure AD", SAML: "SAML", LDAP: "LDAP / Active Directory" };
const ALL_CHAT_PLATFORMS: ChatPlatform[] = ["SLACK", "MICROSOFT_TEAMS", "GOOGLE_CHAT", "TELEGRAM"];
const CHAT_PLATFORM_LABEL: Record<ChatPlatform, string> = {
  SLACK: "Slack",
  MICROSOFT_TEAMS: "Microsoft Teams",
  GOOGLE_CHAT: "Google Chat",
  TELEGRAM: "Telegram"
};

export function PlatformAdminPlanTiers() {
  const limits = useQuery({ queryKey: ["platform-admin", "plan-tier-limits"], queryFn: platformAdminPlanTierApi.list });

  return (
    <ConsolePage
      eyebrow="Tenants"
      title="Plan tiers"
      description="Every entitlement the platform enforces, per tier — seats, AI budget, the SSO and chat allow-lists, ten capabilities and seven quotas. Seat limit and AI budget can be overridden per organization on its own record; everything else here is tier-only."
    >
      <StripeBillingCard />

      {limits.isLoading && <Skeleton className="h-64 w-full" />}
      {!limits.isLoading && limits.data && (
        <div className="grid gap-5 lg:grid-cols-3">
          {limits.data.map((tier) => (
            <TierCard key={tier.tier} tier={tier} />
          ))}
        </div>
      )}
    </ConsolePage>
  );
}

/** Platform-wide Stripe configuration — one merchant-of-record account across every org (see
 *  billing.controller.ts's header comment). Secret key/webhook signing secret are masked
 *  write-only fields, same convention as every other credential in this app. */
function StripeBillingCard() {
  const queryClient = useQueryClient();
  const billing = useQuery({ queryKey: ["platform-admin", "billing-settings"], queryFn: platformAdminBillingApi.get });
  const [secretKey, setSecretKey] = useState("");
  const [webhookSigningSecret, setWebhookSigningSecret] = useState("");
  const [priceIdTeam, setPriceIdTeam] = useState("");
  const [priceIdEnterprise, setPriceIdEnterprise] = useState("");

  useEffect(() => {
    if (billing.data) {
      setPriceIdTeam(billing.data.priceIdTeam ?? "");
      setPriceIdEnterprise(billing.data.priceIdEnterprise ?? "");
    }
  }, [billing.data]);

  const save = useMutation({
    mutationFn: () =>
      platformAdminBillingApi.update({
        ...(secretKey ? { secretKey } : {}),
        ...(webhookSigningSecret ? { webhookSigningSecret } : {}),
        priceIdTeam: priceIdTeam || null,
        priceIdEnterprise: priceIdEnterprise || null
      }),
    onSuccess: () => {
      setSecretKey("");
      setWebhookSigningSecret("");
      queryClient.invalidateQueries({ queryKey: ["platform-admin", "billing-settings"] });
      toast.success("Billing settings saved");
    },
    onError: () => toast.error("Could not save", { description: "Try again." })
  });

  return (
    <Card className="border-border bg-card">
      <CardHeader>
        <CardTitle className="text-base text-foreground">Stripe billing</CardTitle>
        <CardDescription className="text-muted-foreground">
          One Stripe account across every org on this deployment — orgs never bring their own key. Create a Restricted API Key
          (Checkout Sessions + Customers + Subscriptions, write) and a webhook endpoint pointed at{" "}
          <code className="text-xs">/api/billing/webhook</code>, then paste both here alongside the two Price IDs created for the Team
          and Enterprise tiers.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {billing.isLoading && <Skeleton className="h-32 w-full" />}
        {!billing.isLoading && billing.data && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant={billing.data.secretKeySet ? "success" : "muted"}>{billing.data.secretKeySet ? "Secret key set" : "No secret key"}</Badge>
              <Badge variant={billing.data.webhookSigningSecretSet ? "success" : "muted"}>
                {billing.data.webhookSigningSecretSet ? "Webhook secret set" : "No webhook secret"}
              </Badge>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label className="text-foreground">Secret key</Label>
                <Input type="password" placeholder="sk_live_..." value={secretKey} onChange={(e) => setSecretKey(e.target.value)} className="bg-background" />
              </div>
              <div className="grid gap-1.5">
                <Label className="text-foreground">Webhook signing secret</Label>
                <Input
                  type="password"
                  placeholder="whsec_..."
                  value={webhookSigningSecret}
                  onChange={(e) => setWebhookSigningSecret(e.target.value)}
                  className="bg-background"
                />
              </div>
              <div className="grid gap-1.5">
                <Label className="text-foreground">Team tier Price ID</Label>
                <Input placeholder="price_..." value={priceIdTeam} onChange={(e) => setPriceIdTeam(e.target.value)} className="bg-background" />
              </div>
              <div className="grid gap-1.5">
                <Label className="text-foreground">Enterprise tier Price ID</Label>
                <Input placeholder="price_..." value={priceIdEnterprise} onChange={(e) => setPriceIdEnterprise(e.target.value)} className="bg-background" />
              </div>
            </div>
            <Button size="sm" className="w-fit" onClick={() => save.mutate()} disabled={save.isPending}>
              Save
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function TierCard({ tier }: { tier: PlanTierLimitRow }) {
  const queryClient = useQueryClient();
  const [seatLimit, setSeatLimit] = useState(tier.seatLimit.toString());
  const [budget, setBudget] = useState(tier.aiMonthlyBudgetCeilingUsd);
  const [providers, setProviders] = useState<SsoProvider[]>(tier.allowedSsoProviders);
  const [chatPlatforms, setChatPlatforms] = useState<ChatPlatform[]>(tier.allowedChatPlatforms);
  // Generated from the shared lists rather than one `useState` per entitlement. The previous
  // version had a single `faceVerification` boolean while the platform enforced twenty-one, and a
  // per-field state hook is exactly the shape that stops anyone adding the sixteenth.
  const [capabilities, setCapabilities] = useState<Record<PlanCapabilityKey, boolean>>(() =>
    Object.fromEntries(PLAN_CAPABILITIES.map((c) => [c.key, tier[c.key]])) as Record<PlanCapabilityKey, boolean>
  );
  const [quotas, setQuotas] = useState<Record<PlanQuotaKey, string>>(() =>
    Object.fromEntries(PLAN_QUOTAS.map((q) => [q.key, String(tier[q.key] ?? 0)])) as Record<PlanQuotaKey, string>
  );

  // Re-sync when the row changes under us (another admin saved, or the query refetched). Keyed on
  // the row itself rather than on each field, which is what a generated form can honestly depend on.
  useEffect(() => {
    setSeatLimit(tier.seatLimit.toString());
    setBudget(tier.aiMonthlyBudgetCeilingUsd);
    setProviders(tier.allowedSsoProviders);
    setChatPlatforms(tier.allowedChatPlatforms);
    setCapabilities(Object.fromEntries(PLAN_CAPABILITIES.map((c) => [c.key, tier[c.key]])) as Record<PlanCapabilityKey, boolean>);
    setQuotas(Object.fromEntries(PLAN_QUOTAS.map((q) => [q.key, String(tier[q.key] ?? 0)])) as Record<PlanQuotaKey, string>);
  }, [tier]);

  const save = useMutation({
    mutationFn: () =>
      platformAdminPlanTierApi.update(tier.tier, {
        seatLimit: Number(seatLimit),
        aiMonthlyBudgetCeilingUsd: Number(budget),
        allowedSsoProviders: providers,
        allowedChatPlatforms: chatPlatforms,
        ...capabilities,
        ...(Object.fromEntries(PLAN_QUOTAS.map((q) => [q.key, Number(quotas[q.key]) || 0])) as Record<PlanQuotaKey, number>)
      }),
    onSuccess: () => {
      toast.success("Saved");
      queryClient.invalidateQueries({ queryKey: ["platform-admin", "plan-tier-limits"] });
    },
    onError: (err: any) => toast.error("Could not save", { description: err?.response?.data?.message ?? "Try again." })
  });

  const toggleProvider = (provider: SsoProvider, checked: boolean) => {
    setProviders((prev) => (checked ? [...prev, provider] : prev.filter((p) => p !== provider)));
  };

  const toggleChatPlatform = (platform: ChatPlatform, checked: boolean) => {
    setChatPlatforms((prev) => (checked ? [...prev, platform] : prev.filter((p) => p !== platform)));
  };

  return (
    <Card className="border-border bg-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base text-foreground">
          {TIER_LABEL[tier.tier]}
          {tier.tier === "ENTERPRISE" && <Badge variant="info">Highest</Badge>}
        </CardTitle>
        <CardDescription className="text-muted-foreground">Defaults applied to every organization on this tier.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-1.5">
          <Label className="text-foreground">Seat limit</Label>
          <Input className="border-border bg-background text-foreground" type="number" value={seatLimit} onChange={(e) => setSeatLimit(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label className="text-foreground">AI budget ceiling ($/mo)</Label>
          <Input className="border-border bg-background text-foreground" type="number" value={budget} onChange={(e) => setBudget(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label className="text-foreground">Allowed SSO providers</Label>
          <div className="grid gap-2">
            {ALL_PROVIDERS.map((provider) => (
              <label key={provider} className="flex items-center gap-2 text-sm text-foreground">
                <Checkbox checked={providers.includes(provider)} onCheckedChange={(checked) => toggleProvider(provider, Boolean(checked))} />
                {(() => {
                  const Mark = SSO_PROVIDER_MARKS[provider];
                  return <Mark className="h-4 w-4 shrink-0" />;
                })()}
                {PROVIDER_LABEL[provider]}
              </label>
            ))}
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label className="text-foreground">Allowed chat platforms</Label>
          <div className="grid gap-2">
            {ALL_CHAT_PLATFORMS.map((platform) => (
              <label key={platform} className="flex items-center gap-2 text-sm text-foreground">
                <Checkbox
                  checked={chatPlatforms.includes(platform)}
                  onCheckedChange={(checked) => toggleChatPlatform(platform, Boolean(checked))}
                />
                {(() => {
                  const Mark = CHAT_PLATFORM_MARKS[platform];
                  return <Mark className="h-4 w-4 shrink-0" />;
                })()}
                {CHAT_PLATFORM_LABEL[platform]}
              </label>
            ))}
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label className="text-foreground">Features</Label>
          <div className="grid gap-2.5">
            {PLAN_CAPABILITIES.map((capability) => (
              <label key={capability.key} className="flex items-start gap-2 text-sm text-foreground">
                <Checkbox
                  className="mt-0.5"
                  checked={capabilities[capability.key]}
                  onCheckedChange={(checked) => setCapabilities((prev) => ({ ...prev, [capability.key]: Boolean(checked) }))}
                />
                <span>
                  {capability.label}
                  <span className="block text-xs leading-snug text-muted-foreground">{capability.hint}</span>
                </span>
              </label>
            ))}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Every capability here <strong className="text-muted-foreground">fails closed</strong> except face verification's
            enforcement leg, which fails open on purpose — a lapsed plan must stop demanding identity checks, never lock
            a workforce out of logging their own time. Unchecking face verification also starts each affected org's
            30-day biometric-data purge grace window.
          </p>
        </div>

        <div className="grid gap-1.5">
          <Label className="text-foreground">Quotas</Label>
          <div className="grid gap-2 sm:grid-cols-2">
            {PLAN_QUOTAS.map((quota) => (
              <div key={quota.key} className="grid gap-1">
                <span className="text-xs text-muted-foreground">{quota.label}</span>
                <Input
                  className="border-border bg-background text-foreground"
                  type="number"
                  min={0}
                  max={UNLIMITED_PLAN_ITEMS}
                  value={quotas[quota.key]}
                  onChange={(e) => setQuotas((prev) => ({ ...prev, [quota.key]: e.target.value }))}
                />
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            <strong className="text-muted-foreground">0</strong> means the tier cannot use that resource at all —
            it is a real ceiling, not "unlimited". {UNLIMITED_PLAN_ITEMS.toLocaleString()} is the sentinel for no limit.
          </p>
        </div>
        <Button size="sm" className="w-fit bg-accent text-accent-foreground hover:bg-accent/90" disabled={save.isPending} onClick={() => save.mutate()}>
          Save
        </Button>
      </CardContent>
    </Card>
  );
}
