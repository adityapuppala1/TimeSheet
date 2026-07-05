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
import { ShieldCheck } from "lucide-react";
import { useForm } from "react-hook-form";
import { useNavigate } from "react-router-dom";
import { z } from "zod";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
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

export function PlatformAdminLogin() {
  const navigate = useNavigate();
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
    <div className="grid min-h-screen place-items-center bg-slate-950 px-4">
      <Card className="w-full max-w-sm border-slate-800 bg-slate-900 text-slate-100">
        <CardContent className="pt-6">
          <div className="mb-6 flex items-center gap-3">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-amber-500 text-slate-950">
              <ShieldCheck className="h-5 w-5" />
            </span>
            <div>
              <p className="text-lg font-black tracking-tight">Platform Admin</p>
              <p className="text-xs text-slate-400">TimeSphere control plane</p>
            </div>
          </div>

          <Form {...form}>
            <form className="grid gap-4" onSubmit={form.handleSubmit((values) => mutation.mutate(values))}>
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-slate-300">Email</FormLabel>
                    <FormControl>
                      <Input className="border-slate-700 bg-slate-950 text-slate-100" placeholder="platform-admin@timesphere.local" {...field} />
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
                    <FormLabel className="text-slate-300">Password</FormLabel>
                    <FormControl>
                      <Input type="password" className="border-slate-700 bg-slate-950 text-slate-100" placeholder="••••••••" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button disabled={mutation.isPending} size="lg" className="mt-1 bg-amber-500 text-slate-950 hover:bg-amber-400">
                {mutation.isPending ? "Signing in..." : "Sign in"}
              </Button>
              <p className="text-center text-xs text-slate-500">This console is separate from the workspace login and has no connection to any tenant's data or credentials.</p>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}
