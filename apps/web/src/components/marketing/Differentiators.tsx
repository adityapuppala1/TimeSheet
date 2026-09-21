/**
 * "Why it stands out": the six claims the pitch deck was built on, on the front page.
 *
 * THE CLAIMS ARE THE PITCH DECK'S, not new copy. `MOATS` in PitchDeck.tsx was written clause by
 * clause against shipped code and is guarded by the export test; this band renders the same list,
 * so a claim cannot appear here that has not already survived that review. Adding a seventh means
 * adding it there first.
 *
 * THE DEPTH IS CSS, NOT A LIBRARY. Each card tilts toward the pointer with a light that follows it —
 * `perspective` plus two rotations, driven by pointer position written into custom properties. It
 * runs only for a fine pointer (a finger has no hover and would get a card that lurches on tap) and
 * only when the reader has not asked for reduced motion. Under either, the card is still a card:
 * nothing is communicated by the tilt that is not also in the text.
 */
import { useRef, type PointerEvent } from "react";
import type { LucideIcon } from "lucide-react";
import { Reveal } from "./Reveal";
import { cn } from "../../lib/utils";

export interface Differentiator {
  icon: LucideIcon;
  title: string;
  body: string;
}

export function Differentiators({ items, className }: { items: Differentiator[]; className?: string }) {
  return (
    <div className={cn("grid gap-4 sm:grid-cols-2 lg:grid-cols-3", className)} data-differentiators>
      {items.map((item, index) => (
        <Reveal key={item.title} delay={index * 70}>
          <TiltCard item={item} />
        </Reveal>
      ))}
    </div>
  );
}

const MAX_TILT_DEG = 7;

function TiltCard({ item }: { item: Differentiator }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const Icon = item.icon;

  const onMove = (event: PointerEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el || event.pointerType !== "mouse") return;
    const rect = el.getBoundingClientRect();
    const px = (event.clientX - rect.left) / rect.width;
    const py = (event.clientY - rect.top) / rect.height;
    // Rotate away from the pointer on X and toward it on Y, which is what a card on a table does
    // when you press one corner.
    el.style.setProperty("--tilt-x", `${((0.5 - py) * MAX_TILT_DEG * 2).toFixed(2)}deg`);
    el.style.setProperty("--tilt-y", `${((px - 0.5) * MAX_TILT_DEG * 2).toFixed(2)}deg`);
    el.style.setProperty("--light-x", `${(px * 100).toFixed(1)}%`);
    el.style.setProperty("--light-y", `${(py * 100).toFixed(1)}%`);
  };
  const onLeave = () => {
    const el = ref.current;
    if (!el) return;
    el.style.setProperty("--tilt-x", "0deg");
    el.style.setProperty("--tilt-y", "0deg");
  };

  return (
    <div
      ref={ref}
      onPointerMove={onMove}
      onPointerLeave={onLeave}
      className="tilt-card group relative h-full rounded-2xl border border-border bg-card/80 p-5 shadow-soft backdrop-blur"
      data-tilt-card
    >
      {/* The light that follows the pointer. Invisible until hover so the resting card is calm. */}
      <span aria-hidden className="tilt-light pointer-events-none absolute inset-0 rounded-2xl opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
      <span className="relative mb-4 grid h-11 w-11 place-items-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/20">
        <Icon className="h-5 w-5" aria-hidden />
      </span>
      <h3 className="relative text-base font-bold leading-snug">{item.title}</h3>
      <p className="relative mt-2 text-sm leading-6 text-muted-foreground">{item.body}</p>
    </div>
  );
}
