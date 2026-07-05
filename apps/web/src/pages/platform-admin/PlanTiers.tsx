/**
 * WHAT: the platform-admin console's plan-tier configuration screen — per-tier (STARTER/TEAM/
 * ENTERPRISE) seat limit, AI budget ceiling, and allow-lists for SSO providers and chat
 * platforms.
 * WHY these specific four knobs: they're exactly what `services/plan-limits.service.ts` reads
 * as tier *defaults* — an individual org can still override seat limit/AI budget on its own
 * record (see `Organizations.tsx`), but the allow-lists (which SSO/chat providers a tier may
 * even configure) are tier-only, no per-org override.
 * WHO calls the backing API: `controllers/platform-admin.controller.ts`'s plan-tier-limits
 * routes, via `platformAdminPlanTierApi`.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Checkbox } from "../../components/ui/checkbox";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Skeleton } from "../../components/ui/skeleton";
import { toast } from "../../components/ui/toaster";
import { platformAdminPlanTierApi, type ChatPlatform, type PlanTierLimitRow, type SsoProvider } from "../../services/platform-admin-api";

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
    <div className="grid gap-6">
      <div>
        <h1 className="text-2xl font-black tracking-tight">Plan tiers</h1>
        <p className="mt-1 text-sm text-slate-400">Default seat limits, AI budget ceilings, and allowed SSO providers per tier — an organization's own overrides (set on its record) take precedence over these.</p>
      </div>

      {limits.isLoading && <Skeleton className="h-64 w-full bg-slate-800" />}
      {!limits.isLoading && limits.data && (
        <div className="grid gap-5 lg:grid-cols-3">
          {limits.data.map((tier) => (
            <TierCard key={tier.tier} tier={tier} />
          ))}
        </div>
      )}
    </div>
  );
}

function TierCard({ tier }: { tier: PlanTierLimitRow }) {
  const queryClient = useQueryClient();
  const [seatLimit, setSeatLimit] = useState(tier.seatLimit.toString());
  const [budget, setBudget] = useState(tier.aiMonthlyBudgetCeilingUsd);
  const [providers, setProviders] = useState<SsoProvider[]>(tier.allowedSsoProviders);
  const [chatPlatforms, setChatPlatforms] = useState<ChatPlatform[]>(tier.allowedChatPlatforms);

  useEffect(() => {
    setSeatLimit(tier.seatLimit.toString());
    setBudget(tier.aiMonthlyBudgetCeilingUsd);
    setProviders(tier.allowedSsoProviders);
    setChatPlatforms(tier.allowedChatPlatforms);
  }, [tier.seatLimit, tier.aiMonthlyBudgetCeilingUsd, tier.allowedSsoProviders, tier.allowedChatPlatforms]);

  const save = useMutation({
    mutationFn: () =>
      platformAdminPlanTierApi.update(tier.tier, {
        seatLimit: Number(seatLimit),
        aiMonthlyBudgetCeilingUsd: Number(budget),
        allowedSsoProviders: providers,
        allowedChatPlatforms: chatPlatforms
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
    <Card className="border-slate-800 bg-slate-900/60">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base text-slate-100">
          {TIER_LABEL[tier.tier]}
          {tier.tier === "ENTERPRISE" && <Badge variant="info">Highest</Badge>}
        </CardTitle>
        <CardDescription className="text-slate-400">Defaults applied to every organization on this tier.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-1.5">
          <Label className="text-slate-300">Seat limit</Label>
          <Input className="border-slate-700 bg-slate-950 text-slate-100" type="number" value={seatLimit} onChange={(e) => setSeatLimit(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label className="text-slate-300">AI budget ceiling ($/mo)</Label>
          <Input className="border-slate-700 bg-slate-950 text-slate-100" type="number" value={budget} onChange={(e) => setBudget(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label className="text-slate-300">Allowed SSO providers</Label>
          <div className="grid gap-2">
            {ALL_PROVIDERS.map((provider) => (
              <label key={provider} className="flex items-center gap-2 text-sm text-slate-300">
                <Checkbox checked={providers.includes(provider)} onCheckedChange={(checked) => toggleProvider(provider, Boolean(checked))} />
                {PROVIDER_LABEL[provider]}
              </label>
            ))}
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label className="text-slate-300">Allowed chat platforms</Label>
          <div className="grid gap-2">
            {ALL_CHAT_PLATFORMS.map((platform) => (
              <label key={platform} className="flex items-center gap-2 text-sm text-slate-300">
                <Checkbox
                  checked={chatPlatforms.includes(platform)}
                  onCheckedChange={(checked) => toggleChatPlatform(platform, Boolean(checked))}
                />
                {CHAT_PLATFORM_LABEL[platform]}
              </label>
            ))}
          </div>
        </div>
        <Button size="sm" className="w-fit bg-amber-500 text-slate-950 hover:bg-amber-400" disabled={save.isPending} onClick={() => save.mutate()}>
          Save
        </Button>
      </CardContent>
    </Card>
  );
}
