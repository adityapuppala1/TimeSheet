import { useMutation } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { ArrowLeft, Mail, Send } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { toast } from "../components/ui/toaster";
import { authApi } from "../services/api";

export function ForgotPassword() {
  const [email, setEmail] = useState("");
  const mutation = useMutation({
    mutationFn: () => authApi.forgotPassword(email),
    onSuccess: () => toast.success("Check your inbox", { description: "If the account exists, we've sent reset instructions." }),
    onError: (err: any) => toast.error("Unable to send reset link", { description: err?.response?.data?.message ?? "Try again." })
  });

  return (
    <div className="relative grid min-h-screen place-items-center px-4">
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -left-32 top-1/4 h-80 w-80 rounded-full bg-primary/15 blur-3xl" />
        <div className="absolute -right-24 bottom-10 h-80 w-80 rounded-full bg-accent/20 blur-3xl" />
      </div>
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: "easeOut" }}
        className="w-full max-w-md"
      >
        <Card>
          <CardContent className="pt-6">
            <h1 className="text-2xl font-black tracking-tight">Reset password</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Enter your account email — we'll send reset instructions if it matches.
            </p>
            <form
              className="mt-7 grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (email) mutation.mutate();
              }}
            >
              <div className="grid gap-1.5">
                <Label htmlFor="forgot-email">Email</Label>
                <div className="relative">
                  <Mail className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="forgot-email"
                    className="pl-9"
                    type="email"
                    placeholder="name@company.com"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    required
                  />
                </div>
              </div>
              <Button type="submit" disabled={mutation.isPending || !email} size="lg">
                {mutation.isPending ? "Sending..." : (<><Send className="h-4 w-4" />Send reset link</>)}
              </Button>
              {mutation.isSuccess && (
                <Alert variant="success">
                  <AlertTitle>Reset instructions sent</AlertTitle>
                  <AlertDescription>If the account exists, check your inbox in a minute.</AlertDescription>
                </Alert>
              )}
              <Link className="inline-flex items-center justify-center gap-1 text-center text-sm font-semibold text-primary hover:underline" to="/login">
                <ArrowLeft className="h-3 w-3" />Back to login
              </Link>
            </form>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}
