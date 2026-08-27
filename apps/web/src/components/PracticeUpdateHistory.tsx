/**
 * The archive of practice updates that were actually sent, and a preview of each one.
 *
 * WHAT MAKES IT AN ARCHIVE RATHER THAN A LIST. Each row renders the HTML that was STORED at send
 * time, not a fresh render of the stored figures. Those look identical today and diverge the moment
 * the email template is improved — at which point a re-rendering "archive" would quietly restate
 * history in the new format, and a reader would have no way to know what a named list of people
 * actually received on a given Monday. The recipient list is captured the same way, so editing the
 * distribution list later cannot rewrite who a past update says it reached.
 *
 * WHY A SANDBOXED IFRAME AND NOT `dangerouslySetInnerHTML`. This is a whole email document — its
 * own `<table>` layout, its own inline styles, its own colours — and dropping it into the page
 * would let it inherit and fight the app's stylesheet in both directions. An iframe with `srcDoc`
 * renders it exactly as a mail client would, and `sandbox` with no `allow-scripts` means nothing in
 * it can execute even though the body contains prose a person typed. The sanitiser in
 * `lib/safe-html.ts` is for rich text going INTO the page; a full document belongs in a frame.
 */
import { useQuery } from "@tanstack/react-query";
import { Archive, Calendar, ExternalLink, Mail, Users } from "lucide-react";
import { useState } from "react";
import { Badge } from "./ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Skeleton } from "./ui/skeleton";
import { practiceUpdateApi } from "../services/api";

function PreviewDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const detail = useQuery({
    queryKey: ["practice-update", "history", id],
    queryFn: () => practiceUpdateApi.historyItem(id!),
    enabled: Boolean(id)
  });

  if (!id) return null;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[88vh] gap-3 sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="text-base">{detail.data?.subject ?? "Practice update"}</DialogTitle>
          <DialogDescription>
            {detail.data?.sentAt ? `Sent ${new Date(detail.data.sentAt).toLocaleString()}` : "Sent"}
            {detail.data?.sentByName ? ` by ${detail.data.sentByName}` : ""} — exactly as it was received.
          </DialogDescription>
        </DialogHeader>

        {detail.isLoading && <Skeleton className="h-80 w-full" />}

        {detail.data && (
          <>
            {detail.data.recipients.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <Users className="h-3.5 w-3.5" />
                {detail.data.recipients.map((address) => (
                  <span key={address} className="rounded-full bg-muted px-2 py-0.5">
                    {address}
                  </span>
                ))}
              </div>
            )}

            {/* `sandbox` with no allow-scripts: the body carries prose somebody typed, and this is a
                whole document rather than a fragment. Nothing in it can run. */}
            <iframe
              title={detail.data.subject ?? "Practice update preview"}
              sandbox=""
              srcDoc={detail.data.html ?? "<p>This update has no stored body.</p>"}
              className="h-[58vh] w-full rounded-lg border border-border bg-white"
            />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function PracticeUpdateHistory() {
  const [previewing, setPreviewing] = useState<string | null>(null);
  const history = useQuery({ queryKey: ["practice-update", "history"], queryFn: practiceUpdateApi.history });
  const records = history.data?.records ?? [];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Archive className="h-4 w-4 text-primary" />
          Previously sent
        </CardTitle>
        <CardDescription>
          Every update that went out, with the figures it carried and the exact email each recipient received.
        </CardDescription>
      </CardHeader>

      <CardContent className="grid gap-2">
        {history.isLoading && <Skeleton className="h-24 w-full" />}

        {!history.isLoading && records.length === 0 && (
          <p className="rounded-lg border border-dashed border-border p-5 text-center text-sm text-muted-foreground">
            Nothing sent yet. Once an update is mailed it is archived here — the figures, the recipients, and the email
            itself.
          </p>
        )}

        {records.map((row) => (
          <button
            key={row.id}
            type="button"
            onClick={() => setPreviewing(row.id)}
            className="focus-ring grid gap-2 rounded-lg border border-border bg-card p-3.5 text-left transition hover:border-primary/40 hover:shadow-sm"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="inline-flex items-center gap-2 text-sm font-semibold">
                <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
                {row.periodLabel}
              </span>
              <span className="inline-flex items-center gap-3 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <Users className="h-3.5 w-3.5" />
                  {row.recipientCount}
                </span>
                {row.sentAt && <span>{new Date(row.sentAt).toLocaleDateString()}</span>}
                <ExternalLink className="h-3.5 w-3.5" />
              </span>
            </div>

            {/* The counted half, so a row is worth reading without opening it — which is the only
                reason to list an archive rather than just link to it. */}
            {row.metrics && (
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="muted">{row.metrics.ticketsClosed} closed</Badge>
                <Badge variant="muted">{row.metrics.hours}h logged</Badge>
                {row.metrics.overdue > 0 && <Badge variant="warning">{row.metrics.overdue} overdue</Badge>}
                {row.metrics.slaBreaches > 0 && <Badge variant="destructive">{row.metrics.slaBreaches} SLA</Badge>}
                <Badge variant="muted">{row.initiativeCount} initiatives</Badge>
              </div>
            )}

            {row.subject && (
              <span className="inline-flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                <Mail className="h-3.5 w-3.5 shrink-0" />
                {row.subject}
              </span>
            )}
          </button>
        ))}
      </CardContent>

      <PreviewDialog id={previewing} onClose={() => setPreviewing(null)} />
    </Card>
  );
}
