/**
 * WHAT: an agent's face as a small SVG — the 2D twin of the 3D character. It is the Studio's fallback
 * (no WebGL, software rendering, a failed chunk), its loading state, and a drop-in avatar for the
 * roster, so the same little robot is recognisable whether or not the 3D stage is running.
 *
 * It wears the SAME colours as the 3D body — the agent's palette tint and the mood colour — so a card,
 * its portrait and its character are visibly one thing. Blinking and the antenna pulse are SMIL
 * `<animate>` elements, which cost nothing on the main thread and are simply not rendered when the
 * viewer asked for reduced motion (`animate={false}`).
 *
 * Decorative by design (`aria-hidden`): the agent's name and state are always text beside it.
 */
import { AGENT_PALETTE, moodCss, type Mood } from "./studio-model";

/** Mix a #rrggbb colour toward white. */
function lighten(css: string, amount: number): string {
  const n = Number.parseInt(css.slice(1), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `rgb(${r}, ${g}, ${b})`;
}

/** The eyes' height and top edge for a mood: shut when off, narrowed to focus when working, open otherwise. */
function eyeShape(mood: Mood): { height: number; y: number } {
  if (mood === "off") return { height: 1.2, y: 33 };
  if (mood === "working") return { height: 4.6, y: 30.2 };
  return { height: 7, y: 29 };
}

export function AgentPortrait({
  tint,
  mood,
  size = 64,
  animate = true,
  className
}: Readonly<{ tint: number; mood: Mood; size?: number; animate?: boolean; className?: string }>) {
  const palette = AGENT_PALETTE[tint % AGENT_PALETTE.length];
  const status = moodCss(mood);
  const dim = mood === "off";
  const { height: eyeHeight, y: eyeY } = eyeShape(mood);

  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true" className={className} role="presentation">
      <circle cx="32" cy="34" r="29" fill={palette.css} opacity={dim ? 0.12 : 0.22} />
      {/* body */}
      <rect x="18" y="45" width="28" height="14" rx="7" fill={palette.css} />
      {/* head */}
      <rect x="13" y="17" width="38" height="29" rx="11" fill={lighten(palette.css, 0.28)} />
      <rect x="19" y="25" width="26" height="15" rx="6" fill="#0b1220" />
      {/* eyes */}
      <rect x="24" y={eyeY} width="5" height={eyeHeight} rx="2" fill={status} opacity={dim ? 0.5 : 1}>
        {animate && !dim && <animate attributeName="height" values={`${eyeHeight};${eyeHeight};1;${eyeHeight}`} keyTimes="0;0.9;0.94;1" dur="4.2s" repeatCount="indefinite" />}
      </rect>
      <rect x="35" y={eyeY} width="5" height={eyeHeight} rx="2" fill={status} opacity={dim ? 0.5 : 1}>
        {animate && !dim && <animate attributeName="height" values={`${eyeHeight};${eyeHeight};1;${eyeHeight}`} keyTimes="0;0.9;0.94;1" dur="4.2s" repeatCount="indefinite" />}
      </rect>
      {/* antenna and its status light */}
      <line x1="32" y1="17" x2="32" y2="9" stroke={lighten(palette.css, 0.1)} strokeWidth="2" strokeLinecap="round" />
      <circle cx="32" cy="8" r={dim ? 2 : 3} fill={status} opacity={dim ? 0.5 : 1}>
        {animate && !dim && <animate attributeName="r" values="2.6;3.6;2.6" dur={mood === "working" ? "0.7s" : "2.2s"} repeatCount="indefinite" />}
      </circle>
      {/* belly light */}
      <rect x="27" y="50" width="10" height="4" rx="2" fill={status} opacity={dim ? 0.4 : 0.9} />
    </svg>
  );
}
