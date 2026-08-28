/**
 * The sign-in control — a fingerprint sensor, centred, the way a phone's unlock screen presents
 * one. Not a bar with a glyph stuck on the left.
 *
 * IT IS STILL A REAL `type="submit"`. That is the part that must not be traded away for the look:
 * pressing it signs you in with the credentials above, Enter in either field submits, and its
 * accessible name is exactly "Sign in" — sixteen e2e specs locate it with
 * `{ name: "Sign in", exact: true }`, and a decorative div with a click handler would break all of
 * them and every keyboard user at the same time. The chrome is gone; the semantics are not.
 *
 * WHAT IT IS NOT. There is no fingerprint reader behind it — `navigator.credentials` appears
 * nowhere in this repo — so nothing here says "scan your finger". The caption underneath reads
 * "Sign in", then reports the state of the request that was actually started. When WebAuthn lands,
 * this component is where the affordance belongs and the states below are already the right four.
 *
 * ON THE IDLE PULSE, given the lesson written into index.css about always-running animations: this
 * one is a `transform` and an `opacity` on a single element, which the compositor handles without
 * touching style or layout. The effect that cost this app three times its scroll budget animated
 * `background-position` under `background-clip: text` — not compositable, and re-rasterising a
 * text-shaped clip every frame. Different mechanism, different cost. It also only runs on hover or
 * while a request is in flight, never as ambient decoration.
 */
import { Check, Fingerprint, X } from "lucide-react";
import { cn } from "../../lib/utils";

export type SealState = "idle" | "scanning" | "success" | "error";

/**
 * The caption under the sensor. Doubles as the live-region announcement, so it has to read as a
 * sentence on its own rather than as a label fragment.
 *
 * THE ERROR CASE DELIBERATELY DOES NOT SAY "SIGN-IN FAILED", and it is worth saying why so nobody
 * makes it more explicit later. A failed attempt already produces two messages: a toast titled
 * "Sign-in failed", and an inline `role="alert"` panel carrying the API's actual reason ("Invalid
 * email or password"). A third copy of the same sentence directly beneath them is noise to a
 * reader and a strict-mode violation to `getByText(/sign-in failed/i)` in auth.spec.ts — which is
 * exactly how this was caught, by CI going red on a release.
 *
 * So the caption does the job the other two cannot: it labels the SENSOR's state, and says what to
 * do next. The reason lives in the panel; this is the prompt.
 */
const CAPTION: Record<Exclude<SealState, "idle">, string> = {
  scanning: "Checking your credentials…",
  success: "Signed in",
  error: "Try again"
};

/**
 * The sensor's resting/working colour. The workspace app signs in with `primary` (teal); the
 * platform-admin console signs in with `accent` (amber) — the one colour that tells an operator at
 * a glance which of the two consoles they are looking at, and the reason its sign-in page must not
 * simply be the tenant one re-skinned by accident.
 *
 * Only the IDLE and SCANNING states differ. Success is green and failure is red in both, because
 * those are outcome semantics, not brand.
 */
export type SealTone = "primary" | "accent";

const DISC: Record<SealTone, Record<SealState, string>> = {
  primary: {
    idle: "border-primary/30 bg-primary/5 text-primary group-hover:border-primary/60 group-hover:bg-primary/10",
    scanning: "border-primary bg-primary/15 text-primary",
    success: "border-success bg-success/15 text-success",
    error: "border-destructive bg-destructive/10 text-destructive"
  },
  accent: {
    idle: "border-accent/40 bg-accent/5 text-accent group-hover:border-accent/70 group-hover:bg-accent/10",
    scanning: "border-accent bg-accent/15 text-accent",
    success: "border-success bg-success/15 text-success",
    error: "border-destructive bg-destructive/10 text-destructive"
  }
};

const CAPTION_TONE: Record<SealTone, Record<SealState, string>> = {
  primary: { idle: "text-foreground", scanning: "text-primary", success: "text-success", error: "text-destructive" },
  accent: { idle: "text-foreground", scanning: "text-accent", success: "text-success", error: "text-destructive" }
};

/** The pulse rings and the scan line, which are the same hue as the disc at rest. */
const RING: Record<SealTone, { busy: string; hover: string; sweep: string; arc: string }> = {
  primary: { busy: "border-primary/40", hover: "border-primary/20", sweep: "via-primary/60", arc: "text-primary" },
  accent: { busy: "border-accent/40", hover: "border-accent/20", sweep: "via-accent/60", arc: "text-accent" }
};

export function FingerprintSignIn({
  state,
  disabled,
  label = "Sign in",
  tone = "primary",
  className
}: {
  state: SealState;
  disabled?: boolean;
  /** The control's accessible name AND its resting caption. The directory form passes "Sign in with
   *  LDAP", which is the name tests/e2e/helpers/sign-in.ts already warns is matched by a loose
   *  `/sign in/i` — so the two sensors stay tellable apart by an exact-name locator. */
  label?: string;
  /** `accent` for the platform-admin console — see SealTone. */
  tone?: SealTone;
  className?: string;
}) {
  const busy = state === "scanning";
  const settled = state === "success" || state === "error";

  return (
    <div className={cn("flex flex-col items-center gap-3 py-2", className)}>
      <button
        type="submit"
        disabled={disabled || busy}
        aria-busy={busy}
        /* EXPLICIT. Without it the accessible name is computed from the caption below, so the
           control would rename itself mid-request — "Checking your credentials…" is a status, not
           a thing you press. */
        aria-label={label}
        className={cn(
          "group relative grid h-24 w-24 shrink-0 place-items-center rounded-full",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background",
          "disabled:cursor-not-allowed",
          state === "error" && "seal-shake"
        )}
      >
        {/* Two rings breathing out of the sensor, offset in time. At rest they are invisible and
            wake on hover; while a request is in flight they run at full strength, which is what
            makes "it is doing something" readable from the corner of an eye. */}
        {[0, 1].map((i) => (
          <span
            key={i}
            aria-hidden
            style={{ animationDelay: `${i * 700}ms` }}
            className={cn(
              "absolute inset-0 rounded-full border motion-reduce:hidden",
              busy ? `animate-ping ${RING[tone].busy}` : `${RING[tone].hover} opacity-0 group-hover:animate-ping`,
              settled && "hidden"
            )}
          />
        ))}

        {/* The rotating arc. A quarter drawn, so it reads as motion rather than as a progress meter —
            nothing here knows a percentage. */}
        {busy && (
          <svg className={cn("seal-ring absolute inset-0 h-full w-full", RING[tone].arc)} viewBox="0 0 96 96" aria-hidden focusable="false">
            <circle cx="48" cy="48" r="45" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="70 213" />
          </svg>
        )}

        {/* The sensor face. `overflow-hidden` is what turns the bar below into a scan line instead
            of a stripe crossing the page. */}
        <span
          className={cn(
            "relative grid h-full w-full place-items-center overflow-hidden rounded-full border-2 transition-colors duration-300",
            DISC[tone][state]
          )}
        >
          <Fingerprint
            className="h-11 w-11 transition-transform duration-300 group-active:scale-95 motion-reduce:transition-none"
            aria-hidden
            strokeWidth={1.25}
          />

          {busy && (
            <span
              aria-hidden
              className={cn("seal-sweep pointer-events-none absolute inset-x-0 h-6 bg-gradient-to-b from-transparent to-transparent", RING[tone].sweep)}
            />
          )}
        </span>

        {settled && (
          <span
            aria-hidden
            className={cn(
              "absolute bottom-0 right-0 grid h-7 w-7 place-items-center rounded-full text-white ring-4 ring-background motion-safe:animate-in motion-safe:zoom-in motion-safe:duration-200",
              state === "success" ? "bg-success" : "bg-destructive"
            )}
          >
            {state === "success" ? <Check className="h-4 w-4" strokeWidth={3} /> : <X className="h-4 w-4" strokeWidth={3} />}
          </span>
        )}
      </button>

      {/* The caption is OUTSIDE the button on purpose — inside, it would be part of the control's
          name and would be read out twice, once as the name and once as the status. Out here it is
          a plain live region that changes underneath a button whose name never does. */}
      <span aria-live="polite" className={cn("text-sm font-semibold transition-colors duration-300", CAPTION_TONE[tone][state])}>
        {state === "idle" ? label : CAPTION[state]}
      </span>
    </div>
  );
}
