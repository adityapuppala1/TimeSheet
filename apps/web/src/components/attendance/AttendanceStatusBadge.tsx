/**
 * The attendance status chip (V17 UI v2): icon + word on the status's own tint, from the shared
 * mapping in lib/attendance-status.ts and the `--status-*` tokens. Never colour alone.
 *
 * `compact` drops the word and keeps the icon (for a dense avatar board); it then still carries an
 * accessible name, so a screen reader hears the status either way.
 */
import { cn } from "../../lib/utils";
import { statusMetaFor, STATUS_META, type StatusInput, type StatusKey } from "../../lib/attendance-status";

export function AttendanceStatusBadge({
  status,
  statusKey,
  className,
  compact = false,
  label
}: Readonly<{ status?: StatusInput; statusKey?: StatusKey; className?: string; compact?: boolean; label?: string }>) {
  const meta = statusKey ? STATUS_META[statusKey] : statusMetaFor(status ?? { status: "PENDING" });
  const Icon = meta.icon;
  const text = label ?? meta.label;
  return (
    <span
      className={cn(
        "status-chip inline-flex shrink-0 items-center gap-1 rounded-full text-xs font-semibold leading-5",
        meta.className,
        compact ? "h-5 w-5 justify-center" : "px-2 py-0.5",
        className
      )}
      {...(compact ? { role: "img", "aria-label": text, title: text } : {})}
    >
      <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
      {!compact && <span className="truncate">{text}</span>}
    </span>
  );
}
