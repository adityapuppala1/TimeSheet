/**
 * Field primitives for the Attendance & Leave settings tab (V17 UI v2). Every one is CONTROLLED and
 * STAGED: it reports a change to the tab, which holds it in a draft until Save. Every switch shows
 * "On" or "Off" in words beside it, and a child option only renders when its parent is on
 * (progressive disclosure), so the page never lists controls that do nothing.
 */
import type { ReactNode } from "react";
import { Segmented, type SegmentOption } from "../../components/attendance/attendance-ui";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Switch } from "../../components/ui/switch";
import { cn } from "../../lib/utils";

export function StagedToggle({
  id,
  label,
  hint,
  checked,
  disabled,
  onChange,
  emphasis = false,
  changed = false,
  children
}: Readonly<{
  id: string;
  label: string;
  hint: ReactNode;
  checked: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
  emphasis?: boolean;
  /** This value differs from what is saved. */
  changed?: boolean;
  /** Child options, shown only while the switch is on. */
  children?: ReactNode;
}>) {
  return (
    <div className={cn("grid gap-3 rounded-lg border p-4 transition-colors", emphasis ? "border-primary/40 bg-primary/5" : "border-border bg-muted/20")}>
      <div className="flex min-w-0 items-start gap-4">
        <div className="min-w-0 flex-1">
          <Label htmlFor={id} className="flex flex-wrap items-center gap-2">
            {label}
            {changed && <span className="rounded bg-primary/10 px-1.5 text-[10px] font-semibold uppercase tracking-wide text-primary">Unsaved</span>}
          </Label>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{hint}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="w-7 text-right text-xs font-semibold text-muted-foreground" aria-hidden="true">
            {checked ? "On" : "Off"}
          </span>
          <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} aria-label={`${label}: ${checked ? "on" : "off"}`} />
        </div>
      </div>
      {checked && children && <div className="grid gap-3 border-t border-border pt-3">{children}</div>}
    </div>
  );
}

export function StagedSegment<T extends string>({
  label,
  hint,
  value,
  options,
  disabled,
  onChange
}: Readonly<{ label: string; hint?: string; value: T; options: ReadonlyArray<SegmentOption<T>>; disabled: boolean; onChange: (v: T) => void }>) {
  return (
    <div className="grid min-w-0 gap-1.5" aria-disabled={disabled}>
      <Label>{label}</Label>
      <div className={cn(disabled && "pointer-events-none opacity-60")}>
        <Segmented label={label} value={value} onChange={onChange} options={options} className="w-full sm:w-fit" />
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function StagedSelect({
  id,
  label,
  hint,
  value,
  options,
  disabled,
  onChange
}: Readonly<{ id: string; label: string; hint?: string; value: string; options: ReadonlyArray<[string, string]>; disabled: boolean; onChange: (v: string) => void }>) {
  return (
    <div className="grid min-w-0 gap-1.5 sm:max-w-sm">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={id} className="w-full min-w-0">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map(([v, text]) => (
            <SelectItem key={v} value={v}>
              {text}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function StagedNumber({
  id,
  label,
  hint,
  value,
  min,
  max,
  disabled,
  onChange
}: Readonly<{ id: string; label: string; hint: string; value: number; min: number; max: number; disabled: boolean; onChange: (v: number) => void }>) {
  return (
    <div className="grid min-w-0 gap-1.5 sm:max-w-xs">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        disabled={disabled}
        key={value}
        defaultValue={value}
        onBlur={(e) => {
          const n = Number(e.target.value);
          if (Number.isInteger(n) && n >= min && n <= max && n !== value) onChange(n);
        }}
      />
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}
