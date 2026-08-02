/**
 * A browser-chrome frame around a product screenshot.
 *
 * WHY the chrome: a raw PNG of a web app floating on a marketing page reads as a mockup. The
 * window bar tells a visitor at a glance that this is the real running product, which is the
 * entire claim the screenshot is there to make.
 *
 * The images come from tests/e2e/screenshots.spec.ts, which re-shoots them from the live app —
 * so they can't quietly drift into advertising a screen that no longer exists.
 */
import { cn } from "../../lib/utils";

/** Widths emitted by the capture spec. Kept in step with `VARIANT_WIDTHS` there. */
const VARIANT_WIDTHS = [480, 800, 1280];

/** `/product/tickets.png` → `/product/tickets-480.webp 480w, …`. Derived rather than listed per
 *  call site so adding a screenshot needs no change here. */
function buildSrcSet(src: string): string {
  const base = src.replace(/\.png$/, "");
  return VARIANT_WIDTHS.map((width) => `${base}-${width}.webp ${width}w`).join(", ");
}

export function ScreenshotFrame({
  src,
  alt,
  caption,
  className,
  priority = false
}: {
  src: string;
  alt: string;
  caption?: string;
  className?: string;
  /** The hero shot should not lazy-load — it's above the fold and would pop in visibly. */
  priority?: boolean;
}) {
  return (
    <figure className={cn("group", className)}>
      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-2xl shadow-primary/5 ring-1 ring-black/5 dark:ring-white/5">
        {/* Window bar. Purely decorative, so it's hidden from assistive tech — a screen reader
            announcing "three circles" before every screenshot is noise. */}
        <div aria-hidden className="flex items-center gap-1.5 border-b border-border bg-muted/60 px-3 py-2">
          <span className="h-2.5 w-2.5 rounded-full bg-destructive/60" />
          <span className="h-2.5 w-2.5 rounded-full bg-warning/60" />
          <span className="h-2.5 w-2.5 rounded-full bg-success/60" />
          <span className="ml-2 hidden h-4 flex-1 rounded bg-background/70 sm:block" />
        </div>
        {/* WebP variants first, PNG as the `src` fallback. A phone was otherwise downloading and
            decoding the full 1920px capture to paint it ~350px wide. `sizes` describes the real
            layout — full-bleed in the hero, roughly 60% of a wide viewport in the tour — so the
            browser picks the smallest file that still looks sharp. Variants are produced by
            tests/e2e/screenshots.spec.ts alongside the PNG. */}
        <picture>
          <source type="image/webp" srcSet={buildSrcSet(src)} sizes="(min-width: 1024px) 60vw, 100vw" />
          <img
            src={src}
            alt={alt}
            loading={priority ? "eager" : "lazy"}
            decoding="async"
            // Intrinsic size of the captured viewport. Declaring it reserves the right space
            // before the image loads, so the page doesn't reflow around it.
            width={1920}
            height={1080}
            className="block w-full"
          />
        </picture>
      </div>
      {caption && <figcaption className="mt-3 text-center text-sm text-muted-foreground">{caption}</figcaption>}
    </figure>
  );
}
