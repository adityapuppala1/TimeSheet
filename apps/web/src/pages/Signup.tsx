/**
 * WHAT: self-serve signup — the page behind "Start free trial", which until now went to `/login`,
 * where there is no way to create a workspace at all.
 *
 * THREE STEPS, AND EACH ONE EARNS ITS PLACE:
 *  1. Email. Verified before anything is created, because step 3 provisions a real database and a
 *     public route that does that unguarded is a denial-of-service button.
 *  2. Code. The same six-digit flow workspace discovery uses.
 *  3. The workspace itself — name, address, and the first admin account.
 *
 * WHY THE SLUG IS SHOWN AS A FULL URL, EDITABLE, AND SUGGESTED RATHER THAN IMPOSED: it becomes the
 * hostname everyone at the company types for years, and the server refuses a collision with a 409
 * rather than quietly appending `-2`. Seeing `acme.timesphere.app` while typing is what makes the
 * consequence of the field obvious at the moment it can still be changed.
 *
 * The last step is slow — it creates a database and runs every migration — so it says so, rather
 * than showing a spinner that reads as a hang.
 */
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeft, ArrowRight, CheckCircle2, Mail, Sparkles } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Link } from "react-router";
import { z } from "zod";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { authApi } from "../services/api";

const emailSchema = z.object({ email: z.string().email("Enter a valid work email") });
const codeSchema = z.object({ code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code") });
const workspaceSchema = z.object({
  workspaceName: z.string().min(2, "At least 2 characters").max(200),
  slug: z
    .string()
    .min(3, "At least 3 characters")
    .max(63)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, "Lowercase letters, numbers and hyphens only"),
  adminName: z.string().min(2, "At least 2 characters").max(120),
  adminPassword: z.string().min(8, "At least 8 characters").max(200)
});

/** A workspace name turned into a plausible address. Suggested only — the field stays editable,
 *  because a company's preferred short name is not derivable from its legal one. */
function suggestSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

export function Signup() {
  const [step, setStep] = useState<"email" | "code" | "workspace" | "done">("email");
  const [token, setToken] = useState("");
  const [sentTo, setSentTo] = useState("");
  const [created, setCreated] = useState<{ url: string; trialDays: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState("");

  const emailForm = useForm<z.infer<typeof emailSchema>>({ resolver: zodResolver(emailSchema), defaultValues: { email: "" } });
  const codeForm = useForm<z.infer<typeof codeSchema>>({ resolver: zodResolver(codeSchema), defaultValues: { code: "" } });
  const wsForm = useForm<z.infer<typeof workspaceSchema>>({
    resolver: zodResolver(workspaceSchema),
    defaultValues: { workspaceName: "", slug: "", adminName: "", adminPassword: "" }
  });

  const start = async ({ email }: z.infer<typeof emailSchema>) => {
    setBusy(true);
    setServerError("");
    try {
      const { token: issued } = await authApi.signupStart(email);
      setToken(issued);
      setSentTo(email);
      setStep("code");
    } catch (err: any) {
      // Shown inline rather than as a toast: the free-mail refusal is about the field directly
      // above it, and a toast would vanish before they read it.
      //
      // 429 is called out because it is the one failure here with no message of its own — the
      // limiter answers with express-rate-limit's default body, and "Couldn't send the code" for
      // something that will work again shortly reads as broken rather than as throttled.
      setServerError(
        err?.response?.status === 429
          ? "Too many signup attempts from this network. Wait a few minutes and try again."
          : (err?.response?.data?.message ?? "Couldn't send the code. Try again.")
      );
    } finally {
      setBusy(false);
    }
  };

  const complete = async (values: z.infer<typeof workspaceSchema>) => {
    setBusy(true);
    setServerError("");
    try {
      const result = await authApi.signupComplete({ token, code: codeForm.getValues("code"), ...values });
      setCreated({ url: result.url, trialDays: result.trialDays });
      setStep("done");
    } catch (err: any) {
      const message = err?.response?.data?.message ?? "Couldn't create the workspace. Try again.";
      // A taken address belongs on the field that caused it, not in a banner at the bottom.
      if (err?.response?.status === 409) wsForm.setError("slug", { message });
      else setServerError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-10">
      <div className="w-full max-w-md">
        <Link to="/" className="focus-ring mb-4 inline-flex items-center gap-1.5 rounded text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
          Back
        </Link>

        <Card>
          <CardHeader>
            <div className="mb-1 grid h-10 w-10 place-items-center rounded-lg bg-primary/10 text-primary">
              {step === "done" ? <CheckCircle2 className="h-5 w-5" /> : <Sparkles className="h-5 w-5" />}
            </div>
            <CardTitle>{step === "done" ? "Your workspace is ready" : "Start your free trial"}</CardTitle>
            <CardDescription>
              {step === "email" && "15 days of the Team plan. No card, and nothing is charged when it ends."}
              {step === "code" && `We sent a 6-digit code to ${sentTo}. It expires in 10 minutes.`}
              {step === "workspace" && "Name your workspace and create the first admin account."}
              {step === "done" && created && `You have ${created.trialDays} days on the Team plan. We've emailed you the link too.`}
            </CardDescription>
          </CardHeader>

          <CardContent className="grid gap-4">
            {step === "email" && (
              <form onSubmit={emailForm.handleSubmit(start)} className="grid gap-4">
                <div className="grid gap-1.5">
                  <Label htmlFor="signup-email">Work email</Label>
                  <Input id="signup-email" type="email" autoComplete="email" autoFocus placeholder="you@company.com" {...emailForm.register("email")} />
                  {emailForm.formState.errors.email && <p className="text-xs text-destructive">{emailForm.formState.errors.email.message}</p>}
                </div>
                <Button type="submit" disabled={busy} className="w-full">
                  <Mail className="h-4 w-4" />
                  {busy ? "Sending…" : "Continue"}
                </Button>
              </form>
            )}

            {step === "code" && (
              <form onSubmit={codeForm.handleSubmit(() => setStep("workspace"))} className="grid gap-4">
                <div className="grid gap-1.5">
                  <Label htmlFor="signup-code">Verification code</Label>
                  <Input
                    id="signup-code"
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
                  Continue <ArrowRight className="h-4 w-4" />
                </Button>
              </form>
            )}

            {step === "workspace" && (
              <form onSubmit={wsForm.handleSubmit(complete)} className="grid gap-4">
                <div className="grid gap-1.5">
                  <Label htmlFor="ws-name">Workspace name</Label>
                  <Input
                    id="ws-name"
                    autoFocus
                    placeholder="Acme Ltd"
                    {...wsForm.register("workspaceName", {
                      onChange: (e) => {
                        // Only fills a slug the person has not touched. Overwriting a deliberate
                        // choice on every keystroke of the name above is maddening.
                        if (!wsForm.getFieldState("slug").isDirty) wsForm.setValue("slug", suggestSlug(e.target.value));
                      }
                    })}
                  />
                  {wsForm.formState.errors.workspaceName && <p className="text-xs text-destructive">{wsForm.formState.errors.workspaceName.message}</p>}
                </div>

                <div className="grid gap-1.5">
                  <Label htmlFor="ws-slug">Workspace address</Label>
                  <div className="flex items-center gap-1.5">
                    <Input id="ws-slug" className="flex-1" placeholder="acme" {...wsForm.register("slug")} />
                    <span className="shrink-0 text-sm text-muted-foreground">.timesphere.app</span>
                  </div>
                  <p className="text-xs text-muted-foreground">This is what your whole team will type. It can't be changed later.</p>
                  {wsForm.formState.errors.slug && <p className="text-xs text-destructive">{wsForm.formState.errors.slug.message}</p>}
                </div>

                <div className="grid gap-1.5">
                  <Label htmlFor="admin-name">Your name</Label>
                  <Input id="admin-name" autoComplete="name" {...wsForm.register("adminName")} />
                  {wsForm.formState.errors.adminName && <p className="text-xs text-destructive">{wsForm.formState.errors.adminName.message}</p>}
                </div>

                <div className="grid gap-1.5">
                  <Label htmlFor="admin-password">Choose a password</Label>
                  <Input id="admin-password" type="password" autoComplete="new-password" {...wsForm.register("adminPassword")} />
                  {wsForm.formState.errors.adminPassword && <p className="text-xs text-destructive">{wsForm.formState.errors.adminPassword.message}</p>}
                </div>

                <Button type="submit" disabled={busy} className="w-full">
                  {busy ? "Setting up your workspace…" : "Create workspace"}
                  {!busy && <ArrowRight className="h-4 w-4" />}
                </Button>
                {busy && (
                  <p className="text-center text-xs text-muted-foreground">
                    This takes a few seconds — we're creating your own database, not a row in a shared one.
                  </p>
                )}
              </form>
            )}

            {step === "done" && created && (
              <div className="grid gap-3">
                {/* A plain anchor: the new workspace is a different origin, and a router link would
                    keep the browser here and resolve the wrong tenant. */}
                <Button asChild size="lg">
                  <a href={`${created.url}/login`}>
                    Open your workspace <ArrowRight className="h-4 w-4" />
                  </a>
                </Button>
                <p className="text-center text-xs text-muted-foreground">{created.url.replace(/^https?:\/\//, "")}</p>
              </div>
            )}

            {serverError && <p className="text-sm leading-6 text-destructive">{serverError}</p>}

            {step !== "done" && (
              <p className="text-center text-sm text-muted-foreground">
                Already have a workspace?{" "}
                <Link to="/find-workspace" className="focus-ring rounded font-semibold text-primary hover:underline">
                  Find it
                </Link>
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
