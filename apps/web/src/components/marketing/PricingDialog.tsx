/**
 * The full plan comparison, as a modal.
 *
 * WHY a modal rather than a fourth column on the page: an honest comparison of this product needs
 * ~25 rows, and a 25-row table wedged into a landing page is either unreadable on a phone or
 * scrolled past on a desktop. Three summary cards answer "which one am I?", and this answers
 * "what exactly do I get?" for the smaller number of people who ask it.
 *
 * ACCURACY IS THE HARD CONSTRAINT HERE. Every row below maps to something that actually exists in
 * the codebase — see Landing.tsx's header comment for the history of this file's claims drifting
 * ahead of the build. A row nobody has implemented is a support ticket at best and a refund at
 * worst, so when in doubt it doesn't go in.
 */
import { PLAN_TIER_LIMITS, type PlanTier } from "@timesheet/shared";
import { Check, Minus } from "lucide-react";
import { Fragment } from "react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "../ui/dialog";

type Cell = boolean | string;

/* Small formatters so the rows below read as claims rather than as string plumbing. Each one
 * reads PLAN_TIER_LIMITS, which is the same constant the control-plane seed writes into
 * PlanTierLimit — so a table cell and the limit it describes cannot drift apart. */

const TIER_LABEL: Record<string, string> = {
  GOOGLE: "Google",
  MICROSOFT: "Microsoft",
  SAML: "SAML",
  LDAP: "LDAP",
  SLACK: "Slack",
  MICROSOFT_TEAMS: "Teams",
  GOOGLE_CHAT: "Google Chat",
  TELEGRAM: "Telegram"
};

const usd = (amount: number) => (amount === 0 ? "—" : `$${amount.toLocaleString("en-US")}/mo`);
const ssoList = (tier: PlanTier) => PLAN_TIER_LIMITS[tier].allowedSsoProviders.map((p) => TIER_LABEL[p] ?? p).join(", ");
const chatList = (tier: PlanTier) => {
  const platforms = PLAN_TIER_LIMITS[tier].allowedChatPlatforms;
  return platforms.length === 0 ? false : platforms.map((p) => TIER_LABEL[p] ?? p).join(", ");
};

interface Row {
  label: string;
  /** What this actually means, for rows whose name isn't self-explanatory. */
  hint?: string;
  starter: Cell;
  team: Cell;
  enterprise: Cell;
}

const GROUPS: Array<{ group: string; rows: Row[] }> = [
  {
    group: "Core",
    rows: [
      { label: "Active users", starter: "Up to 10", team: "Unlimited", enterprise: "Unlimited" },
      { label: "Timesheets with overlap + daily-cap checks", starter: true, team: true, enterprise: true },
      { label: "Ticketing: list, Kanban board, checklists, links", starter: true, team: true, enterprise: true },
      { label: "Manager approvals with per-project SLA timers", starter: true, team: true, enterprise: true },
      {
        label: "Automatic SLA escalation",
        hint: "A missed deadline raises to the next manager up, without anyone noticing it manually.",
        starter: "Basic",
        team: true,
        enterprise: true
      },
      { label: "CSV + PDF exports", starter: "CSV only", team: true, enterprise: true }
    ]
  },
  {
    group: "AI — always bring your own key",
    rows: [
      {
        label: "Your provider, your key",
        hint: "Anthropic, OpenAI, Groq, Mistral, DeepSeek, OpenRouter, Gemini, or a self-hosted Ollama.",
        starter: false,
        team: true,
        enterprise: true
      },
      { label: "Auto-triage, duplicate detection, writing assistant", starter: false, team: true, enterprise: true },
      { label: "Email-to-ticket intake", starter: false, team: true, enterprise: true },
      {
        // Was a bare true/false, which hid a 25x difference. The per-tier figure is a HARD
        // platform ceiling clamped over whatever budget an org sets for itself, so a Team
        // customer with heavy AI usage hits $200 regardless of what they configure. Stating it
        // is the difference between a limit and a surprise.
        label: "Monthly AI spend ceiling",
        hint: "A platform cap on top of your own budget. Starter's is $0, which is why AI is unavailable there.",
        starter: usd(PLAN_TIER_LIMITS.STARTER.aiMonthlyBudgetCeilingUsd),
        team: usd(PLAN_TIER_LIMITS.TEAM.aiMonthlyBudgetCeilingUsd),
        enterprise: usd(PLAN_TIER_LIMITS.ENTERPRISE.aiMonthlyBudgetCeilingUsd)
      },
      {
        label: "Quality loop: capture, golden sets, prompt versions, evals",
        hint: "Measure whether a prompt change actually improved anything, instead of guessing.",
        starter: false,
        team: true,
        enterprise: true
      },
      { label: "AI activity log with per-decision feedback", starter: false, team: true, enterprise: true }
    ]
  },
  {
    group: "Analytics & proof",
    rows: [
      { label: "Insights: velocity, cycle time, workload, SLA compliance", starter: false, team: true, enterprise: true },
      {
        label: "Verified Work Attestations",
        hint: "A signed PDF of approved, identity-verified work you can hand a client.",
        starter: false,
        team: true,
        enterprise: true
      },
      { label: "Client-viewable share links for attestations", starter: false, team: true, enterprise: true },
      { label: "Cost analytics with rate snapshots", starter: false, team: true, enterprise: true },
      {
        // Derived, like the SSO and face-verification rows, so the cell and the entitlement it
        // describes cannot drift. Stated as a count rather than a tick because the difference
        // between 25 goals and unlimited is the kind of limit that should not be a surprise.
        label: "Goals with measured progress",
        hint: "Objectives whose progress is computed from approved hours, spend, closures, on-time rate, SLA breaches or project risk — not typed in.",
        starter: PLAN_TIER_LIMITS.STARTER.goalsEnabled,
        team: `${PLAN_TIER_LIMITS.TEAM.maxGoals} active`,
        enterprise: PLAN_TIER_LIMITS.ENTERPRISE.goalsEnabled
      },
      {
        // Derived like the rows above. Stated as a policy count on Team because that is the only
        // thing the tier caps — the module itself is included, and a table cell reading "limited"
        // would undersell it.
        label: "Change management",
        hint: "Raise, risk-assess, approve, schedule and review changes before they ship — with a backout plan the workspace can require rather than hope for.",
        starter: PLAN_TIER_LIMITS.STARTER.changeManagementEnabled,
        team: `${PLAN_TIER_LIMITS.TEAM.maxChangePolicies} approval policies`,
        enterprise: PLAN_TIER_LIMITS.ENTERPRISE.changeManagementEnabled
      },
      {
        // Derived, like every tier-varying row here.
        label: "Weekly AI/ML practice update",
        hint: "One consolidated leadership digest a week — products, POCs, bugs, security and training, each initiative with an owner, a RAG status and what moved. Drafted from your own figures, reviewed before it sends.",
        starter: PLAN_TIER_LIMITS.STARTER.practiceUpdateEnabled,
        team: PLAN_TIER_LIMITS.TEAM.practiceUpdateEnabled,
        enterprise: PLAN_TIER_LIMITS.ENTERPRISE.practiceUpdateEnabled
      }
    ]
  },
  {
    group: "Security & operations",
    rows: [
      { label: "Role-based access + tamper-evident audit log", starter: true, team: true, enterprise: true },
      { label: "Rotating httpOnly sessions + active-device list", starter: true, team: true, enterprise: true },
      {
        // Derived, and now includes LDAP on Enterprise — the hand-written version omitted it,
        // which under-sold the tier rather than over-selling it, but was still inaccurate.
        label: "Single sign-on",
        starter: ssoList("STARTER"),
        team: ssoList("TEAM"),
        enterprise: ssoList("ENTERPRISE")
      },
      {
        label: "Chat integrations",
        hint: "Open a ticket from a message in the channel where it was reported.",
        starter: chatList("STARTER"),
        team: chatList("TEAM"),
        enterprise: chatList("ENTERPRISE")
      },
      { label: "SSO-only mode (passwords disabled)", starter: false, team: false, enterprise: true },
      {
        // CORRECTED. This row said `team: true`, and it was false: PLAN_TIER_LIMITS grants
        // faceVerificationEnabled to ENTERPRISE only, and the feature fails CLOSED — a Team
        // customer's admin would have been refused when they tried to switch it on. Now derived
        // from the constant so it cannot say something the enforcement disagrees with.
        label: "Face verification at clock-in and approval",
        hint: "Optional. Encrypted templates, configurable retention, never leaves your server.",
        starter: PLAN_TIER_LIMITS.STARTER.faceVerificationEnabled,
        team: PLAN_TIER_LIMITS.TEAM.faceVerificationEnabled,
        enterprise: PLAN_TIER_LIMITS.ENTERPRISE.faceVerificationEnabled
      },
      {
        label: "Security finding ingestion + VAPT uploads",
        hint: "Your CI posts findings to your webhook. This product never runs a scanner itself.",
        starter: false,
        team: true,
        enterprise: true
      },
      { label: "Public API keys + HMAC-signed webhooks", starter: false, team: true, enterprise: true },
      {
        // CORRECTED. This row said Enterprise-only. It isn't: `getTenantClient` resolves a
        // per-organization database for every tenant regardless of plan — there is no
        // shared-schema path in this product — and the landing page says so unconditionally in
        // two other places. Marking it Enterprise-only both contradicted the same page and sold
        // Enterprise on something Starter already has.
        label: "Dedicated database, never shared with another tenant",
        hint: "Architectural, not a plan feature — no organization has ever shared a schema.",
        starter: true,
        team: true,
        enterprise: true
      },
      { label: "Platform-adjustable seat and AI-budget limits", starter: false, team: false, enterprise: true },
      { label: "Dedicated support + uptime SLA", starter: false, team: false, enterprise: true }
    ]
  }
];

function CellValue({ value }: { value: Cell }) {
  if (value === true) {
    return (
      <>
        <Check className="mx-auto h-4 w-4 text-success" aria-hidden />
        <span className="sr-only">Included</span>
      </>
    );
  }
  if (value === false) {
    return (
      <>
        <Minus className="mx-auto h-4 w-4 text-muted-foreground/40" aria-hidden />
        <span className="sr-only">Not included</span>
      </>
    );
  }
  return <span className="text-xs font-medium">{value}</span>;
}

export function PricingDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* The dialog itself no longer scrolls — the table's own container does (below). Two scroll
          containers nested inside each other is what broke the sticky header: the header's nearest
          scrollport was the horizontal wrapper, which never scrolls vertically, so `sticky top-0`
          did nothing while the outer dialog carried the rows past it. */}
      <DialogContent className="flex max-h-[92vh] w-[min(96vw,940px)] max-w-none flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Compare plans</DialogTitle>
          <DialogDescription>
            Every row here is something that exists in the product today, and the tier-gated rows are generated from the
            same limits the platform enforces. AI features need your own provider key on every plan — we never resell
            inference.
          </DialogDescription>
        </DialogHeader>

        {/* One container, scrolling BOTH ways, so it is the sticky header's scrollport. Three plan
            columns plus a label column can't compress below ~640px without becoming unreadable,
            hence the horizontal scroll; `min-h-0` lets it actually shrink inside the flex column
            instead of forcing the dialog taller than the viewport. */}
        <div className="-mx-2 min-h-0 flex-1 overflow-auto px-2">
          <table className="w-full min-w-[620px] border-collapse text-sm">
            {/* bg-popover, not bg-background: DialogContent is bg-popover, and the two are
                different colours in both themes — the old value rendered as a visibly mismatched
                band across the full width of the table. */}
            <thead className="sticky top-0 z-10 bg-popover">
              <tr className="border-b border-border">
                <th scope="col" className="py-3 pr-3 text-left font-semibold">
                  Feature
                </th>
                <th scope="col" className="w-28 px-2 py-3 text-center font-semibold">
                  Starter
                  <span className="block text-xs font-normal text-muted-foreground">$0</span>
                </th>
                <th scope="col" className="w-28 px-2 py-3 text-center font-semibold text-primary">
                  Team
                  <span className="block text-xs font-normal text-muted-foreground">$8 / seat</span>
                </th>
                <th scope="col" className="w-28 px-2 py-3 text-center font-semibold">
                  Enterprise
                  <span className="block text-xs font-normal text-muted-foreground">Custom</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {GROUPS.map(({ group, rows }) => (
                <Fragment key={group}>
                  <tr>
                    <th
                      scope="colgroup"
                      colSpan={4}
                      className="pb-1 pt-5 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                    >
                      {group}
                    </th>
                  </tr>
                  {rows.map((row) => (
                    <tr key={row.label} className="border-b border-border/60 last:border-0">
                      <th scope="row" className="py-2.5 pr-3 text-left font-normal">
                        {row.label}
                        {row.hint && <span className="block text-xs text-muted-foreground">{row.hint}</span>}
                      </th>
                      <td className="px-2 py-2.5 text-center">
                        <CellValue value={row.starter} />
                      </td>
                      <td className="bg-primary/5 px-2 py-2.5 text-center">
                        <CellValue value={row.team} />
                      </td>
                      <td className="px-2 py-2.5 text-center">
                        <CellValue value={row.enterprise} />
                      </td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>

        <p className="rounded-md border border-dashed border-border bg-muted/30 p-3 text-xs text-muted-foreground">
          <Badge variant="muted" className="mr-2 align-middle">
            Note
          </Badge>
          AI usage is billed by your provider, not by us. The monthly budget cap is enforced on every call, so a
          misconfigured automation can't run up a bill you didn't agree to.
        </p>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
