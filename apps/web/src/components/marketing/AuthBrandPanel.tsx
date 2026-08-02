/**
 * The visual half of the split sign-in screen.
 *
 * WHY A CANVAS INSTEAD OF A LIBRARY: the brief asked for a React-Bits / three.js style animated
 * panel. three.js is ~600KB for what is decoratively a moving gradient behind some dots — on a
 * page whose entire job is to accept two form fields quickly, that trade is bad. This is ~80 lines
 * of 2D canvas with no dependency, and it renders the same idea: a drifting constellation whose
 * nodes link up as they approach, standing in for work items connecting into a system.
 *
 * THREE THINGS THAT MATTER MORE THAN THE EFFECT:
 *  1. `prefers-reduced-motion` is honoured — the animation never starts, and a static gradient is
 *     shown instead. Motion sickness is not a styling preference.
 *  2. The loop is torn down on unmount, so navigating to the app doesn't leave a rAF running.
 *  3. It's `aria-hidden` and the panel is hidden below `lg`, so it costs nothing on a phone and
 *     says nothing to a screen reader.
 */
import { useEffect, useRef } from "react";
import { CheckCircle2, ScanFace, ShieldCheck, Sparkles } from "lucide-react";

/** Node count is deliberately modest — this runs behind a login form, not a demo reel. */
const NODE_COUNT = 44;
const LINK_DISTANCE = 132;

interface Node {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

function ConstellationCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Checked once at mount rather than watched: someone flipping this OS setting mid-login is not
    // a case worth the listener, and re-mounting picks up the new value anyway.
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let frame = 0;
    let nodes: Node[] = [];
    // Cap the device pixel ratio: a 3x retina panel costs 9x the fill rate for no visible gain
    // on a background this soft.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const resize = () => {
      const { width, height } = canvas.getBoundingClientRect();
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      nodes = Array.from({ length: NODE_COUNT }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        // Slow enough to read as ambient drift rather than motion demanding attention.
        vx: (Math.random() - 0.5) * 0.28,
        vy: (Math.random() - 0.5) * 0.28
      }));
    };

    const draw = () => {
      const { width, height } = canvas.getBoundingClientRect();
      ctx.clearRect(0, 0, width, height);

      for (const node of nodes) {
        node.x += node.vx;
        node.y += node.vy;
        // Bounce rather than wrap: a node teleporting across the panel is visibly jarring, while
        // a bounce reads as contained movement.
        if (node.x < 0 || node.x > width) node.vx *= -1;
        if (node.y < 0 || node.y > height) node.vy *= -1;
      }

      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[i].x - nodes[j].x;
          const dy = nodes[i].y - nodes[j].y;
          const distance = Math.hypot(dx, dy);
          if (distance > LINK_DISTANCE) continue;
          // Fade the link out as the pair separates, so connections dissolve instead of blinking off.
          ctx.strokeStyle = `rgba(255,255,255,${(1 - distance / LINK_DISTANCE) * 0.16})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(nodes[i].x, nodes[i].y);
          ctx.lineTo(nodes[j].x, nodes[j].y);
          ctx.stroke();
        }
      }

      ctx.fillStyle = "rgba(255,255,255,0.55)";
      for (const node of nodes) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, 1.6, 0, Math.PI * 2);
        ctx.fill();
      }

      frame = requestAnimationFrame(draw);
    };

    resize();
    frame = requestAnimationFrame(draw);
    window.addEventListener("resize", resize);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return <canvas ref={canvasRef} aria-hidden className="absolute inset-0 h-full w-full" />;
}

const PROOF = [
  { icon: ShieldCheck, text: "Rotating sessions, per-device revocation, AES-256 secrets at rest" },
  { icon: Sparkles, text: "AI stays off until you switch it on — with your key, under your budget" },
  { icon: ScanFace, text: "Optional identity checks that never send a face off your server" }
];

export function AuthBrandPanel() {
  return (
    // Hidden below lg: on a phone the form should own the whole screen, and there's no point
    // paying for a canvas nobody sees.
    <aside className="relative hidden overflow-hidden bg-gradient-to-br from-primary via-info to-accent lg:block">
      <ConstellationCanvas />
      {/* Darkening wash so white text stays legible wherever the gradient runs light. */}
      <div aria-hidden className="absolute inset-0 bg-slate-950/25" />

      <div className="relative flex h-full flex-col justify-between p-10 text-white xl:p-14">
        <div className="flex items-center gap-3 font-bold">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-white/15 backdrop-blur">T</span>
          <div className="leading-tight">
            <p>TimeSphere</p>
            <p className="text-xs font-medium opacity-70">Enterprise timesheets &amp; ticketing</p>
          </div>
        </div>

        <div className="max-w-md">
          <h2 className="text-3xl font-black leading-tight tracking-tight xl:text-4xl">
            The hours, the tickets, and the proof — in one place.
          </h2>
          <p className="mt-4 text-sm leading-7 opacity-85">
            Log time against real work, let SLAs escalate themselves, and hand a client a signed record of what was
            actually delivered.
          </p>

          <ul className="mt-8 grid gap-3">
            {PROOF.map((item) => (
              <li key={item.text} className="flex items-start gap-3 text-sm opacity-90">
                <item.icon className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{item.text}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs opacity-80">
          <span className="inline-flex items-center gap-1.5">
            <CheckCircle2 className="h-3.5 w-3.5" />A database per organization
          </span>
          <span className="inline-flex items-center gap-1.5">
            <CheckCircle2 className="h-3.5 w-3.5" />Tamper-evident audit log
          </span>
        </div>
      </div>
    </aside>
  );
}
