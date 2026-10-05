import { useEffect, useState } from "react";

import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";

/**
 * Asks why a ticket that was never resolved is being closed ("won't fix", duplicate, out of scope).
 *
 * ONE prompt for every surface that moves a ticket — the detail page, the status pill, the Kanban
 * drop — because the question is asked by the API client (`ticketApi.updateStatus`) when the server
 * answers CLOSE_REASON_REQUIRED, not by each caller. Mounted once in App.tsx. Cancelling leaves the
 * ticket exactly where it was.
 */

type Pending = { ticketLabel: string; resolve: (reason: string | null) => void };
let open: ((pending: Pending) => void) | null = null;

/** Resolves with the reason, or null when the person cancels. */
export function requestCloseReason(ticketLabel: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (!open) {
      resolve(null);
      return;
    }
    open({ ticketLabel, resolve });
  });
}

const MIN = 5;

export function CloseReasonPrompt() {
  const [pending, setPending] = useState<Pending | null>(null);
  const [reason, setReason] = useState("");

  useEffect(() => {
    open = (next) => {
      setReason("");
      setPending(next);
    };
    return () => {
      open = null;
    };
  }, []);

  const finish = (value: string | null) => {
    pending?.resolve(value);
    setPending(null);
  };
  const valid = reason.trim().length >= MIN;

  return (
    <Dialog open={pending !== null} onOpenChange={(isOpen) => !isOpen && finish(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Close {pending?.ticketLabel ?? "this ticket"} without a fix?</DialogTitle>
          <DialogDescription>
            It was never resolved, so say why it's closing. The reason is added as a comment, and an assigner or admin can
            reopen it later.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) finish(reason.trim());
          }}
        >
          <Label htmlFor="close-reason">Reason</Label>
          <Textarea
            id="close-reason"
            autoFocus
            rows={3}
            maxLength={1000}
            placeholder="Won't fix — works as designed. Or: duplicate of WEB-12."
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <DialogFooter className="mt-2">
            <Button type="button" variant="outline" onClick={() => finish(null)}>
              Keep it open
            </Button>
            <Button type="submit" disabled={!valid}>
              Close without a fix
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
