/**
 * WHAT: the tenant login page — password form plus whichever SSO methods this org (resolved
 * from the request's subdomain server-side) has enabled: Google/Microsoft/SAML render as
 * "Continue with…" redirect buttons, LDAP renders as its own inline email/password form (`LdapLoginForm`)
 * since it's a direct bind, not a redirect.
 * WHY the available methods are fetched, not hardcoded: `authApi.ssoMethods()` reflects this
 * specific org's configuration — a different org on the same deployment may show entirely
 * different buttons, or none at all if it's SSO-only.
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
import { motion } from "framer-motion";
import { ArrowRight, Eye, EyeOff, Lock, Mail, ShieldCheck } from "lucide-react";
import { useState } from "react";
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
import { apiUrl, authApi, type LoginResponse } from "../services/api";
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

/** LDAP's own compact form — same shape as the password form above, but posts to
 *  /auth/login/ldap (a direct bind, see auth.controller.ts) instead of /auth/login. Kept
 *  separate rather than reusing the password form's react-hook-form instance since the two
 *  can be shown side by side (a workspace may allow both password and LDAP sign-in). */
function LdapLoginForm({ onSuccess }: { onSuccess: (data: LoginResponse) => void }) {
  const [showPassword, setShowPassword] = useState(false);
  const form = useForm<LdapFormData>({ resolver: zodResolver(ldapSchema), defaultValues: { email: "", password: "" } });

  const mutation = useMutation({
    mutationFn: (values: LdapFormData) => authApi.loginLdap(values.email, values.password),
    onSuccess,
    onError: (error: any) => {
      const message = error?.response?.data?.message ?? "Unable to sign in. Check credentials or account status.";
      toast.error("Sign-in failed", { description: message });
    }
  });

  return (
    <Form {...form}>
      <form className="grid gap-4" onSubmit={form.handleSubmit((values) => mutation.mutate(values))}>
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Directory email</FormLabel>
              <div className="relative">
                <Mail className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
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
                <Lock className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                <FormControl>
                  <Input
                    className="pl-9 pr-10"
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    placeholder="••••••••"
                    {...field}
                  />
                </FormControl>
                <button
                  type="button"
                  onClick={() => setShowPassword((value) => !value)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  className="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
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

export function Login() {
  const navigate = useNavigate();
  const setSession = useAuthStore((s) => s.setSession);
  const [showPassword, setShowPassword] = useState(false);
  const form = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { email: "", password: "", rememberMe: true }
  });

  // Defaults to "password enabled, no SSO providers" while loading — the existing,
  // pre-SSO behavior — so the page never flashes blank or broken for a workspace that hasn't
  // configured SSO (the overwhelming common case) just because this query hasn't resolved yet.
  const ssoMethods = useQuery({ queryKey: ["auth", "sso-methods"], queryFn: authApi.ssoMethods });
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
      const message = error?.response?.data?.message ?? "Unable to sign in. Check credentials or account status.";
      toast.error("Sign-in failed", { description: message });
    }
  });

  return (
    // Two panels at lg and up, one below it. The brand side is second in the DOM but painted first
    // via `order` so that on a narrow screen — where it's hidden anyway — the form is what a
    // keyboard or screen-reader user reaches first, with no skip-link needed.
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="relative flex items-center justify-center overflow-hidden px-4 py-10 sm:px-6 lg:order-2">
        <div className="pointer-events-none absolute inset-0 -z-10 lg:hidden">
          <div className="absolute -left-32 -top-32 h-96 w-96 rounded-full bg-primary/20 blur-3xl" />
          <div className="absolute -right-24 bottom-0 h-[28rem] w-[28rem] rounded-full bg-accent/25 blur-3xl" />
        </div>

        <motion.div
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: "easeOut" }}
          className="w-full max-w-md"
        >
          {/* Borderless beside the brand panel — a card outline inside an already-split layout
              reads as a box within a box. It keeps its card treatment on small screens, where it
              IS the page. */}
          <Card className="border-border shadow-lg lg:border-transparent lg:bg-transparent lg:shadow-none">
            <CardContent className="pt-6 lg:px-0">
              <Link to="/" className="mb-7 inline-flex items-center gap-3 font-bold lg:hidden">
                <span className="grid h-9 w-9 place-items-center rounded-lg bg-primary text-primary-foreground">T</span>
                TimeSphere
              </Link>
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
              <form className={ssoProviders.length > 0 ? "grid gap-4" : "mt-7 grid gap-4"} onSubmit={form.handleSubmit((values) => mutation.mutate(values))}>
                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email</FormLabel>
                      <div className="relative">
                        <Mail className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
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
                        <Lock className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                        <FormControl>
                          <Input
                            className="pl-9 pr-10"
                            type={showPassword ? "text" : "password"}
                            autoComplete="current-password"
                            placeholder="••••••••"
                            {...field}
                          />
                        </FormControl>
                        <button
                          type="button"
                          onClick={() => setShowPassword((value) => !value)}
                          aria-label={showPassword ? "Hide password" : "Show password"}
                          className="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                      </div>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="rememberMe"
                  render={({ field }) => (
                    <div className="flex items-center justify-between text-sm">
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
                      <Link to="/forgot-password" className="font-semibold text-primary hover:underline">
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
                  <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                  Sessions auto-refresh in the background. Sign out from the avatar menu to clear devices.
                </p>
              </form>
            </Form>
            )}

            {ldapEnabled && (
              <div className={passwordEnabled || ssoProviders.length > 0 ? "mt-6 border-t border-border pt-6" : "mt-7"}>
                {(passwordEnabled || ssoProviders.length > 0) && (
                  <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Directory (LDAP) sign-in</p>
                )}
                <LdapLoginForm onSuccess={handleLoginSuccess} />
              </div>
            )}

            {!ssoMethods.isLoading && !passwordEnabled && ssoProviders.length === 0 && !ldapEnabled && (
                <p className="mt-7 rounded-lg bg-muted px-3 py-3 text-sm text-muted-foreground">
                  No sign-in method is currently configured for this workspace. Contact your administrator.
                </p>
              )}

              <p className="mt-8 text-center text-xs text-muted-foreground">
                New here? <Link to="/" className="font-semibold text-primary hover:underline">See what TimeSphere does</Link>
              </p>
            </CardContent>
          </Card>
        </motion.div>
      </div>

      <AuthBrandPanel />
    </div>
  );
}
