/**
 * The sign-in button — a fingerprint scanner that submits the form.
 *
 * WHAT CHANGED AND WHY. This started as a deliberately inert status light, on the reasoning that a
 * fingerprint which looks tappable but does nothing is worse than no fingerprint. That reasoning
 * still holds; what changed is that it is no longer inert. It is now `type="submit"` and it IS the
 * sign-in control, so pressing it does exactly what it appears to: signs you in with the
 * credentials in the form above it. Nothing here claims a biometric check, and the accessible name
 * is plainly "Sign in".
 *
 * WHAT WOULD MAKE IT AN ACTUAL BIOMETRIC BUTTON is WebAuthn — `navigator.credentials`, which
 * appears nowhere in this repo. When that lands, this component is where the affordance belongs:
 * the scan states below are already the right ones, and the only change is what `onClick` starts.
 *
 * THE FOUR STATES are the real state of the request in flight, not decoration on a timer:
 *   idle      — a resting ring; the sweep only appears under the pointer
 *   scanning  — ridges lit, a bar travelling down them, a quarter-arc rotating
 *   success   — ridges and ring turn success-coloured, a check badge lands
 *   error     — destructive colour, a short shake, an X badge
 *
 * Every one of them is legible with animation switched off, because colour and the badge carry the
 * meaning and motion is only the enhancement — `prefers-reduced-motion` disables all three
 * keyframes in index.css and nothing about the state becomes ambiguous.
 */
import { Check, Fingerprint, X } from "lucide-react";
import { cn } from "../../lib/utils";

export type SealState = "idle" | "scanning" | "success" | "error";

/** What a screen reader is told BEYOND the button's own label — the visual states are colour and a
 *  badge, neither of which is announced, so each needs its own sentence. */
const STATUS_TEXT: Record<SealState, string> = {
  idle: "",
  scanning: "Checking your credentials",
  success: "Signed in",
  error: "Sign-in failed"
};

const RING: Record<SealState, string> = {
  idle: "border-primary-foreground/30",
  scanning: "border-primary-foreground/60",
  success: "border-success",
  error: "border-destructive-foreground/70"
};

const GLYPH: Record<SealState, string> = {
  idle: "text-primary-foreground/80",
  scanning: "text-primary-foreground",
  success: "text-success",
  error: "text-primary-foreground"
};

export function FingerprintSignIn({
  state,
  disabled,
  label = "Sign in",
  className
}: {
  state: SealState;
  disabled?: boolean;
  label?: string;
  className?: string;
}) {
  const busy = state === "scanning";

  return (
    <button
      type="submit"
      disabled={disabled || busy}
      aria-busy={busy}
      /* EXPLICIT, because the accessible name is otherwise computed from this button's text — which
         includes the status line below it, so the control announced itself as "Sign in Sign-in
         failed Sign-in failed": the status once from the visible line, once from the live region.
         Naming the button pins it to "Sign in" and leaves the live region to announce the change,
         which is the division those two things are for. */
      aria-label={label}
      className={cn(
        // `group` so the scanner reacts to a hover anywhere on the button, not only on the disc.
        "group relative isolate flex h-14 w-full items-center gap-4 overflow-hidden rounded-xl px-4",
        "bg-primary text-primary-foreground shadow-lg transition-all duration-200",
        "hover:shadow-glow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        "disabled:cursor-not-allowed disabled:opacity-70 motion-reduce:transition-none",
        state === "error" && "seal-shake",
        className
      )}
    >
      {/* A single specular pass on hover, borrowed from `.ai-specular`'s reasoning: a control that
          shimmers permanently is the kind of motion people disable site-wide to escape, so this one
          only crosses when somebody is actually pointing at it. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/20 to-transparent transition-transform duration-700 ease-out group-hover:translate-x-full motion-reduce:hidden"
      />

      <span className="relative grid h-10 w-10 shrink-0 place-items-center">
        {/* The rotating quarter-arc. One quarter drawn, so the rotation reads without the ring
            pretending to be a progress meter — nothing here knows a percentage. */}
        {busy && (
          <svg className="seal-ring absolute inset-0 h-full w-full text-primary-foreground" viewBox="0 0 40 40" aria-hidden focusable="false">
            <circle cx="20" cy="20" r="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray="28 85" opacity="0.9" />
          </svg>
        )}

        <span
          className={cn(
            "relative grid h-full w-full place-items-center overflow-hidden rounded-full border-2 transition-colors duration-300",
            "bg-primary-foreground/10",
            RING[state]
          )}
        >
          <Fingerprint className={cn("h-5 w-5 transition-colors duration-300", GLYPH[state])} aria-hidden />

          {/* The scan bar. `overflow-hidden` on the disc is what makes this a scanner rather than a
              stripe crossing the button. */}
          {busy && (
            <span
              aria-hidden
              className="seal-sweep pointer-events-none absolute inset-x-0 h-3 bg-gradient-to-b from-transparent via-primary-foreground/80 to-transparent"
            />
          )}
        </span>

        {(state === "success" || state === "error") && (
          <span
            aria-hidden
            className={cn(
              "absolute -bottom-0.5 -right-0.5 grid h-4 w-4 place-items-center rounded-full text-white ring-2 ring-primary motion-safe:animate-in motion-safe:zoom-in motion-safe:duration-200",
              state === "success" ? "bg-success" : "bg-destructive"
            )}
          >
            {state === "success" ? <Check className="h-2.5 w-2.5" strokeWidth={3} /> : <X className="h-2.5 w-2.5" strokeWidth={3} />}
          </span>
        )}
      </span>

      <span className="flex min-w-0 flex-1 flex-col items-start text-left">
        <span className="text-base font-semibold leading-tight">{busy ? "Signing in…" : label}</span>
        {/* The second line carries the state so it is readable without decoding a colour, and holds
            a non-breaking space when idle so the label never shifts vertically between states. */}
        {/* `aria-hidden` because the live region below is what gets announced — without it a
            screen reader hears the same sentence twice. */}
        <span aria-hidden className="text-xs font-medium leading-tight text-primary-foreground/70">
          {STATUS_TEXT[state] || " "}
        </span>
      </span>

      {/* Announced on change rather than only when focus lands here — which for a submit button is
          exactly the moment it is pressed, and never again while the request runs. */}
      <span aria-live="polite" className="sr-only">
        {STATUS_TEXT[state]}
      </span>
    </button>
  );
}
