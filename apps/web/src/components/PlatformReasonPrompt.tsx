/**
 * "Why?" — asked once, at the moment an operator does something to a customer (5.0.0).
 *
 * WHERE IT COMES FROM. `services/platform-admin-api.ts` has an async request interceptor that
 * suspends any console request on the reason list (`services/platform-reason.ts`) until it has a
 * justification to put in the `X-Platform-Reason` header. This component is what that interceptor
 * suspends ON: it registers itself as the asker while it is mounted, and resolves the promise when
 * the operator types something or backs out.
 *
 * WHY A GLOBAL DIALOG RATHER THAN A FIELD ON EACH FORM. Fifteen destructive actions live on nine
 * different pages, several of them behind their own confirmation dialogs already. A reason field
 * added to each would be fifteen chances to forget one, and the sixteenth action somebody adds
 * would ship without it. One prompt, driven by the same list the server enforces, cannot be
 * forgotten — and it asks at the moment of the action, which is the only moment the answer is
 * actually known.
 *
 * BACKING OUT CANCELS THE REQUEST. That is the correct reading of "actually, never mind": the
 * action does not happen. It surfaces to the calling page's `onError` exactly like a refusal.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ShieldQuestion } from "lucide-react";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { PLATFORM_REASON_MIN, registerPlatformReasonAsker } from "../services/platform-reason";

export function PlatformReasonPrompt() {
  const [label, setLabel] = useState<string | null>(null);
  const [text, setText] = useState("");
  /** The interceptor's promise resolver. In a ref, not state: resolving it must not depend on a
   *  re-render having happened, and it is never rendered. */
  const resolver = useRef<((reason: string | null) => void) | null>(null);

  const settle = useCallback((reason: string | null) => {
    resolver.current?.(reason);
    resolver.current = null;
    setLabel(null);
    setText("");
  }, []);

  useEffect(() => {
    registerPlatformReasonAsker((nextLabel) => {
      // A second request arriving while one prompt is open cancels the first rather than stacking
      // dialogs. Two overlapping "why?" boxes is worse than one lost click.
      resolver.current?.(null);
      setLabel(nextLabel);
      setText("");
      return new Promise<string | null>((resolve) => {
        resolver.current = resolve;
      });
    });
    return () => {
      resolver.current?.(null);
      resolver.current = null;
      registerPlatformReasonAsker(null);
    };
  }, []);

  const tooShort = text.trim().length < PLATFORM_REASON_MIN;

  return (
    <Dialog open={label !== null} onOpenChange={(open) => !open && settle(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldQuestion className="h-4 w-4 text-accent" />
            Why?
          </DialogTitle>
          <DialogDescription>
            {label}. This goes into the control-plane audit trail beside your name and stays there — it is what somebody reviewing this in six months will read instead of guessing.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!tooShort) settle(text.trim());
          }}
        >
          <Input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Ticket 4192 — customer asked us to close the account." maxLength={500} />
          <p className="mt-1.5 text-xs text-muted-foreground">At least {PLATFORM_REASON_MIN} characters. A ticket number and a clause is plenty.</p>
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={() => settle(null)}>
              Cancel
            </Button>
            <Button type="submit" disabled={tooShort} className="bg-accent text-accent-foreground hover:bg-accent/90">
              Continue
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
