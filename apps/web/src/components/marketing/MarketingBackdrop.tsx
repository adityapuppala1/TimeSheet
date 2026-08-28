/**
 * The sign-in page's three.js lattice, reused as the standing background of the marketing pages.
 *
 * WHY THE SAME SCENE and not a second one: it is the product's visual signature, it already reads
 * `--primary`/`--info` from the theme, and — the part that actually matters — `AuthScene` already
 * carries the whole cost argument. It dynamic-imports three.js inside an effect, only after a
 * desktop-width check and a reduced-motion check both pass, and it disposes every geometry,
 * material and the WebGL context on unmount. A phone still never downloads three.js from these
 * pages; a reduced-motion visitor never downloads it either. Writing a second scene would have
 * meant re-deriving all of that and getting some of it wrong.
 *
 * LAYERING, WHICH IS THE ONLY TRICKY PART. `-z-10` is a trap in this codebase and has already cost
 * a day: a negative z-index resolves against the nearest stacking context, so a `-z-10` child of a
 * plain `<div className="bg-background">` paints BEHIND that background and disappears entirely —
 * which is exactly how the landing hero's aurora and two blurred orbs were invisible for months
 * while looking perfectly correct in the source.
 *
 * So this uses z-0 rather than a negative index, and the pages give `<main>` and `<footer>` a
 * `relative z-10`. The order is then: the root's own `bg-background`, this scene above it, the
 * content above that. Sections carrying their own opaque background hide the scene in those bands
 * and reveal it between — which is the intended rhythm, not an accident.
 *
 * IT IS DELIBERATELY FAINT. This sits behind body copy on a page whose job is to be read, in both
 * themes, and a backdrop that competes with the text has failed at being a backdrop. Dark gets more
 * of it because the lattice is drawn in light strokes that a dark ground can afford.
 */
import { AuthScene } from "./AuthScene";

export function MarketingBackdrop() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-0 opacity-[0.10] dark:opacity-[0.22] print:hidden"
    >
      <AuthScene className="h-full w-full" />
    </div>
  );
}
