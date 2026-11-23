/**
 * WHAT: an agent's face in the Office's 2D chrome (the selection panel and the flat fallback) — its
 * initials on a disc in the agent's own tint, ringed in its mood colour, with its emoji as a badge.
 *
 * WHY NOT THE ROBOT PORTRAIT: in the Office agents are people, and their name tags in the 3D scene
 * (scene/labels.ts) use this same initials disc — so the panel, the tag and the fallback all show one
 * identity. Working and needs-a-look moods pulse the ring unless reduced motion is on.
 */
import { AGENT_PALETTE, moodCss, type Mood } from "../agents-studio/studio-model";
import { cn } from "../../lib/utils";
import { initialsOf } from "./office-model";

export function AgentAvatar({
  name,
  emoji,
  tint,
  mood,
  size = 40,
  animate = true,
  className
}: Readonly<{ name: string; emoji?: string; tint: number; mood: Mood; size?: number; animate?: boolean; className?: string }>) {
  const colour = AGENT_PALETTE[tint % AGENT_PALETTE.length].css;
  const live = animate && (mood === "working" || mood === "attention");
  return (
    <span className={cn("relative inline-grid shrink-0 place-items-center", className)} style={{ width: size, height: size }} aria-hidden="true">
      {live && <span className="absolute inset-0 animate-ping rounded-full opacity-30" style={{ background: moodCss(mood) }} />}
      <span
        className="relative grid h-full w-full place-items-center rounded-full font-semibold text-slate-900 shadow-sm"
        style={{ background: colour, boxShadow: `0 0 0 ${Math.max(2, size / 16)}px ${moodCss(mood)}`, fontSize: size * 0.36, opacity: mood === "off" ? 0.55 : 1 }}
      >
        {initialsOf(name)}
      </span>
      {emoji && (
        <span className="absolute -bottom-1 -right-1 grid place-items-center rounded-full bg-background shadow" style={{ width: size * 0.45, height: size * 0.45, fontSize: size * 0.26 }}>
          {emoji}
        </span>
      )}
    </span>
  );
}
