/**
 * WHAT: the login form for the `/platform-admin` console — deliberately a completely separate
 * page/form from the tenant `Login.tsx`, never sharing a component.
 * WHY separate: authenticates against `PlatformAdminUser`/`platformAdminAuthApi`, a fully
 * distinct credential and token system from tenant auth (see `store/platform-admin-auth.ts`'s
 * header) — reusing the tenant login form here would risk the two auth flows accidentally
 * sharing state.
 * WHO renders this: `App.tsx`'s `/platform-admin/login` route.
 */
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { motion, useReducedMotion } from "framer-motion";
import { Building2, HeartHandshake, Mails, ShieldCheck } from "lucide-react";
import { useForm } from "react-hook-form";
import { useNavigate } from "react-router";
import { z } from "zod";
import { AnimatedThemeToggler } from "../../components/ui/animated-theme-toggler";
import { Button } from "../../components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "../../components/ui/form";
import { Input } from "../../components/ui/input";
import { toast } from "../../components/ui/toaster";
import { platformAdminAuthApi } from "../../services/platform-admin-api";
import { usePlatformAdminAuthStore } from "../../store/platform-admin-auth";

const schema = z.object({
  email: z.string().email("Enter a valid email"),
  password: z.string().min(8, "At least 8 characters")
});

type FormData = z.infer<typeof schema>;

const POINTS = [
  { icon: Building2, text: "Every tenant's lifecycle, plan and database — never their content." },
  { icon: HeartHandshake, text: "The trial retention programme: who is lapsing, what goes out, what gets deleted." },
  { icon: Mails, text: "Platform mail, templates, delivery analytics and the audit trail." }
];

export function PlatformAdminLogin() {
  const navigate = useNavigate();
  const reduce = useReducedMotion();
  const setSession = usePlatformAdminAuthStore((s) => s.setSession);
  const form = useForm<FormData>({ resolver: zodResolver(schema), defaultValues: { email: "", password: "" } });

  const mutation = useMutation({
    mutationFn: (values: FormData) => platformAdminAuthApi.login(values.email, values.password),
    onSuccess: (data) => {
      setSession(data.admin, data.accessToken);
      navigate("/platform-admin");
    },
    onError: (error: any) => {
      toast.error("Sign-in failed", { description: error?.response?.data?.message ?? "Check your credentials." });
    }
  });

  return (
    <div className="relative grid min-h-screen bg-background text-foreground lg:grid-cols-[1.1fr_1fr]">
      <div className="absolute right-4 top-4 z-10">
        <AnimatedThemeToggler />
      </div>

      {/* The brand panel — amber, the console's colour, so even the sign-in page cannot be mistaken for a workspace. */}
      <aside className="relative hidden overflow-hidden bg-card lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div className="pointer-events-none absolute -left-24 -top-24 h-96 w-96 rounded-full bg-accent/15 blur-3xl" aria-hidden />
        <div className="pointer-events-none absolute -bottom-32 right-0 h-80 w-80 rounded-full bg-accent/10 blur-3xl" aria-hidden />
        <div className="relative flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-accent text-accent-foreground shadow-md">
            <ShieldCheck className="h-5 w-5" />
          </span>
          <div className="leading-tight">
            <p className="text-lg font-black tracking-tight">Platform Admin</p>
            <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">TimeSphere control plane</p>
          </div>
        </div>
        <motion.ul initial={reduce ? false : "hidden"} animate="show" variants={{ show: { transition: { staggerChildren: 0.08 } } }} className="relative grid max-w-md gap-5">
          {POINTS.map(({ icon: Icon, text }) => (
            <motion.li key={text} variants={{ hidden: { opacity: 0, x: -10 }, show: { opacity: 1, x: 0 } }} className="flex items-start gap-3 text-sm text-muted-foreground">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent/15 text-accent">
                <Icon className="h-4 w-4" />
              </span>
              <span className="pt-1.5">{text}</span>
            </motion.li>
          ))}
        </motion.ul>
        <p className="relative text-xs text-muted-foreground">This console is separate from the workspace sign-in and holds no tenant credentials.</p>
      </aside>

      <main className="grid place-items-center px-4 py-12">
        <motion.div initial={reduce ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, ease: "easeOut" }} className="w-full max-w-sm">
          <div className="mb-6 flex items-center gap-3 lg:hidden">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-accent text-accent-foreground">
              <ShieldCheck className="h-5 w-5" />
            </span>
            <div>
              <p className="text-lg font-black tracking-tight">Platform Admin</p>
              <p className="text-xs text-muted-foreground">TimeSphere control plane</p>
            </div>
          </div>
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
              <Button disabled={mutation.isPending} size="lg" className="mt-1 bg-accent text-accent-foreground hover:bg-accent/90">
                {mutation.isPending ? "Signing in..." : "Sign in"}
              </Button>
              <p className="text-center text-xs text-muted-foreground">Forgotten it? There is deliberately no emailed reset for this account — see docs/INSTALLATION.md.</p>
            </form>
          </Form>
        </motion.div>
      </main>
    </div>
  );
}
