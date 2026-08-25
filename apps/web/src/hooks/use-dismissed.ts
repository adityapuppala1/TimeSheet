import { useCallback, useEffect, useState } from "react";

/**
 * WHAT: remembers that someone closed a notice, and brings it back when the thing it was about
 * changes.
 *
 * WHY A SIGNATURE RATHER THAN A PLAIN BOOLEAN: "dismissed" is almost never permanent, and the two
 * obvious implementations are both wrong in a way people notice.
 *
 *   * Hide until remount — the banner is back on the next navigation, so the close button did
 *     nothing and the user learns to ignore it.
 *   * Hide forever, keyed on the banner's name — the escalation notice a person cleared on Tuesday
 *     stays hidden on Friday when they have missed a DIFFERENT day, so the app silently stops
 *     telling them something they need to know. That is the dangerous one: a dismissal is consent
 *     to hide *this* message, never consent to hide *this kind of* message.
 *
 * So the caller passes a signature describing the current situation — a date, a count, a set of
 * ids — and the dismissal only holds while the signature is unchanged. Miss a different day, or
 * pick up a new ticket, and the notice returns on its own.
 *
 * Storage is `localStorage`, per browser. That is the right scope: closing a banner is a reading
 * preference, not account state, and syncing it to the server would mean a write on every close
 * plus a decision about what it means on another device.
 *
 * WHO calls this: pages/Dashboard.tsx's two home-page banners today; anything else that wants a
 * closable notice.
 */

const PREFIX = "timesphere.dismissed.";

/** Every storage read and write is guarded: Safari private mode throws on `localStorage` access,
 *  and a banner is never worth taking a page down for. */
function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(PREFIX + key);
    else window.localStorage.setItem(PREFIX + key, value);
  } catch {
    /* storage unavailable — the dismissal lasts the session instead, which is still better than
       the button appearing not to work */
  }
}

export interface Dismissible {
  /** True when the current signature has been dismissed and the notice should not render. */
  dismissed: boolean;
  /** Records the dismissal for the current signature. */
  dismiss: () => void;
}

/**
 * @param key       stable identifier for this notice, e.g. `"daily-status"`.
 * @param signature what the notice is currently about. Change it and the dismissal lapses.
 *                  Pass `null` to disable persistence (the notice can still be closed for the
 *                  session), which is what you want while the data is still loading.
 */
export function useDismissed(key: string, signature: string | null): Dismissible {
  const [dismissedSignature, setDismissedSignature] = useState<string | null>(() => readStored(key));

  // Re-read when the key changes so two notices sharing this hook cannot inherit each other's
  // state. Deliberately NOT re-reading on every signature change: the stored value is compared
  // below rather than reloaded, so a dismissal made in another tab is picked up on the next mount
  // instead of racing this one mid-render.
  useEffect(() => {
    setDismissedSignature(readStored(key));
  }, [key]);

  const dismiss = useCallback(() => {
    if (signature === null) {
      // Nothing meaningful to remember yet — hide for this session only.
      setDismissedSignature("");
      return;
    }
    writeStored(key, signature);
    setDismissedSignature(signature);
  }, [key, signature]);

  return {
    dismissed: signature !== null && dismissedSignature === signature,
    dismiss
  };
}

/** `YYYY-MM-DD` in the viewer's own timezone — the usual "and it comes back tomorrow" ingredient. */
export function todaySignature(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
