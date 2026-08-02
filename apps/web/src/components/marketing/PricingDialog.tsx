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
      { label: "Monthly AI budget cap enforced per call", starter: false, team: true, enterprise: true },
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
      { label: "Cost analytics with rate snapshots", starter: false, team: true, enterprise: true }
    ]
  },
  {
    group: "Security & operations",
    rows: [
      { label: "Role-based access + tamper-evident audit log", starter: true, team: true, enterprise: true },
      { label: "Rotating httpOnly sessions + active-device list", starter: true, team: true, enterprise: true },
      { label: "Single sign-on", starter: "Google", team: "Google + Microsoft", enterprise: "Google, Microsoft, SAML" },
      { label: "SSO-only mode (passwords disabled)", starter: false, team: false, enterprise: true },
      {
        label: "Face verification at clock-in and approval",
        hint: "Optional. Encrypted templates, configurable retention, never leaves your server.",
        starter: false,
        team: true,
        enterprise: true
      },
      {
        label: "Security finding ingestion + VAPT uploads",
        hint: "Your CI posts findings to your webhook. This product never runs a scanner itself.",
        starter: false,
        team: true,
        enterprise: true
      },
      { label: "Public API keys + HMAC-signed webhooks", starter: false, team: true, enterprise: true },
      { label: "Dedicated database, never shared with another tenant", starter: false, team: false, enterprise: true },
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
      <DialogContent className="max-h-[92vh] w-[min(96vw,940px)] max-w-none overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Compare plans</DialogTitle>
          <DialogDescription>
            Every row here is something that exists in the product today. AI features need your own provider key on every
            plan — we never resell inference.
          </DialogDescription>
        </DialogHeader>

        {/* The table scrolls inside its own container rather than the page: three plan columns plus
            a label column can't compress below ~640px without becoming unreadable. */}
        <div className="-mx-2 overflow-x-auto px-2">
          <table className="w-full min-w-[620px] border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-background">
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
