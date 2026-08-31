/**
 * WHAT: the sign-in page for the `/platform-admin` console.
 *
 * WHY IT IS THE SAME SHAPE AS THE WORKSPACE SIGN-IN, AND WHY IT IS STILL NOT THE SAME PAGE.
 * A person who signs into both should meet one product, not two — so this page now uses exactly the
 * pieces `pages/Login.tsx` uses: the split brand panel with the three.js lattice (`AuthScene`), and
 * the fingerprint sensor as the submit control (`FingerprintSignIn`). Both are shared components
 * with a `tone` prop rather than copies, so a change to the sensor's semantics reaches both.
 *
 * What stays different is the one thing that must: the CONSOLE IS AMBER. `tone="accent"` lights the
 * lattice and the sensor with `--accent`, the colour every other page of this console uses, so an
 * operator can tell at a glance which door they are standing at. Getting this wrong in the other
 * direction — a console that looks like a workspace — is how somebody types a tenant password into
 * the control plane.
 *
 * IT REMAINS A COMPLETELY SEPARATE AUTH PATH. `platformAdminAuthApi` authenticates against
 * `PlatformAdminUser` with its own JWT secret, its own cookie path and its own store; nothing here
 * touches tenant auth (see `store/platform-admin-auth.ts`'s header). Sharing two presentational
 * components is not sharing a session.
 *
 * THE THREE.JS COST IS THE SAME DEAL THE WORKSPACE PAGE STRUCK: `AuthScene` dynamically imports
 * three.js inside an effect, only after a desktop width and a no-reduced-motion check both pass. A
 * phone never downloads it; the form is typeable before any of it exists.
 */
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { Building2, HeartHandshake, Mails, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { useNavigate } from "react-router";
import { z } from "zod";
import { FingerprintSignIn, type SealState } from "../../components/auth/FingerprintSignIn";
import { AuthScene } from "../../components/marketing/AuthScene";
import { AnimatedThemeToggler } from "../../components/ui/animated-theme-toggler";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "../../components/ui/form";
import { Input } from "../../components/ui/input";
import { toast } from "../../components/ui/toaster";
import { Button } from "../../components/ui/button";
import { platformAdminAuthApi, type PlatformAdminUser } from "../../services/platform-admin-api";
import { usePlatformAdminAuthStore } from "../../store/platform-admin-auth";

const schema = z.object({
  email: z.string().email("Enter a valid email"),
  password: z.string().min(8, "At least 8 characters")
});

type FormData = z.infer<typeof schema>;

/** What this console is for, in the order an operator's day runs. Each line names a real screen. */
const PROOF = [
  { icon: Building2, text: "Every tenant's lifecycle, plan and database — never their content." },
  { icon: HeartHandshake, text: "The trial retention programme: who is lapsing, what goes out, what gets deleted." },
  { icon: Mails, text: "Platform mail, templates, delivery analytics and the audit trail." }
];

/** The brand half. Mirrors `marketing/AuthBrandPanel` deliberately — same lattice, same scrim, same
 *  bottom-weighted copy — with the console's amber where the product's teal would be. */
function ConsoleBrandPanel() {
  return (
    <aside className="relative hidden overflow-hidden bg-slate-950 lg:block">
      {/* The floor, for when three.js does not load: no WebGL, a blocked context, a laptop that met
          a monitor mid-session. The panel reads as a designed dark ground either way. */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute -left-24 top-1/4 h-[32rem] w-[32rem] rounded-full bg-accent/25 blur-[100px]" />
        <div className="absolute -right-20 bottom-0 h-[28rem] w-[28rem] rounded-full bg-info/15 blur-[100px]" />
      </div>

      <AuthScene className="absolute inset-0" tone="accent" />

      {/* Bottom-weighted, so the lattice keeps its contrast where there is no text over it. */}
      <div aria-hidden className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/40 to-slate-950/10" />

      <div className="relative flex h-full flex-col justify-between p-10 text-white xl:p-14">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-accent text-accent-foreground shadow-lg">
            <ShieldCheck className="h-5 w-5" />
          </span>
          <div className="leading-tight">
            <p className="font-black">Platform Admin</p>
            <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-white/55">TimeSphere control plane</p>
          </div>
        </div>

        <div className="max-w-md">
          <h2 className="text-3xl font-black leading-[1.1] tracking-tight xl:text-[2.6rem]">
            Every workspace on this deployment — <span className="text-accent">from one place.</span>
          </h2>
          <p className="mt-5 text-sm leading-7 text-white/70">
            Provision a customer, rescue a locked-out administrator, price a tier, and see what the platform is saying to
            the people who have stopped using it.
          </p>

          <ul className="mt-8 grid gap-2.5">
            {PROOF.map((item) => (
              <li key={item.text} className="flex items-start gap-3 rounded-xl border border-white/10 bg-white/[0.04] p-3 text-sm text-white/80 backdrop-blur-sm">
                <item.icon className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
                {item.text}
              </li>
            ))}
          </ul>
        </div>

        <p className="text-xs text-white/45">This console is separate from the workspace sign-in and holds no tenant credentials.</p>
      </div>
    </aside>
  );
}

/**
 * The second step, shown only after the password was right.
 *
 * IT CANNOT BE REACHED BY GUESSING AN ADDRESS. The server issues the challenge token this form
 * consumes only after a successful password check, so a wrong password produces the same 401 for an
 * enrolled account, an unenrolled one, and an address that does not exist. If the challenge could
 * be provoked without the password it would be an account-enumeration oracle of exactly the kind
 * tests/unit/auth-login-enumeration.test.ts exists to prevent.
 *
 * THE RECOVERY-CODE TOGGLE IS HERE RATHER THAN BEHIND A LINK because the person who needs it has
 * lost their phone and is already having a bad day at 2am.
 */
function SecondFactorStep({ challengeToken, onDone }: { challengeToken: string; onDone: (admin: PlatformAdminUser, token: string) => void }) {
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);

  const verify = useMutation({
    mutationFn: () => platformAdminAuthApi.verifyMfa(challengeToken, code.trim(), recovery),
    onSuccess: (data) => onDone(data.admin, data.accessToken),
    onError: (error: any) => toast.error("Not accepted", { description: error?.response?.data?.message ?? "Try the next code." })
  });

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        verify.mutate();
      }}
    >
      <div>
        <h1 className="text-2xl font-black tracking-tight">One more thing</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {recovery ? "Type one of the recovery codes you saved when you enrolled. Each works once." : "Type the six digits from your authenticator."}
        </p>
      </div>

      <label className="grid gap-1.5 text-sm font-medium" htmlFor="pa-mfa-code">
        {recovery ? "Recovery code" : "Authentication code"}
        <Input
          id="pa-mfa-code"
          autoFocus
          autoComplete="one-time-code"
          inputMode={recovery ? "text" : "numeric"}
          placeholder={recovery ? "ABCDE-FGHJK" : "123456"}
          className="text-center font-mono text-lg tracking-[0.3em]"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
      </label>

      <Button type="submit" className="w-full bg-accent text-accent-foreground hover:bg-accent/90" disabled={code.trim().length < 6 || verify.isPending}>
        {verify.isPending ? "Checking…" : "Sign in"}
      </Button>

      <button
        type="button"
        className="text-center text-xs text-muted-foreground underline-offset-4 hover:underline"
        onClick={() => {
          setRecovery((r) => !r);
          setCode("");
        }}
      >
        {recovery ? "Use my authenticator instead" : "I have lost my authenticator — use a recovery code"}
      </button>
    </form>
  );
}

export function PlatformAdminLogin() {
  const navigate = useNavigate();
  const setSession = usePlatformAdminAuthStore((s) => s.setSession);
  const form = useForm<FormData>({ resolver: zodResolver(schema), defaultValues: { email: "", password: "" } });
  const [sealState, setSealState] = useState<SealState>("idle");
  /** Set only when the server asked for a second factor. Its presence swaps the whole right-hand
   *  pane — there is deliberately no half-signed-in state here and no session behind it. */
  const [challengeToken, setChallengeToken] = useState<string | null>(null);

  const finish = (admin: PlatformAdminUser, accessToken: string) => {
    setSealState("success");
    setSession(admin, accessToken);
    navigate("/platform-admin");
  };

  const mutation = useMutation({
    mutationFn: (values: FormData) => platformAdminAuthApi.login(values.email, values.password),
    onMutate: () => setSealState("scanning"),
    onSuccess: (data) => {
      if (data.mfaRequired) {
        // NOT a session. The refresh cookie is deliberately not set on this response, so nothing
        // here can mint an access token until the code checks out.
        setSealState("idle");
        setChallengeToken(data.challengeToken);
        return;
      }
      finish(data.admin, data.accessToken);
    },
    onError: (error: any) => {
      setSealState("error");
      toast.error("Sign-in failed", { description: error?.response?.data?.message ?? "Check your credentials." });
    }
  });

  // The red sensor is a report on the attempt that just failed, not a state the form stays in — it
  // clears itself so the next attempt does not start already looking wrong.
  useEffect(() => {
    if (sealState !== "error") return;
    const timer = setTimeout(() => setSealState("idle"), 2200);
    return () => clearTimeout(timer);
  }, [sealState]);

  return (
    <div className="relative grid min-h-screen bg-background text-foreground lg:grid-cols-[1.05fr_1fr]">
      <div className="absolute right-4 top-4 z-10">
        <AnimatedThemeToggler />
      </div>

      <ConsoleBrandPanel />

      <main className="grid place-items-center px-4 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-accent text-accent-foreground">
              <ShieldCheck className="h-5 w-5" />
            </span>
            <div className="leading-tight">
              <p className="font-black">Platform Admin</p>
              <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Control plane</p>
            </div>
          </div>

          {challengeToken ? (
            <SecondFactorStep challengeToken={challengeToken} onDone={finish} />
          ) : (
            <>
          <h1 className="text-2xl font-black tracking-tight">Sign in</h1>
          <p className="mb-6 mt-1 text-sm text-muted-foreground">With a platform-admin account — not a workspace account.</p>

          <Form {...form}>
            <form className="grid gap-4" onSubmit={form.handleSubmit((values) => mutation.mutate(values))}>
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email</FormLabel>
                    <FormControl>
                      <Input placeholder="platform-admin@timesphere.local" autoComplete="username" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Password</FormLabel>
                    <FormControl>
                      <Input type="password" placeholder="••••••••" autoComplete="current-password" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* The sensor IS the submit button — same component and same semantics as the
                  workspace sign-in, in the console's amber. See FingerprintSignIn.tsx for why it
                  stays a real `type="submit"` with a fixed accessible name. */}
              <FingerprintSignIn state={sealState} tone="accent" disabled={mutation.isPending} className="mt-1" />

              {/* Kept, and it matters: there is deliberately no emailed reset for the
                  highest-privilege account on the platform, and somebody staring at this form at
                  2am needs to be told where the recovery procedure actually is. */}
              <p className="text-center text-xs text-muted-foreground">
                Forgotten it? There is deliberately no emailed reset for this account — see <span className="font-mono">docs/INSTALLATION.md</span>.
              </p>
            </form>
          </Form>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
