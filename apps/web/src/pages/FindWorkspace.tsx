/**
 * WHAT: "I don't remember my workspace address." Enter an email, receive a code, get the list.
 *
 * WHY IT EXISTS. Every workspace lives on its own subdomain — `acme.timesphere.app` resolves to
 * Acme's own database before a single credential is exchanged (see the API's middleware/tenant.ts).
 * That is what makes per-workspace branding and per-workspace sign-in methods possible, and it is
 * also the one thing a returning user can forget. Until this page there was nowhere for them to go.
 *
 * WHY IT ASKS FOR A CODE RATHER THAN JUST ANSWERING. A page that told anyone "bob@acme.com belongs
 * to Acme and Globex" would be an enumeration oracle: it confirms an address exists and names the
 * employer. So the first step answers identically whether or not the address matched — the list is
 * reachable only by returning a code sent to that address. The cost of discovery is an inbox the
 * asker controls, which is the same bar the password-reset flow sets.
 *
 * WHAT THAT MEANS FOR THIS UI: step one must never render differently for a hit than for a miss.
 * There is deliberately no "we found 2 workspaces" reassurance before verification, and no
 * "we don't recognise that address" after it — both would undo the property the API works for.
 *
 * WHO renders this: App.tsx's `/find-workspace` route (public, unauthenticated).
 */
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeft, ArrowRight, Building2, Mail, Search } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Link } from "react-router";
import { z } from "zod";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { toast } from "../components/ui/toaster";
import { authApi } from "../services/api";

const emailSchema = z.object({ email: z.string().email("Enter a valid work email") });
const codeSchema = z.object({ code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code") });

interface Workspace {
  slug: string;
  name: string;
  url: string;
}

export function FindWorkspace() {
  const [step, setStep] = useState<"email" | "code" | "done">("email");
  const [token, setToken] = useState("");
  const [sentTo, setSentTo] = useState("");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [busy, setBusy] = useState(false);

  const emailForm = useForm<z.infer<typeof emailSchema>>({ resolver: zodResolver(emailSchema), defaultValues: { email: "" } });
  const codeForm = useForm<z.infer<typeof codeSchema>>({ resolver: zodResolver(codeSchema), defaultValues: { code: "" } });

  const requestCode = async ({ email }: z.infer<typeof emailSchema>) => {
    setBusy(true);
    try {
      const { token: issued } = await authApi.findWorkspacesStart(email);
      setToken(issued);
      setSentTo(email);
      setStep("code");
    } catch {
      toast.error("Couldn't send the code", { description: "Check your connection and try again." });
    } finally {
      setBusy(false);
    }
  };

  const verify = async ({ code }: z.infer<typeof codeSchema>) => {
    setBusy(true);
    try {
      const { workspaces: found } = await authApi.findWorkspacesVerify(token, code);
      setWorkspaces(found);
      setStep("done");
    } catch (err: any) {
      // The API's message is deliberately the same for a wrong code and for an address that
      // matched nothing. Shown verbatim rather than reinterpreted, so this screen cannot become
      // the oracle the API refuses to be.
      codeForm.setError("code", { message: err?.response?.data?.message ?? "That code isn't right. Request a new one." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-10">
      <div className="w-full max-w-md">
        <Link to="/login" className="focus-ring mb-4 inline-flex items-center gap-1.5 rounded text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
          Back to sign in
        </Link>

        <Card>
          <CardHeader>
            <div className="mb-1 grid h-10 w-10 place-items-center rounded-lg bg-primary/10 text-primary">
              {step === "done" ? <Building2 className="h-5 w-5" /> : <Search className="h-5 w-5" />}
            </div>
            <CardTitle>{step === "done" ? "Your workspaces" : "Find your workspace"}</CardTitle>
            <CardDescription>
              {step === "email" && "Enter your work email and we'll send a code to confirm it's you."}
              {step === "code" && `We sent a 6-digit code to ${sentTo}. It expires in 10 minutes.`}
              {step === "done" &&
                (workspaces.length > 0
                  ? "Pick the one you want to sign in to."
                  : "That address isn't in any workspace on this deployment yet.")}
            </CardDescription>
          </CardHeader>

          <CardContent className="grid gap-4">
            {step === "email" && (
              <form onSubmit={emailForm.handleSubmit(requestCode)} className="grid gap-4">
                <div className="grid gap-1.5">
                  <Label htmlFor="find-email">Work email</Label>
                  <Input id="find-email" type="email" autoComplete="email" autoFocus placeholder="you@company.com" {...emailForm.register("email")} />
                  {emailForm.formState.errors.email && (
                    <p className="text-xs text-destructive">{emailForm.formState.errors.email.message}</p>
                  )}
                </div>
                <Button type="submit" disabled={busy} className="w-full">
                  <Mail className="h-4 w-4" />
                  {busy ? "Sending…" : "Send verification code"}
                </Button>
              </form>
            )}

            {step === "code" && (
              <form onSubmit={codeForm.handleSubmit(verify)} className="grid gap-4">
                <div className="grid gap-1.5">
                  <Label htmlFor="find-code">Verification code</Label>
                  <Input
                    id="find-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    autoFocus
                    maxLength={6}
                    placeholder="000000"
                    className="text-center text-lg tracking-[0.4em]"
                    {...codeForm.register("code")}
                  />
                  {codeForm.formState.errors.code && <p className="text-xs text-destructive">{codeForm.formState.errors.code.message}</p>}
                </div>
                <Button type="submit" disabled={busy} className="w-full">
                  {busy ? "Checking…" : "Continue"}
                  <ArrowRight className="h-4 w-4" />
                </Button>
                <button
                  type="button"
                  className="focus-ring rounded text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  onClick={() => {
                    setStep("email");
                    codeForm.reset();
                  }}
                >
                  Use a different email address
                </button>
              </form>
            )}

            {step === "done" && (
              <div className="grid gap-2">
                {workspaces.map((workspace) => (
                  // A plain anchor, not a router Link: each workspace is a DIFFERENT ORIGIN, and a
                  // client-side navigation would keep the browser on this host and resolve the
                  // wrong tenant.
                  <a
                    key={workspace.slug}
                    href={`${workspace.url}/login`}
                    className="focus-ring flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-3.5 text-left transition hover:border-primary/40 hover:shadow-sm"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold">{workspace.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">{workspace.url.replace(/^https?:\/\//, "")}</span>
                    </span>
                    <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </a>
                ))}

                {workspaces.length === 0 && (
                  <p className="text-sm leading-6 text-muted-foreground">
                    If your team uses a different address for you, try that one. Otherwise ask a colleague for your
                    workspace link — anyone signed in can read it from their address bar.
                  </p>
                )}

                <Button variant="outline" className="mt-2" onClick={() => { setStep("email"); setWorkspaces([]); emailForm.reset(); codeForm.reset(); }}>
                  Look up another address
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
