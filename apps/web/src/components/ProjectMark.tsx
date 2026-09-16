/**
 * WHAT: a project's mark — a small rounded square in the project's identity colour carrying its
 * initials — the same everywhere a project is named: the sidebar tree, the tickets table, the
 * phone cards, group headers.
 *
 * WHY: a hierarchy you can scan by colour before you read it is the single most recognisable trait
 * of the sidebar pattern this branch replicates (locations carry colours — see the V12 state file's
 * sourced plan). The colour is derived from the id (lib/identity-colors.ts), so it costs no storage
 * and matches on every device; a stored per-project colour can override it later.
 *
 * THEME: the fill is chosen per theme by reading the `dark` class the theme module already sets,
 * through `useSyncExternalStore` on the same event the theme toggle fires — so the mark repaints
 * with the wipe rather than a frame behind it.
 */
import { useSyncExternalStore } from "react";
import { identityColorFor, initialsFor } from "../lib/identity-colors";
import { currentTheme, subscribeTheme } from "../lib/theme";
import { cn } from "../lib/utils";

const SIZE_CLASS = { xs: "h-4 w-4 text-[9px]", sm: "h-6 w-6 text-[10px]", md: "h-8 w-8 text-xs" } as const;

export function ProjectMark({ id, name, size = "sm", className }: Readonly<{ id: string; name: string; size?: "xs" | "sm" | "md"; className?: string }>) {
  const theme = useSyncExternalStore(subscribeTheme, currentTheme, () => "light" as const);
  const color = identityColorFor(id);
  const fill = theme === "dark" ? color.dark : color.light;
  const box = SIZE_CLASS[size];
  return (
    <span
      aria-hidden="true"
      data-identity={color.id}
      className={cn("grid shrink-0 place-items-center rounded-md font-bold leading-none tracking-tight", box, className)}
      style={{ backgroundColor: `hsl(${fill})`, color: theme === "dark" ? "hsl(224 38% 8%)" : "hsl(0 0% 100%)" }}
    >
      {initialsFor(name)}
    </span>
  );
}
