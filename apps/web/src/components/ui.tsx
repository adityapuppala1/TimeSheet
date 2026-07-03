import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Button as ShadcnButton, type ButtonProps } from "./ui/button";
import { Card } from "./ui/card";
import { Input as ShadcnInput, type InputProps } from "./ui/input";
import { Label } from "./ui/label";
import { Badge as ShadcnBadge } from "./ui/badge";
import { cn } from "../lib/utils";

/**
 * Legacy shims kept temporarily so older pages keep compiling.
 * New code should import directly from `./ui/<name>`.
 */

export function Button({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & Partial<ButtonProps>) {
  return <ShadcnButton className={className} {...(props as ButtonProps)} />;
}

export function GhostButton({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <ShadcnButton variant="outline" className={className} {...(props as ButtonProps)} />;
}

export function Input(props: InputProps) {
  return <ShadcnInput {...props} />;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <Card className={cn("p-5", className)}>{children}</Card>;
}

type LegacyTone = "default" | "good" | "warn" | "bad";

export function Badge({ children, tone = "default" }: { children: ReactNode; tone?: LegacyTone }) {
  const variant = tone === "good" ? "success" : tone === "warn" ? "warning" : tone === "bad" ? "destructive" : "muted";
  return <ShadcnBadge variant={variant}>{children}</ShadcnBadge>;
}
