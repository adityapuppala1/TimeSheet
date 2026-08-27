/**
 * WHAT: the tenant login page — password form plus whichever SSO methods this org (resolved
 * from the request's subdomain server-side) has enabled: Google/Microsoft/SAML render as
 * "Continue with…" redirect buttons, LDAP renders as its own inline email/password form (`LdapLoginForm`)
 * since it's a direct bind, not a redirect.
 * WHY the available methods are fetched, not hardcoded: `authApi.ssoMethods()` reflects this
 * specific org's configuration — a different org on the same deployment may show entirely
 * different buttons, or none at all if it's SSO-only.
 *
 * THIS PAGE IS FUNCTIONAL BEFORE IT IS PRETTY. Every visual change here has to leave five paths
 * intact: password sign-in, each redirect SSO provider, the LDAP bind, forgot-password, and the
 * "no method configured" dead end. Restyle around a flow; never restructure one to fit a layout.
 *
 * WHY THE FAILURE MESSAGE IS INLINE AND NOT ONLY A TOAST: a toast disappears after a few seconds,
 * which is exactly the wrong behaviour for the one message a person needs while retyping a
 * password — and for lockout text, which explains why the next three attempts will also fail. The
 * toast stays as well, because it is what announces the failure to a screen reader immediately;
 * the inline panel is `role="alert"` and persists until the next attempt.
 *
 * LAYOUT: a two-panel split at `lg` and up — `AuthBrandPanel` on the LEFT, form on the right —
 * collapsing to the form alone below that. The form is FIRST in the DOM and moved into the second
 * column with `lg:order-2`, so a keyboard or screen-reader user lands on the email field before
 * any decoration, with no skip-link needed. (An earlier version of this comment said the opposite;
 * the visual order is brand-then-form, the DOM order is form-then-brand, and that inversion is the
 * whole point.) The panel is also `hidden` below `lg`, and its canvas checks the same breakpoint in
 * JS — CSS alone would still mount and run the animation on a phone.
 *
 * WHO renders this: `App.tsx`'s `/login` route.
 */
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  Mail,
  Network,
  ScanFace,
  ShieldCheck,
  Sparkles
} from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import { useForm } from "react-hook-form";
import { Link, useNavigate } from "react-router";
import { z } from "zod";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Checkbox } from "../components/ui/checkbox";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "../components/ui/form";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Skeleton } from "../components/ui/skeleton";
import { toast } from "../components/ui/toaster";
import { apiUrl, authApi, brandingApi, brandingLogoUrl, isMaintenanceLockoutError, type LoginResponse } from "../services/api";
import { useAuthStore } from "../store/auth";
import { AuthBrandPanel } from "../components/marketing/AuthBrandPanel";

// LDAP has no entry here — it's a direct bind, not a redirect, so it gets its own inline form
// (see LdapLoginForm below) instead of a "Continue with…" button.
const SSO_PROVIDER_META = {
  GOOGLE: { label: "Continue with Google", path: "google" },
  MICROSOFT: { label: "Continue with Microsoft", path: "microsoft" },
  SAML: { label: "Continue with single sign-on", path: "saml" }
} as const;

const schema = z.object({
  email: z.string().email("Enter a valid work email"),
  password: z.string().min(8, "At least 8 characters"),
  rememberMe: z.boolean().optional()
});

type FormData = z.infer<typeof schema>;

const ldapSchema = z.object({
  email: z.string().email("Enter a valid work email"),
  password: z.string().min(1, "Password is required")
});

type LdapFormData = z.infer<typeof ldapSchema>;

/** Whatever the API said went wrong, kept on screen until the next attempt. */
function SignInError({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-1 motion-safe:duration-300"
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>{message}</span>
    </p>
  );
}

/** Caps Lock is the single most common cause of a "wrong password" that isn't one. */
function CapsLockHint() {
  return (
    <span className="mt-1.5 flex items-center gap-1.5 text-xs font-medium text-warning">
      <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden />
      Caps Lock is on
    </span>
  );
}

/** Turns whatever the API returned into something a person can act on. */
function messageFor(error: any): string {
  return error?.response?.data?.message ?? "Unable to sign in. Check your credentials, or ask an admin whether the account is active.";
}

/** LDAP's own compact form — same shape as the password form above, but posts to
 *  /auth/login/ldap (a direct bind, see auth.controller.ts) instead of /auth/login. Kept
 *  separate rather than reusing the password form's react-hook-form instance since the two
 *  can be shown side by side (a workspace may allow both password and LDAP sign-in). */
function LdapLoginForm({ onSuccess }: { onSuccess: (data: LoginResponse) => void }) {
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const form = useForm<LdapFormData>({ resolver: zodResolver(ldapSchema), defaultValues: { email: "", password: "" } });

  const mutation = useMutation({
    mutationFn: (values: LdapFormData) => authApi.loginLdap(values.email, values.password),
    onSuccess,
    onError: (error: any) => {
      if (isMaintenanceLockoutError(error)) return; // the api interceptor is already navigating to /maintenance
      const message = messageFor(error);
      setFailure(message);
      toast.error("Sign-in failed", { description: message });
    }
  });

  return (
    <Form {...form}>
      <form
        className="grid gap-4"
        onSubmit={form.handleSubmit((values) => {
          setFailure(undefined);
          mutation.mutate(values);
        })}
      >
        {failure && <SignInError message={failure} />}
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Directory email</FormLabel>
              <div className="relative">
                <Mail className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" aria-hidden />
                <FormControl>
                  <Input className="pl-9" autoComplete="username" placeholder="you@company.com" {...field} />
                </FormControl>
              </div>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              {/* "Directory password", not "Password": when a workspace enables both methods this
                  form sits below the password form, and two identically-labelled fields on one
                  page are ambiguous to a screen reader and to anyone automating the page. */}
              <FormLabel>Directory password</FormLabel>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" aria-hidden />
                <FormControl>
                  <Input
                    className="pl-9 pr-10"
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    placeholder="••••••••"
                    {...field}
                    onKeyUp={(event: KeyboardEvent<HTMLInputElement>) => setCapsLock(event.getModifierState("CapsLock"))}
                    // Spread first, then wrapped: react-hook-form's own onBlur marks the field
                    // touched and runs validation, so it has to still be called.
                    onBlur={() => {
                      setCapsLock(false);
                      field.onBlur();
                    }}
                  />
                </FormControl>
                <button
                  type="button"
                  onClick={() => setShowPassword((value) => !value)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  className="focus-ring absolute right-2 top-2 grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {capsLock && <CapsLockHint />}
              <FormMessage />
            </FormItem>
          )}
        />
        <Button disabled={mutation.isPending} size="lg" className="mt-1" variant="outline">
          {mutation.isPending ? "Signing in..." : <>Sign in with LDAP <ArrowRight className="h-4 w-4" /></>}
        </Button>
      </form>
    </Form>
  );
}

/** Shown under the form on phones, where `AuthBrandPanel` is deliberately absent. */
const MOBILE_PROOF = [
  { icon: ShieldCheck, text: "Rotating sessions" },
  { icon: Sparkles, text: "AI off by default" },
  { icon: ScanFace, text: "Faces never leave your server" }
];

export function Login() {
  const navigate = useNavigate();
  const setSession = useAuthStore((s) => s.setSession);
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const form = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { email: "", password: "", rememberMe: true }
  });

  // Defaults to "password enabled, no SSO providers" while loading — the existing,
  // pre-SSO behavior — so the page never flashes blank or broken for a workspace that hasn't
  // configured SSO (the overwhelming common case) just because this query hasn't resolved yet.
  const ssoMethods = useQuery({ queryKey: ["auth", "sso-methods"], queryFn: authApi.ssoMethods });
  // Public read, like sso-methods beside it — the workspace's own logo belongs on their sign-in
  // page, and it has to render before anyone is authenticated.
  const branding = useQuery({ queryKey: ["branding"], queryFn: brandingApi.get, staleTime: Infinity });
  const workspaceLogo = brandingLogoUrl(branding.data);
  const workspaceName = branding.data?.displayName?.trim() || "TimeSphere";
  const passwordEnabled = ssoMethods.data?.passwordEnabled ?? true;
  const allProviders = ssoMethods.data?.providers ?? [];
  // LDAP is a direct bind, not a redirect, so it's rendered as its own inline form (below)
  // rather than joining the "Continue with…" button list.
  const ssoProviders = allProviders.filter((p): p is "GOOGLE" | "MICROSOFT" | "SAML" => p !== "LDAP");
  const ldapEnabled = allProviders.includes("LDAP");

  const handleLoginSuccess = (data: LoginResponse) => {
    setSession(data.user, data.accessToken);
    toast.success(`Welcome back, ${data.user.name?.split(" ")[0] ?? "there"}!`, {
      description: "Your secure session is active."
    });
    navigate("/app");
  };

  const mutation = useMutation({
    mutationFn: (values: FormData) => authApi.login(values.email, values.password, Boolean(values.rememberMe)),
    onSuccess: handleLoginSuccess,
    onError: (error: any) => {
      if (isMaintenanceLockoutError(error)) return; // the api interceptor is already navigating to /maintenance
      const message = messageFor(error);
      setFailure(message);
      toast.error("Sign-in failed", { description: message });
    }
  });

  return (
    // Two panels at lg and up, one below it. The brand side is second in the DOM but painted first
    // via `order` so that on a narrow screen — where it's hidden anyway — the form is what a
    // keyboard or screen-reader user reaches first, with no skip-link needed.
    <div className="grid min-h-screen lg:grid-cols-2">
      <main className="relative flex items-center justify-center overflow-hidden px-4 py-10 sm:px-6 lg:order-2">
        <div className="pointer-events-none absolute inset-0 -z-10 lg:hidden">
          <div className="absolute -left-32 -top-32 h-96 w-96 rounded-full bg-primary/20 blur-3xl" />
          <div className="absolute -right-24 bottom-0 h-[28rem] w-[28rem] rounded-full bg-accent/25 blur-3xl" />
        </div>

        <div className="w-full max-w-md motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-3 motion-safe:duration-500">
          {/* Borderless beside the brand panel — a card outline inside an already-split layout
              reads as a box within a box. It keeps its card treatment on small screens, where it
              IS the page. */}
          <Card className="border-border shadow-lg lg:border-transparent lg:bg-transparent lg:shadow-none">
            <CardContent className="pt-6 lg:px-0">
              <Link to="/" className="focus-ring mb-7 inline-flex items-center gap-3 rounded-md font-bold lg:hidden">
                {workspaceLogo ? (
                  <img src={workspaceLogo} alt={workspaceName} className="h-9 w-9 rounded-lg object-contain" />
                ) : (
                  <span className="grid h-9 w-9 place-items-center rounded-lg bg-primary text-primary-foreground">T</span>
                )}
                {workspaceName}
              </Link>
              {/* Beside the brand panel (lg and up) the panel carries the product identity, so the
                  WORKSPACE mark goes here — where a company expects to see their own logo — only
                  when one is actually set. */}
              {workspaceLogo && (
                <img
                  src={workspaceLogo}
                  alt={workspaceName}
                  className="mb-6 hidden h-11 max-w-[13rem] object-contain object-left lg:block"
                />
              )}
              <h1 className="text-2xl font-black tracking-tight">Welcome back</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                Sign in to log time, approve work, and review utilization.
              </p>

              {ssoMethods.isLoading && <Skeleton className="mt-7 h-10 w-full" />}

              {ssoProviders.length > 0 && (
                <div className="mt-7 grid gap-2.5">
                  {ssoProviders.map((provider) => (
                    <Button key={provider} asChild variant="outline" size="lg">
                      <a href={apiUrl(`/auth/sso/${SSO_PROVIDER_META[provider].path}/start`)}>
                        <KeyRound className="h-4 w-4" aria-hidden />
                        {SSO_PROVIDER_META[provider].label}
                      </a>
                    </Button>
                  ))}
                </div>
              )}

              {ssoProviders.length > 0 && passwordEnabled && (
                <div className="my-5 flex items-center gap-3 text-xs uppercase tracking-wide text-muted-foreground">
                  <span className="h-px flex-1 bg-border" />
                  or
                  <span className="h-px flex-1 bg-border" />
                </div>
              )}

              {passwordEnabled && (
                <Form {...form}>
                  <form
                    className={ssoProviders.length > 0 ? "grid gap-4" : "mt-7 grid gap-4"}
                    onSubmit={form.handleSubmit((values) => {
                      setFailure(undefined);
                      mutation.mutate(values);
                    })}
                  >
                    {failure && <SignInError message={failure} />}

                    <FormField
                      control={form.control}
                      name="email"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Email</FormLabel>
                          <div className="relative">
                            <Mail className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" aria-hidden />
                            <FormControl>
                              <Input className="pl-9" autoComplete="username" placeholder="you@company.com" {...field} />
                            </FormControl>
                          </div>
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
                          <div className="relative">
                            <Lock className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" aria-hidden />
                            <FormControl>
                              <Input
                                className="pl-9 pr-10"
                                type={showPassword ? "text" : "password"}
                                autoComplete="current-password"
                                placeholder="••••••••"
                                {...field}
                                // Read from the event rather than tracked globally: the modifier
                                // can be toggled while another window has focus, so the only
                                // reliable moment to ask is a keystroke in this field. Spread
                                // first, then wrapped — react-hook-form's own onBlur marks the
                                // field touched and runs validation, so it must still fire.
                                onKeyUp={(event: KeyboardEvent<HTMLInputElement>) => setCapsLock(event.getModifierState("CapsLock"))}
                                onBlur={() => {
                                  setCapsLock(false);
                                  field.onBlur();
                                }}
                              />
                            </FormControl>
                            <button
                              type="button"
                              onClick={() => setShowPassword((value) => !value)}
                              aria-label={showPassword ? "Hide password" : "Show password"}
                              className="focus-ring absolute right-2 top-2 grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                            >
                              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                            </button>
                          </div>
                          {capsLock && <CapsLockHint />}
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="rememberMe"
                      render={({ field }) => (
                        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                          <div className="flex items-center gap-2">
                            <Checkbox
                              id="rememberMe"
                              checked={Boolean(field.value)}
                              onCheckedChange={(checked) => field.onChange(Boolean(checked))}
                            />
                            <Label htmlFor="rememberMe" className="font-normal text-muted-foreground">
                              Remember me
                            </Label>
                          </div>
                          <Link to="/forgot-password" className="focus-ring rounded font-semibold text-primary hover:underline">
                            Forgot password?
                          </Link>
                        </div>
                      )}
                    />

                    <Button disabled={mutation.isPending} size="lg" className="mt-1">
                      {mutation.isPending ? (
                        "Signing in..."
                      ) : (
                        <>
                          Sign in <ArrowRight className="h-4 w-4" />
                        </>
                      )}
                    </Button>

                    <p className="mt-2 inline-flex items-start gap-2 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
                      <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
                      Sessions auto-refresh in the background. Sign out from the avatar menu to clear devices.
                    </p>
                  </form>
                </Form>
              )}

              {ldapEnabled && (
                <div className={passwordEnabled || ssoProviders.length > 0 ? "mt-6 border-t border-border pt-6" : "mt-7"}>
                  {(passwordEnabled || ssoProviders.length > 0) && (
                    <p className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      <Network className="h-3.5 w-3.5 shrink-0" aria-hidden />
                      Directory (LDAP) sign-in
                    </p>
                  )}
                  <LdapLoginForm onSuccess={handleLoginSuccess} />
                </div>
              )}

              {!ssoMethods.isLoading && !passwordEnabled && ssoProviders.length === 0 && !ldapEnabled && (
                <p className="mt-7 rounded-lg bg-muted px-3 py-3 text-sm text-muted-foreground">
                  No sign-in method is currently configured for this workspace. Contact your administrator.
                </p>
              )}

              {/* The way OUT of the wrong workspace. Every workspace has its own subdomain, so a
                  person who has landed on the wrong one — or who followed a stale bookmark — sees a
                  sign-in form that will never accept them, with nothing else on the page to explain
                  why. This is deliberately at the bottom and quiet: it matters enormously to the
                  few people who need it and is noise to everyone who arrived correctly. */}
              <p className="mt-7 text-center text-sm text-muted-foreground">
                Not your workspace?{" "}
                <Link to="/find-workspace" className="focus-ring rounded font-semibold text-primary hover:underline">
                  Find yours
                </Link>
              </p>

              {/* Phone-only stand-in for the brand panel, which is `hidden` below lg. Three short
                  claims, not the panel's full copy — this sits under a form somebody is trying to
                  submit, not beside it. */}
              <ul className="mt-8 flex flex-wrap justify-center gap-x-4 gap-y-2 text-xs text-muted-foreground lg:hidden">
                {MOBILE_PROOF.map((item) => (
                  <li key={item.text} className="inline-flex items-center gap-1.5">
                    <item.icon className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
                    {item.text}
                  </li>
                ))}
              </ul>

              <p className="mt-6 text-center text-xs text-muted-foreground">
                <Link to="/" className="focus-ring inline-flex items-center gap-1 rounded font-semibold text-primary hover:underline">
                  <ArrowLeft className="h-3 w-3" aria-hidden />
                  New here? See what TimeSphere does
                </Link>
              </p>
            </CardContent>
          </Card>
        </div>
      </main>

      <AuthBrandPanel />
    </div>
  );
}
