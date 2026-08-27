/**
 * WHAT: the band of figures under the problem statement — four numbers that count up the first time
 * they scroll into view.
 *
 * WHY THE NUMBERS ARE WHAT THEY ARE. The device this imitates normally carries traction: seats,
 * customers, hours tracked, uptime. `docs/MARKETING_PAGES.md` rules all of that out — "there are no
 * customer counts, revenue figures or logos on these pages, because there are none to cite" — and a
 * made-up 99.9% is exactly the kind of claim that rule exists to stop.
 *
 * So the figures are facts about the PRODUCT, and three of the four are derived from the arrays this
 * page already renders rather than typed in. A capability added to `FEATURES` moves the first number
 * on its own; a connector added to `ConnectorMarquee` moves the second. Neither can drift into a lie,
 * which is the same reasoning the Features heading already uses for its own count.
 *
 * The two small numbers are architecture, not marketing: one database per organisation is what
 * `OrgDatabase` in the control-plane schema actually provisions, and the control plane holds the
 * registry — organisations, their connection, SSO, plan limits — and no application tables at all.
 *
 * REDUCED MOTION: the final values render immediately and nothing counts. A number that animates is
 * a flourish on a fact; the fact is the part that matters.
 */
import { useEffect, useRef, useState } from "react";

interface Stat {
  value: number;
  /** Rendered after the number — "+" on a floor, nothing on an exact count. */
  suffix?: string;
  label: string;
  /** The sentence that makes the number checkable rather than decorative. */
  hint: string;
}

/**
 * Counts from zero to `value` once, the first time the element is on screen.
 *
 * It deliberately does NOT re-run on scroll-back. A number that re-counts every time it passes the
 * viewport turns a fact into a fidget, and on a long page it fires several times per visit.
 */
function useCountUp(value: number, enabled: boolean) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [shown, setShown] = useState(enabled ? 0 : value);

  useEffect(() => {
    if (!enabled) {
      setShown(value);
      return;
    }
    const node = ref.current;
    if (!node) return;

    let frame = 0;
    let started = false;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting || started) return;
        started = true;
        observer.disconnect();
        const duration = 900;
        const begin = performance.now();
        const step = () => {
          const t = Math.min(1, (performance.now() - begin) / duration);
          // Ease out cubic: fast off the mark, settling into the final value rather than stopping
          // dead on it — a linear count reads like a spinner.
          const eased = 1 - (1 - t) ** 3;
          setShown(Math.round(value * eased));
          if (t < 1) frame = requestAnimationFrame(step);
        };
        frame = requestAnimationFrame(step);
      },
      { threshold: 0.4 }
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [value, enabled]);

  return { ref, shown };
}

function StatValue({ stat, animate }: { stat: Stat; animate: boolean }) {
  const { ref, shown } = useCountUp(stat.value, animate);
  // The gradient lives on THIS span, not on the block above it. `bg-clip-text` clips a background
  // painted across the element's own box, so putting it on the full-width <dd> stretched the two
  // stops across the whole column and the centred digits only ever sampled the middle of it — every
  // number came out the same flat blue. Sized to the digits, the sweep is actually visible.
  return (
    <span ref={ref} className="inline-block bg-gradient-to-r from-primary to-info bg-clip-text tabular-nums text-transparent">
      {shown}
      {stat.suffix}
    </span>
  );
}

export function StatBand({ stats }: { stats: Stat[] }) {
  const [animate, setAnimate] = useState(false);

  // Read once on mount rather than at module scope: this is a client-only capability, and reading
  // it during render would make the first paint disagree with the second.
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    setAnimate(!window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }, []);

  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-border bg-border lg:grid-cols-4">
      {stats.map((stat) => (
        <div
          key={stat.label}
          className="group bg-background p-5 text-center transition-colors hover:bg-primary/[0.04] sm:p-6"
        >
          <dd className="text-3xl font-black tracking-tight sm:text-4xl">
            <StatValue stat={stat} animate={animate} />
          </dd>
          <dt className="mt-1.5 text-sm font-semibold">{stat.label}</dt>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{stat.hint}</p>
        </div>
      ))}
    </dl>
  );
}
