/**
 * WHAT: a ticket's status pill that IS the status control — click it in the list and pick the next
 * status without opening the ticket.
 *
 * WHY THE CLIENT HOLDS NO TRANSITION RULE: which moves are legal, whether a CI quality gate blocks
 * a resolve, and whether identity verification is required are all decided by the server on
 * `PATCH /tickets/:id/status`, exactly as when the same change is made from the ticket sheet. The
 * pill offers every other status and lets the server answer; a refusal shows the server's own
 * message and points at the sheet, where the full flow (verification camera, gate details) lives.
 * A second copy of the rule here is how the list and the sheet would come to disagree.
 *
 * WHY IT HANDS OFF WHEN VERIFICATION IS REQUIRED: the sheet parks the chosen status while the
 * camera check runs; that UI is not duplicated here. If the workspace requires verification for
 * ticket transitions, the pill's menu says so and opens the ticket instead.
 *
 * ONE COLOUR SOURCE: the pill and every dot in its menu draw from `STATUS_VARIANT` in
 * lib/ticket-visuals.ts — the same map the badges, the metric tiles and the group headings use.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { ticketStatuses, type TicketStatus } from "@timesheet/shared";
import { STATUS_VARIANT, TONE_ACCENT_CLASS } from "../lib/ticket-visuals";
import { useFaceStatus } from "../lib/use-face-status";
import { cn } from "../lib/utils";
import { ticketApi } from "../services/api";
import { Badge } from "./ui/badge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { toast } from "./ui/toaster";
import { runInBackground } from "../lib/run-in-background";

const label = (s: TicketStatus) => s.replace(/_/g, " ");

export function StatusPill({ ticketId, status, onOpenTicket, className }: Readonly<{ ticketId: string; status: TicketStatus; onOpenTicket: (id: string) => void; className?: string }>) {
  const queryClient = useQueryClient();
  const faceStatus = useFaceStatus();
  const requiresVerification = Boolean(faceStatus.data?.requiredForTicket);
  const change = useMutation({
    mutationFn: (next: TicketStatus) => ticketApi.updateStatus(ticketId, next),
    onSuccess: () => {
      toast.success("Status updated");
      runInBackground(queryClient.invalidateQueries({ queryKey: ["tickets"] }));
      runInBackground(queryClient.invalidateQueries({ queryKey: ["ticket", ticketId] }));
    },
    onError: (err: any) =>
      toast.error("Could not change the status", {
        description: `${err?.response?.data?.message ?? "The server refused the move."} Open the ticket for the full flow.`
      })
  });

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          // The row itself opens the ticket; the pill must not.
          onClick={(e) => e.stopPropagation()}
          aria-label={`Status: ${label(status)}. Change status`}
          disabled={change.isPending}
          className={cn("focus-ring inline-flex min-h-[44px] items-center rounded-md", className)}
          data-status-pill
        >
          <Badge variant={STATUS_VARIANT[status]} className="gap-1 pr-1.5">
            {label(status)}
            <ChevronDown className="h-3 w-3 opacity-70" aria-hidden="true" />
          </Badge>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" onClick={(e) => e.stopPropagation()}>
        {requiresVerification ? (
          <DropdownMenuItem onSelect={() => onOpenTicket(ticketId)} className="min-h-[44px]">
            This workspace verifies identity on status changes — open the ticket to continue
          </DropdownMenuItem>
        ) : (
          ticketStatuses
            .filter((s) => s !== status)
            .map((s) => (
              <DropdownMenuItem key={s} onSelect={() => change.mutate(s)} className="min-h-[44px] gap-2">
                <span aria-hidden className={cn("h-2.5 w-2.5 rounded-full", TONE_ACCENT_CLASS[STATUS_VARIANT[s] ?? "muted"])} />
                {label(s)}
              </DropdownMenuItem>
            ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
