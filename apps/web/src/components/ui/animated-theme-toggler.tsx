/**
 * The theme toggle, with the wipe. Local implementation of magicui's animated-theme-toggler, per
 * this repo's rule that such patterns are built in-tree against our own tokens rather than
 * vendored — same reasoning as BorderGlow (see border-glow.tsx).
 *
 * The animation itself lives in lib/theme.ts, because the command palette can change the theme too
 * and neither of them should own it. This component is the button: it passes its own centre as the
 * origin, so the new theme spreads from the control the person actually pressed.
 *
 * THE ICON CROSSFADE IS NOT THE POINT and is deliberately cheap — two absolutely-positioned glyphs
 * swapping opacity and rotation, both compositable properties. The expensive-looking part of this
 * interaction is the full-screen wipe, and that runs once per press on a browser-composited
 * snapshot rather than continuously against the live DOM.
 */
import { useRef, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { Button } from "./button";
import { centreOf, currentTheme, toggleTheme, type Theme } from "../../lib/theme";
import { cn } from "../../lib/utils";

export function AnimatedThemeToggler({ className }: { className?: string }) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const [theme, setTheme] = useState<Theme>(() => (typeof document === "undefined" ? "light" : currentTheme()));
  const dark = theme === "dark";

  return (
    <Button
      ref={ref}
      variant="ghost"
      size="icon"
      className={cn("relative overflow-hidden", className)}
      onClick={() => setTheme(toggleTheme(centreOf(ref.current)))}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
    >
      {/* Both mounted, one visible. Swapping which element EXISTS would restart the transition from
          scratch on every press and lose the rotation entirely. */}
      <Sun
        className={cn(
          "absolute h-4 w-4 transition-all duration-300 motion-reduce:transition-none",
          dark ? "rotate-0 scale-100 opacity-100" : "rotate-90 scale-50 opacity-0"
        )}
        aria-hidden
      />
      <Moon
        className={cn(
          "absolute h-4 w-4 transition-all duration-300 motion-reduce:transition-none",
          dark ? "-rotate-90 scale-50 opacity-0" : "rotate-0 scale-100 opacity-100"
        )}
        aria-hidden
      />
    </Button>
  );
}
