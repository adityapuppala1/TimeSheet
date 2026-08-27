/**
 * The visual half of the split sign-in screen.
 *
 * WHY IT IS THREE.JS NOW, AFTER THIS FILE ARGUED AT LENGTH THAT IT SHOULD NOT BE. The previous
 * version was a hand-rolled 2D canvas, and its header made the case that three.js is ~600KB for
 * what is decoratively a moving gradient behind some dots. That reasoning was about the DEFAULT
 * path and it was right — so three.js is no longer on the default path. `AuthScene` imports it
 * dynamically, inside an effect, only after a desktop-width and no-reduced-motion check both pass.
 * A phone never downloads it. A reduced-motion visitor never downloads it. The form paints from the
 * ordinary bundle and is typeable before any of it exists. The library was asked for explicitly;
 * what was actually objectionable was making everyone pay for it, and that part is fixed rather
 * than argued with.
 *
 * WHY THE GROUND WENT DARK. It was `from-primary via-info to-accent` — a bright three-stop
 * gradient, which is the right call behind flat 2D dots and the wrong one behind a lit 3D object:
 * a light ground flattens depth, and the accent stop put amber directly behind white text. A deep
 * near-black with a single brand glow is what lets the lattice read as having volume, and it is the
 * treatment this class of screen has settled on for exactly that reason.
 *
 * THE PANEL IS `hidden lg:block`, AND THAT IS A CSS FACT, NOT A MOUNTING ONE. React renders this
 * regardless of the class, which is why `AuthScene` watches `matchMedia` itself rather than trusting
 * the breakpoint — the bug that shipped in the 2D version ran a full animation loop against a 0×0
 * canvas on every phone while three comments claimed it cost a phone nothing.
 */
import { CheckCircle2, ScanFace, ShieldCheck, Sparkles } from "lucide-react";
import { AuthScene } from "./AuthScene";

const PROOF = [
  { icon: ShieldCheck, text: "Rotating sessions, per-device revocation, AES-256 secrets at rest" },
  { icon: Sparkles, text: "AI stays off until you switch it on — with your key, under your budget" },
  { icon: ScanFace, text: "Optional identity checks that never send a face off your server" }
];

export function AuthBrandPanel() {
  return (
    // Hidden below lg: on a phone the form should own the whole screen.
    <aside className="relative hidden overflow-hidden bg-slate-950 lg:block">
      {/* Two soft brand glows behind the lattice. These are the FLOOR, not decoration — they are
          what a visitor sees when three.js does not load: no WebGL, a blocked context, a phone that
          grew into a desktop mid-session. The panel reads as a designed dark gradient either way,
          never as a black rectangle where something failed. */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute -left-24 top-1/4 h-[32rem] w-[32rem] rounded-full bg-primary/25 blur-[100px]" />
        <div className="absolute -right-20 bottom-0 h-[28rem] w-[28rem] rounded-full bg-info/20 blur-[100px]" />
      </div>

      <AuthScene className="absolute inset-0" />

      {/* Bottom-weighted scrim. A flat wash over the whole panel would mute the lattice everywhere;
          this only darkens where the copy actually sits. */}
      <div aria-hidden className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/40 to-slate-950/10" />

      <div className="relative flex h-full flex-col justify-between p-10 text-white xl:p-14">
        <div className="flex items-center gap-3 font-bold">
          <span className="grid h-10 w-10 place-items-center rounded-xl border border-white/15 bg-white/10 backdrop-blur">T</span>
          <div className="leading-tight">
            <p>TimeSphere</p>
            <p className="text-xs font-medium text-white/60">Enterprise timesheets &amp; ticketing</p>
          </div>
        </div>

        <div className="max-w-md">
          <h2 className="text-3xl font-black leading-[1.1] tracking-tight xl:text-[2.6rem]">
            The hours, the tickets, and the proof —{" "}
            {/* The same two-stop ramp the landing page's headline uses. Never through `accent`: a
                wrapped line ending in amber reads as a warning state rather than as emphasis. */}
            <span className="bg-gradient-to-r from-primary to-info bg-clip-text text-transparent">in one place.</span>
          </h2>
          <p className="mt-5 text-sm leading-7 text-white/70">
            Log time against real work, let SLAs escalate themselves, and hand a client a signed record of what was
            actually delivered.
          </p>

          <ul className="mt-8 grid gap-2.5">
            {PROOF.map((item) => (
              <li
                key={item.text}
                className="flex items-start gap-3 rounded-xl border border-white/10 bg-white/[0.04] p-3 text-sm text-white/80 backdrop-blur-sm"
              >
                <item.icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <span className="leading-6">{item.text}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-white/60">
          <span className="inline-flex items-center gap-1.5">
            <CheckCircle2 className="h-3.5 w-3.5 text-primary" />A database per organization
          </span>
          <span className="inline-flex items-center gap-1.5">
            <CheckCircle2 className="h-3.5 w-3.5 text-primary" />Tamper-evident audit log
          </span>
        </div>
      </div>
    </aside>
  );
}
