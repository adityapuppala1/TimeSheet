/**
 * Types shared between the React shell (AgentStudio.tsx) and the three.js scene (engine.ts), kept in a
 * file with NO runtime and no three.js import so the shell can use them without pulling the 3D chunk
 * into the default bundle — a type-only import is erased at build time.
 */
import type { Archetype, Mood } from "../studio-model";

/** What the stage needs to know about one agent: who it is, what it looks like, what it is doing. */
export interface StudioAgent {
  id: string;
  name: string;
  emoji: string;
  archetype: Archetype;
  /** Index into AGENT_PALETTE. */
  tint: number;
  mood: Mood;
  /** The viewer pressed "Watch it work". `mood` is already "working"; this lets the HUD say it is a preview. */
  previewing: boolean;
}

export type StudioTheme = "light" | "dark";

/** Everything the scene tells the page. All optional-by-design: the page works without any of them. */
export interface StudioEvents {
  /** The pointer is over an agent's station (or left it). Coordinates are canvas-relative pixels. */
  onHover(id: string | null, x: number, y: number): void;
  /** A station was clicked (or empty floor, which clears the selection). */
  onSelect(id: string | null): void;
  /** The caption of what a station's simulation is illustrating right now, for the HUD. */
  onCaption(id: string, text: string): void;
  /** The GL context was lost; the page falls back to the 2D view. */
  onLost(): void;
}

export interface StudioHandle {
  setAgents(agents: readonly StudioAgent[]): void;
  select(id: string | null): void;
  setTheme(theme: StudioTheme): void;
  destroy(): void;
}
