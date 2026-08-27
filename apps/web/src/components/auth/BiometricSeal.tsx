/**
 * The fingerprint seal on the sign-in page.
 *
 * READ THIS BEFORE MAKING IT CLICKABLE. This product has no WebAuthn, no passkeys, and no platform
 * authenticator anywhere in the API — a repo-wide search for `navigator.credentials` returns
 * nothing. So this is a STATUS INDICATOR for the sign-in attempt already in flight, and it is
 * deliberately built so it cannot be mistaken for a way to start one: `role="img"`, no tab stop, no
 * hover state, no cursor change. A fingerprint that looks tappable and does nothing is a worse
 * login page than one with no fingerprint at all.
 *
 * If passkeys are ever added, this component is the right place for the affordance — but it has to
 * become a real `<button>` at the same moment the backend can answer it, not before.
 *
 * FOUR STATES, and each is legible without motion, because `prefers-reduced-motion` turns every
 * animation here off: colour changes with the state, and success/failure each add a badge. Motion
 * is the enhancement, not the message.
 */
import { Check, Fingerprint, X } from "lucide-react";

export type SealState = "idle" | "scanning" | "success" | "error";

const RING: Record<SealState, string> = {
  idle: "border-border",
  scanning: "border-primary/30",
  success: "border-success/50",
  error: "border-destructive/50"
};

const GLYPH: Record<SealState, string> = {
  idle: "text-muted-foreground/70",
  scanning: "text-primary",
  success: "text-success",
  error: "text-destructive"
};

/** What a screen reader is told. The visual states are colour and a badge, neither of which is
 *  announced, so each one needs its own sentence. */
const LABEL: Record<SealState, string> = {
  idle: "Sign-in status: waiting",
  scanning: "Checking your credentials",
  success: "Signed in",
  error: "Sign-in failed"
};

export function BiometricSeal({ state, className = "" }: { state: SealState; className?: string }) {
  return (
    <div
      role="img"
      aria-label={LABEL[state]}
      /* aria-live so the announcement fires on the CHANGE, not only when focus happens to land
         here — which it never does, because this is not focusable. */
      aria-live="polite"
      className={`relative grid h-14 w-14 shrink-0 place-items-center ${state === "error" ? "seal-shake" : ""} ${className}`}
    >
      {/* The rotating arc. One quarter of the circle is drawn, so rotation is visible without the
          ring reading as a full-blown progress spinner — nothing here knows a percentage. */}
      {state === "scanning" && (
        <svg className="seal-ring absolute inset-0 h-full w-full text-primary" viewBox="0 0 56 56" aria-hidden focusable="false">
          <circle
            cx="28"
            cy="28"
            r="26"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray="41 122"
            opacity="0.9"
          />
        </svg>
      )}

      <div
        className={`relative grid h-full w-full place-items-center overflow-hidden rounded-full border-2 bg-card transition-colors duration-300 ${RING[state]}`}
      >
        <Fingerprint className={`h-7 w-7 transition-colors duration-300 ${GLYPH[state]}`} aria-hidden />

        {/* The scan bar. `overflow-hidden` on the parent is what makes it a scanner rather than a
            stripe crossing the page. */}
        {state === "scanning" && (
          <span
            className="seal-sweep pointer-events-none absolute inset-x-0 h-4 bg-gradient-to-b from-transparent via-primary/70 to-transparent"
            aria-hidden
          />
        )}
      </div>

      {(state === "success" || state === "error") && (
        <span
          aria-hidden
          className={`absolute -bottom-0.5 -right-0.5 grid h-5 w-5 place-items-center rounded-full text-white ring-2 ring-card motion-safe:animate-in motion-safe:zoom-in motion-safe:duration-200 ${
            state === "success" ? "bg-success" : "bg-destructive"
          }`}
        >
          {state === "success" ? <Check className="h-3 w-3" strokeWidth={3} /> : <X className="h-3 w-3" strokeWidth={3} />}
        </span>
      )}
    </div>
  );
}
