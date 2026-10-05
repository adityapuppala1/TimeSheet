/**
 * WHAT: self-serve signup — the page behind "Start free trial".
 *
 * IT ASKS WHO YOU ARE BEFORE IT OFFERS ANYTHING (signup Phase 1, docs/SIGNUP_AND_DOMAINS_PLAN.md §5.1):
 *  1. Email. Verified before anything is created or revealed: the last step provisions a real
 *     database, and "acme.com already has a workspace" told to anyone who types an @acme.com address
 *     would enumerate customers.
 *  2. Code. Checked once, at the server, and the answer is a decision — one per door:
 *       member      → you already belong to a workspace: sign in to it;
 *       join        → your company already uses TimeSphere: ask its administrators to let you in;
 *       unavailable → your company's workspace is not taking people right now: ask its administrator;
 *       create      → your company has no workspace: name one and create the first admin.
 *     One workspace per company domain is the rule; a team that genuinely needs its own is a
 *     conversation with us (`/contact?reason=separate-workspace`), never a self-serve button.
 *  3. The workspace, or the join request.
 * Every mapping from the server's answer to a step lives in utils/signup-flow.ts, pinned by its tests.
 *
 * WHY THE SLUG IS SHOWN AS A FULL ADDRESS, EDITABLE, AND SUGGESTED RATHER THAN IMPOSED: it becomes the
 * hostname everyone at the company types for years, and the server refuses a collision with a 409
 * rather than quietly appending `-2`. The suffix is the server's root domain (`GET /signup/status`),
 * never guessed from this page's host — it is served from the apex and from any workspace's host.
 *
 * CLOSED IS A STATE, NOT AN ERROR (2026-10-01). Signup is off unless the operator opened it, and is
 * always off on a single-org install. A visitor who arrives anyway gets a page that says so and
 * offers the doors that DO exist. The server is the authority: a 403 `SIGNUP_CLOSED` mid-flow lands
 * on the same page.
 */
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeft, ArrowRight, Building2, CheckCircle2, DoorClosed, Mail, Send, Sparkles, Users } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Link } from "react-router";
import { z } from "zod";
import { WorkspaceLinkList } from "../components/WorkspaceLinkList";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import { useSignupStatus } from "../hooks/use-signup-status";
import { authApi } from "../services/api";
import { classifySignupError, companyWorkspaceLabel, stepAfterVerify, workspaceHostSuffix, type SignupStep, type SignupWorkspaceLink } from "../utils/signup-flow";

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
const joinSchema = z.object({
  name: z.string().trim().min(2, "At least 2 characters").max(120),
  message: z.string().max(1000, "Keep it under 1,000 characters")
});

/** A workspace name turned into a plausible address. Suggested only — the field stays editable,
 *  because a company's preferred short name is not derivable from its legal one. */
function suggestSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 63)
    // Trimmed AFTER the cut: a long name cut mid-word could end in "-", which the server refuses.
    .replace(/^-+|-+$/g, "");
}

type JoinOutcome = { status: "requested" | "already_pending" | "member"; url?: string };

const SEPARATE_WORKSPACE_LINK = "/contact?reason=separate-workspace";

function ClosedCard() {
  return (
    <Card>
      <CardHeader>
        <div className="mb-1 grid h-10 w-10 place-items-center rounded-lg bg-muted text-muted-foreground">
          <DoorClosed className="h-5 w-5" aria-hidden />
        </div>
        <CardTitle>Signups are closed here</CardTitle>
        <CardDescription>
          New workspaces on this service are set up with us rather than on your own. Tell us about your team and we'll get you started.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        <Button asChild className="w-full">
          <Link to="/contact">Talk to us</Link>
        </Button>
        <Button asChild variant="outline" className="w-full">
          <Link to="/find-workspace">Find your company's workspace</Link>
        </Button>
        <Button asChild variant="ghost" className="w-full">
          <Link to="/login">Sign in</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function SeparateWorkspaceHint() {
  return (
    <p className="text-center text-xs leading-5 text-muted-foreground">
      Need a separate workspace for your team?{" "}
      <Link to={SEPARATE_WORKSPACE_LINK} className="focus-ring rounded font-semibold text-primary hover:underline">
        Talk to us
      </Link>
    </p>
  );
}

const STEP_ICON: Record<SignupStep, typeof Sparkles> = {
  email: Sparkles,
  code: Sparkles,
  workspace: Sparkles,
  member: Building2,
  join: Users,
  joined: Send,
  unavailable: DoorClosed,
  done: CheckCircle2
};

function stepTitle(step: SignupStep, companyName: string): string {
  switch (step) {
    case "member":
      return "You already have a workspace";
    case "join":
      return `${companyName} already uses TimeSphere`;
    case "joined":
      return "Request sent";
    case "unavailable":
      return `${companyWorkspaceLabel(companyName)} isn't available`;
    case "done":
      return "Your workspace is ready";
    default:
      return "Start your free trial";
  }
}

function joinedDescription(outcome: JoinOutcome | null, companyName: string): string {
  if (outcome?.status === "member") return `You already have an account in ${companyName}. Sign in to it.`;
  if (outcome?.status === "already_pending") return `You've already asked to join ${companyName}. You'll get an email when its administrators decide.`;
  return `We've asked ${companyName}'s administrators. You'll get an email when they decide.`;
}

export function Signup() {
  const [step, setStep] = useState<SignupStep>("email");
  const [token, setToken] = useState("");
  const [sentTo, setSentTo] = useState("");
  /** Spent at verify; what `complete` or `join` redeems. Survives a correctable refusal (a taken slug). */
  const [continuation, setContinuation] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [memberOf, setMemberOf] = useState<SignupWorkspaceLink[]>([]);
  const [joinOutcome, setJoinOutcome] = useState<JoinOutcome | null>(null);
  const [created, setCreated] = useState<{ url: string; trialDays: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState("");
  /** A refusal that needs a fresh code — the old one was spent at verify. */
  const [verifyAgain, setVerifyAgain] = useState(false);
  const { open, trialDays, rootDomain } = useSignupStatus();
  /** Set when the server refuses mid-flow — it is the authority, whatever the status query said. */
  const [closedByServer, setClosedByServer] = useState(false);
  const closed = (open === false || closedByServer) && step !== "done" && step !== "joined";
  const hostSuffix = workspaceHostSuffix(rootDomain);

  const emailForm = useForm<z.infer<typeof emailSchema>>({ resolver: zodResolver(emailSchema), defaultValues: { email: "" } });
  const codeForm = useForm<z.infer<typeof codeSchema>>({ resolver: zodResolver(codeSchema), defaultValues: { code: "" } });
  const wsForm = useForm<z.infer<typeof workspaceSchema>>({
    resolver: zodResolver(workspaceSchema),
    defaultValues: { workspaceName: "", slug: "", adminName: "", adminPassword: "" }
  });
  const joinForm = useForm<z.infer<typeof joinSchema>>({ resolver: zodResolver(joinSchema), defaultValues: { name: "", message: "" } });

  /** Acts on a refusal from any step. Returns nothing: every branch sets the state that shows it. */
  const handleError = (err: unknown, fallback: string, onSlugTaken?: (message: string) => void) => {
    const action = classifySignupError(err, fallback);
    switch (action.kind) {
      case "closed":
        setClosedByServer(true);
        return;
      case "unavailable":
        setStep("unavailable");
        return;
      case "slug-taken":
        // A taken address belongs on the field that caused it, and the continuation is intact.
        if (onSlugTaken) onSlugTaken(action.message);
        else setServerError(action.message);
        return;
      case "verify-again":
        setVerifyAgain(true);
        setServerError(action.message);
        return;
      case "expired":
        emailForm.setValue("email", sentTo);
        setStep("email");
        setServerError(action.message);
        return;
      default:
        setServerError(action.message);
    }
  };

  const start = async ({ email }: z.infer<typeof emailSchema>) => {
    setBusy(true);
    setServerError("");
    setVerifyAgain(false);
    try {
      const { token: issued } = await authApi.signupStart(email);
      setToken(issued);
      setSentTo(email);
      codeForm.reset();
      setStep("code");
    } catch (err) {
      // Inline rather than a toast: the free-mail refusal is about the field directly above it.
      handleError(err, "Couldn't send the code. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const verify = async ({ code }: z.infer<typeof codeSchema>) => {
    setBusy(true);
    setServerError("");
    try {
      const result = await authApi.signupVerify(token, code);
      if (result.next === "member") setMemberOf(result.workspaces);
      if (result.next === "join" || result.next === "unavailable") setCompanyName(result.workspace.name);
      if (result.next === "join" || result.next === "create") setContinuation(result.continuation);
      setStep(stepAfterVerify(result));
    } catch (err) {
      const action = classifySignupError(err, "That code isn't right. Request a new one.");
      if (action.kind === "message") codeForm.setError("code", { message: action.message });
      else handleError(err, "That code isn't right. Request a new one.");
    } finally {
      setBusy(false);
    }
  };

  const complete = async (values: z.infer<typeof workspaceSchema>) => {
    setBusy(true);
    setServerError("");
    try {
      const result = await authApi.signupComplete({ continuation, ...values });
      setCreated({ url: result.url, trialDays: result.trialDays });
      setStep("done");
    } catch (err) {
      handleError(err, "Couldn't create the workspace. Try again.", (message) => wsForm.setError("slug", { message }));
    } finally {
      setBusy(false);
    }
  };

  const join = async (values: z.infer<typeof joinSchema>) => {
    setBusy(true);
    setServerError("");
    try {
      const result = await authApi.signupJoin({ continuation, name: values.name, message: values.message.trim() || undefined });
      setJoinOutcome({ status: result.status, url: result.workspace.url });
      setStep("joined");
    } catch (err) {
      handleError(err, "Couldn't send your request. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const StepIcon = STEP_ICON[step];

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-10">
      <div className="w-full max-w-md">
        <Link to="/" className="focus-ring mb-4 inline-flex items-center gap-1.5 rounded text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
          Back
        </Link>

        {closed ? (
          <ClosedCard />
        ) : (
          <Card>
            <CardHeader>
              <div className="mb-1 grid h-10 w-10 place-items-center rounded-lg bg-primary/10 text-primary">
                <StepIcon className="h-5 w-5" aria-hidden />
              </div>
              <CardTitle>{stepTitle(step, companyName)}</CardTitle>
              <CardDescription>
                {step === "email" && `${trialDays} days of the Team plan. No card, and nothing is charged when it ends.`}
                {step === "code" && `We sent a 6-digit code to ${sentTo}. It expires in 10 minutes.`}
                {step === "member" && "Sign in to it — there's no need for a new one."}
                {step === "join" && "Ask to join it. Its administrators decide, and you'll get an email when they do."}
                {step === "joined" && joinedDescription(joinOutcome, companyName)}
                {step === "unavailable" && "It isn't taking new people right now. Contact its administrator to be added."}
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
                <form onSubmit={codeForm.handleSubmit(verify)} className="grid gap-4">
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
                    {busy ? "Checking…" : "Continue"} <ArrowRight className="h-4 w-4" />
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

              {step === "member" && (
                <div className="grid gap-2">
                  <WorkspaceLinkList workspaces={memberOf} />
                </div>
              )}

              {step === "join" && !verifyAgain && (
                <form onSubmit={joinForm.handleSubmit(join)} className="grid gap-4">
                  <div className="grid gap-1.5">
                    <Label htmlFor="join-name">Your name</Label>
                    <Input id="join-name" autoComplete="name" autoFocus {...joinForm.register("name")} />
                    {joinForm.formState.errors.name && <p className="text-xs text-destructive">{joinForm.formState.errors.name.message}</p>}
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="join-message">
                      Message to the administrators <span className="font-normal text-muted-foreground">(optional)</span>
                    </Label>
                    <Textarea id="join-message" rows={3} placeholder="Your team, your manager, or why you need access." {...joinForm.register("message")} />
                    {joinForm.formState.errors.message && <p className="text-xs text-destructive">{joinForm.formState.errors.message.message}</p>}
                  </div>
                  <Button type="submit" disabled={busy} className="w-full">
                    <Send className="h-4 w-4" />
                    {busy ? "Sending…" : "Ask to join"}
                  </Button>
                  <SeparateWorkspaceHint />
                </form>
              )}

              {step === "joined" && (
                <div className="grid gap-3">
                  {joinOutcome?.status === "member" && joinOutcome.url && (
                    <Button asChild size="lg">
                      <a href={`${joinOutcome.url}/login`}>
                        Sign in <ArrowRight className="h-4 w-4" />
                      </a>
                    </Button>
                  )}
                  {joinOutcome?.status !== "member" && <SeparateWorkspaceHint />}
                </div>
              )}

              {step === "unavailable" && (
                <Button asChild variant="outline" className="w-full">
                  <Link to="/find-workspace">Find a workspace you already belong to</Link>
                </Button>
              )}

              {/* Hidden while "verify again" shows: the answer this form would get has already changed. */}
              {step === "workspace" && !verifyAgain && (
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
                    <div className="flex min-w-0 items-center gap-1.5">
                      <Input id="ws-slug" className="min-w-0 flex-1" placeholder="acme" {...wsForm.register("slug")} />
                      {hostSuffix && <span className="min-w-0 shrink truncate text-sm text-muted-foreground">{hostSuffix}</span>}
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
                    <p className="text-center text-xs text-muted-foreground">This takes a few seconds — we're creating your own database, not a row in a shared one.</p>
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
              {verifyAgain && (
                // The code was spent at verify: "back" is a fresh code to the same address, and the
                // server's answer this time reflects what changed.
                <Button variant="outline" disabled={busy} onClick={() => void start({ email: sentTo })}>
                  Verify {sentTo} again
                </Button>
              )}

              {(step === "email" || step === "code") && (
                <p className="text-center text-sm text-muted-foreground">
                  Already have a workspace?{" "}
                  <Link to="/find-workspace" className="focus-ring rounded font-semibold text-primary hover:underline">
                    Find it
                  </Link>
                </p>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
