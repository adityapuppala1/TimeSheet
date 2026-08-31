/**
 * Everybody who used the public contact form, and where each conversation got to.
 *
 * WHY THE WHOLE SUBMISSION IS ON THE SCREEN rather than behind a "view" dialog. A lead is read
 * once, by one person, deciding whether to pick it up — and the thing that decides it is the
 * paragraph they wrote, not the row summary. A list of summaries with the substance one click away
 * is a list that gets skimmed and a lead that gets missed, which is the only failure mode this
 * whole feature has. Volume makes that affordable: a deployment taking ten enquiries a week has had
 * a busy quarter.
 *
 * LAYOUT. Geometry comes from the console kit, as everywhere here. Each lead is TWO table rows —
 * a summary line that scans, and a detail line under it carrying the message, what they are
 * evaluating, where they came from and the private notes. They are separated by a top border on the
 * summary rather than by `divide-y`, so the pair reads as one block instead of four.
 *
 * NOTHING THE CUSTOMER WROTE IS EDITABLE. Status, owner and notes are ours; name, message and
 * qualification are a record of what somebody actually said, and a console that can rewrite that is
 * a console whose rows are not evidence of anything. The server enforces it; this page simply never
 * offers it.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AtSign, CalendarClock, Download, Handshake, Inbox, Mail, Sparkles } from "lucide-react";
import { useState } from "react";
import {
  DEPLOYMENT_LABEL,
  INTEREST_LABEL,
  SALES_LEAD_STATUSES,
  salesLabel,
  TEAM_SIZE_LABEL,
  TIMELINE_LABEL,
  type SalesLeadStatus
} from "@timesheet/shared";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Skeleton } from "../../components/ui/skeleton";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { Textarea } from "../../components/ui/textarea";
import { toast } from "../../components/ui/toaster";
import { cn } from "../../lib/utils";
import { platformAdminConsoleApi, type SalesLeadRow } from "../../services/platform-admin-api";
import { exportCsv, type CsvColumn } from "../../utils/console-csv";
import { ConsolePage, ConsoleSection, ConsoleTable, EmptyState, KpiCard, KpiGrid, SegmentedControl, Toolbar, shortDateTime } from "./console-ui";

/**
 * Where a lead is in the pipeline, in the console's usual lifecycle colours — applied to the STATUS
 * SELECT itself rather than to a badge beside it. A select and a badge saying the same word is one
 * of them for nothing, and the colour is the half that scans: with the filter on "All", the
 * untouched enquiries have to be findable without reading forty rows.
 */
const STATUS_TEXT: Record<SalesLeadStatus, string> = {
  NEW: "text-info",
  CONTACTED: "text-warning",
  QUALIFIED: "text-warning",
  WON: "text-success",
  LOST: "text-muted-foreground"
};

const STATUS_LABEL: Record<SalesLeadStatus, string> = {
  NEW: "New",
  CONTACTED: "Contacted",
  QUALIFIED: "Qualified",
  WON: "Won",
  LOST: "Lost"
};

/** `interests` is a Prisma JSON column, so it arrives as `unknown` and is narrowed once, here. */
function interestCodes(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * The export's columns.
 *
 * The MESSAGE is included, and it is the reason anybody exports this: a lead is picked up on the
 * strength of the paragraph somebody wrote, and a spreadsheet of names and statuses without it is a
 * contact list rather than a pipeline. `csvCell` quotes it whole, newlines and all.
 */
const LEAD_CSV_COLUMNS: Array<CsvColumn<SalesLeadRow>> = [
  { header: "Received", value: (lead) => lead.createdAt },
  { header: "Company", value: (lead) => lead.company },
  { header: "Name", value: (lead) => lead.name },
  { header: "Email", value: (lead) => lead.email },
  { header: "Role", value: (lead) => lead.role },
  { header: "Team size", value: (lead) => salesLabel(TEAM_SIZE_LABEL, lead.teamSize) },
  { header: "Deployment", value: (lead) => salesLabel(DEPLOYMENT_LABEL, lead.deploymentInterest) },
  { header: "Timeline", value: (lead) => salesLabel(TIMELINE_LABEL, lead.timeline) },
  { header: "Interests", value: (lead) => interestCodes(lead.interests).map((code) => salesLabel(INTEREST_LABEL, code)).join("; ") },
  { header: "Status", value: (lead) => lead.status },
  { header: "Owner", value: (lead) => lead.ownerLabel },
  { header: "Message", value: (lead) => lead.message },
  { header: "Notes", value: (lead) => lead.notes }
];

/**
 * One lead: the summary line and the detail line under it.
 *
 * The owner and notes fields hold their own draft state, which is why this is a component rather
 * than markup inside the map — a single form state keyed by lead id would re-render every row on
 * every keystroke, and the two fields would fight over a shared draft when two leads are being
 * edited at once.
 */
function LeadRow({ lead }: { lead: SalesLeadRow }) {
  const queryClient = useQueryClient();
  const [owner, setOwner] = useState(lead.ownerLabel ?? "");
  const [notes, setNotes] = useState(lead.notes ?? "");

  const save = useMutation({
    mutationFn: (patch: { status?: SalesLeadStatus; ownerLabel?: string | null; notes?: string | null }) =>
      platformAdminConsoleApi.updateSalesLead(lead.id, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["platform-admin", "sales-leads"] }),
    onError: (error) => toast.error("Could not save", { description: (error as { response?: { data?: { message?: string } } })?.response?.data?.message })
  });

  const dirty = (owner.trim() || "") !== (lead.ownerLabel ?? "") || (notes.trim() || "") !== (lead.notes ?? "");
  const codes = interestCodes(lead.interests);

  return (
    <>
      <TableRow className="border-t-2 border-t-border">
        <TableCell className="whitespace-nowrap align-top text-muted-foreground">{shortDateTime(lead.createdAt)}</TableCell>
        <TableCell className="align-top">
          <span className="block break-words font-semibold text-foreground">{lead.company}</span>
          <span className="block break-words text-xs text-muted-foreground">
            {lead.name}
            {lead.role ? ` · ${lead.role}` : ""}
          </span>
          {/* `mailto:` rather than a copy button: the next action after reading a lead is almost
              always to write to them, and the notification email already offers Reply. */}
          <a href={`mailto:${lead.email}`} className="focus-ring mt-0.5 inline-flex max-w-full items-center gap-1 break-all rounded text-xs font-medium text-accent hover:underline">
            <Mail className="h-3 w-3 shrink-0" />
            {lead.email}
          </a>
          {lead.isFreeMailDomain && (
            /* Stated, never acted on. It is context for whoever picks the lead up, not a verdict —
               see apps/api/src/utils/free-mail-domains.ts for why this surface accepts what signup
               refuses. */
            <span className="mt-1 block">
              <Badge variant="muted" title="A personal email domain. Accepted like any other — this is context, not a problem.">
                <AtSign className="mr-1 h-3 w-3" />
                personal address
              </Badge>
            </span>
          )}
        </TableCell>
        <TableCell className="align-top text-sm">
          <span className="block whitespace-nowrap text-foreground">{salesLabel(TEAM_SIZE_LABEL, lead.teamSize)}</span>
          <span className="block text-xs text-muted-foreground">{salesLabel(DEPLOYMENT_LABEL, lead.deploymentInterest)}</span>
          <span className="block text-xs text-muted-foreground">{salesLabel(TIMELINE_LABEL, lead.timeline)}</span>
        </TableCell>
        <TableCell className="align-top">
          <Select value={lead.status} onValueChange={(value) => save.mutate({ status: value as SalesLeadStatus })} disabled={save.isPending}>
            <SelectTrigger className={cn("h-8 w-[9.5rem] font-semibold", STATUS_TEXT[lead.status])}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SALES_LEAD_STATUSES.map((status) => (
                <SelectItem key={status} value={status}>
                  {STATUS_LABEL[status]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="mt-1 block text-xs text-muted-foreground">{lead.contactedAt ? `answered ${shortDateTime(lead.contactedAt)}` : "not answered yet"}</span>
        </TableCell>
      </TableRow>

      <TableRow className="hover:bg-transparent">
        {/* One cell across the whole table: the message needs the full width to be readable, and a
            column of its own would set the width of every row above it. */}
        <TableCell colSpan={4} className="pt-0">
          <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:gap-6">
            <div className="min-w-0">
              {/* `whitespace-pre-wrap` because a stranger's line breaks are part of what they said;
                  `break-words` because one unbroken URL must not push the table sideways. */}
              <p className="whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/30 p-3 text-sm text-foreground">{lead.message}</p>
              {codes.length > 0 && (
                <p className="mt-2 flex flex-wrap gap-1.5">
                  {codes.map((code) => (
                    <Badge key={code} variant="outline">
                      {salesLabel(INTEREST_LABEL, code)}
                    </Badge>
                  ))}
                </p>
              )}
              <p className="mt-2 break-words text-xs text-muted-foreground">
                {[lead.country, lead.phone, lead.sourcePage, lead.referrer, [lead.utmSource, lead.utmMedium, lead.utmCampaign].filter(Boolean).join(" / ")]
                  .map((part) => part?.trim())
                  .filter(Boolean)
                  .join(" · ") || "No context captured."}
              </p>
            </div>

            <div className="grid min-w-0 content-start gap-2">
              <Input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="Who is handling this?" aria-label={`Owner for ${lead.company}`} />
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                maxLength={8000}
                placeholder="Private notes — never shown to the customer."
                aria-label={`Notes for ${lead.company}`}
              />
              <Button
                variant="outline"
                size="sm"
                className="justify-self-start"
                disabled={!dirty || save.isPending}
                onClick={() => save.mutate({ ownerLabel: owner.trim() || null, notes: notes.trim() || null })}
              >
                {save.isPending ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        </TableCell>
      </TableRow>
    </>
  );
}

export function PlatformAdminSalesLeads() {
  const leads = useQuery({ queryKey: ["platform-admin", "sales-leads"], queryFn: platformAdminConsoleApi.salesLeads });
  const [filter, setFilter] = useState<SalesLeadStatus | "ALL">("ALL");
  const d = leads.data;
  const rows = d?.rows ?? [];
  const shown = filter === "ALL" ? rows : rows.filter((r) => r.status === filter);
  const open = d ? d.counts.NEW + d.counts.CONTACTED + d.counts.QUALIFIED : 0;

  return (
    <ConsolePage
      eyebrow="Growth"
      title="Sales leads"
      description="Every enquiry from the public contact form. Nothing here was sent by a workspace — these are people who do not have one yet."
    >
      {leads.isLoading && <Skeleton className="h-96 w-full" />}
      {d && (
        <>
          <KpiGrid>
            <KpiCard label="Leads" value={d.count} icon={Handshake} tone="accent" />
            <KpiCard label="Waiting on us" value={open} icon={Inbox} tone={d.counts.NEW > 0 ? "warning" : "default"} hint={`${d.counts.NEW} not answered yet`} delay={0.05} />
            <KpiCard label="Arrived this week" value={d.newThisWeek} icon={CalendarClock} delay={0.1} />
            <KpiCard label="Won" value={d.counts.WON} icon={Sparkles} tone="success" hint={d.count ? `${Math.round((d.counts.WON / d.count) * 100)}% of every enquiry` : undefined} delay={0.15} />
          </KpiGrid>

          <ConsoleSection
            title="Every enquiry"
            description="Newest first, verbatim. Status, owner and notes are ours to change; everything else is what the customer wrote."
            actions={
              <Toolbar>
                <SegmentedControl
                  ariaLabel="Filter by status"
                  value={filter}
                  onChange={setFilter}
                  options={[
                    { value: "ALL" as const, label: "All", count: d.count },
                    ...SALES_LEAD_STATUSES.map((status) => ({ value: status, label: STATUS_LABEL[status], count: d.counts[status] }))
                  ]}
                />
                {/* `shown`, not `rows`: the export carries the pipeline column the operator has
                    selected. Exporting every lead from behind a "Qualified" filter is how somebody
                    ends up mailing the ones marked Lost. */}
                <Button variant="outline" size="sm" className="gap-2" disabled={shown.length === 0} onClick={() => exportCsv("sales-leads", LEAD_CSV_COLUMNS, shown)}>
                  <Download className="h-4 w-4" />
                  Export CSV
                </Button>
              </Toolbar>
            }
            flush={shown.length > 0}
            bodyClassName={cn(shown.length === 0 && "grid gap-4")}
          >
            {shown.length === 0 ? (
              <EmptyState
                icon={Handshake}
                title={d.count === 0 ? "No enquiries yet" : `Nothing is ${STATUS_LABEL[filter as SalesLeadStatus]?.toLowerCase() ?? "here"}`}
                description={
                  d.count === 0
                    ? "The contact form is live at /contact. The first enquiry lands here, and a copy goes to the sales inbox set on Settings."
                    : "Every lead is in another column of the pipeline."
                }
              />
            ) : (
              <ConsoleTable minWidth={860} className="rounded-none border-x-0 border-b-0">
                <TableHeader>
                  <TableRow>
                    <TableHead className="whitespace-nowrap">Received</TableHead>
                    <TableHead>Who</TableHead>
                    <TableHead className="whitespace-nowrap">Asking for</TableHead>
                    <TableHead className="whitespace-nowrap">Pipeline</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.map((lead) => (
                    <LeadRow key={lead.id} lead={lead} />
                  ))}
                </TableBody>
              </ConsoleTable>
            )}
          </ConsoleSection>

          {d.freeMailCount > 0 && (
            /* Stated as a fact about the funnel, with the answer attached, because somebody
               eventually proposes blocking these and should see the number and the reasoning at the
               same time. */
            <p className="text-xs text-muted-foreground">
              {d.freeMailCount} of {d.count} enquiries came from a personal email domain. They are accepted like any other — a founder evaluating from a personal address is a real lead, and signing up for a
              workspace is where the work-email rule belongs.
            </p>
          )}
        </>
      )}
    </ConsolePage>
  );
}
