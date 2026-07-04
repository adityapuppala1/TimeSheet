import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { ArrowRight, Eye, EyeOff, Lock, Mail, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Link, useNavigate } from "react-router-dom";
import { z } from "zod";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Checkbox } from "../components/ui/checkbox";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "../components/ui/form";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { toast } from "../components/ui/toaster";
import { authApi } from "../services/api";
import { useAuthStore } from "../store/auth";

const schema = z.object({
  email: z.string().email("Enter a valid work email"),
  password: z.string().min(8, "At least 8 characters"),
  rememberMe: z.boolean().optional()
});

type FormData = z.infer<typeof schema>;

export function Login() {
  const navigate = useNavigate();
  const setSession = useAuthStore((s) => s.setSession);
  const [showPassword, setShowPassword] = useState(false);
  const form = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { email: "", password: "", rememberMe: true }
  });

  const mutation = useMutation({
    mutationFn: (values: FormData) => authApi.login(values.email, values.password, Boolean(values.rememberMe)),
    onSuccess: (data) => {
      setSession(data.user, data.accessToken);
      toast.success(`Welcome back, ${data.user.name?.split(" ")[0] ?? "there"}!`, {
        description: "Your secure session is active."
      });
      navigate("/app");
    },
    onError: (error: any) => {
      const message = error?.response?.data?.message ?? "Unable to sign in. Check credentials or account status.";
      toast.error("Sign-in failed", { description: message });
    }
  });

  return (
    <div className="relative grid min-h-screen place-items-center overflow-hidden bg-background px-4">
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -left-32 -top-32 h-96 w-96 rounded-full bg-primary/20 blur-3xl" />
        <div className="absolute -right-24 bottom-0 h-[28rem] w-[28rem] rounded-full bg-accent/25 blur-3xl" />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: "easeOut" }}
        className="w-full max-w-md"
      >
        <Card>
          <CardContent className="pt-6">
            <Link to="/" className="mb-7 inline-flex items-center gap-3 font-bold">
              <span className="grid h-9 w-9 place-items-center rounded-lg bg-primary text-primary-foreground">T</span>
              TimeSphere
            </Link>
            <h1 className="text-2xl font-black tracking-tight">Welcome back</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Sign in to log time, approve work, and review utilization.
            </p>

            <Form {...form}>
              <form className="mt-7 grid gap-4" onSubmit={form.handleSubmit((values) => mutation.mutate(values))}>
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
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}
