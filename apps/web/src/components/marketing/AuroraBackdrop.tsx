/**
 * WHAT: the landing hero's living backdrop — a slow aurora of the brand hues, drifting on a WebGL
 * canvas and leaning gently toward the pointer.
 *
 * WHY `ogl` AND NOT three.js: the same reason `docs/MARKETING_PAGES.md` gives for the login
 * panel's constellation — three.js is roughly 600KB for what is decoratively a moving gradient,
 * and it would be the heaviest thing on the one page a first-time visitor waits for. `ogl` is
 * already this repo's WebGL dependency (see `strands.tsx`), and the whole shader below is under
 * 2KB. The visual result is the thing that was asked for; the payload is not.
 *
 * WHY A SHADER AND NOT A CSS GRADIENT: the hero already had two blurred orbs, and a static
 * `blur-3xl` cannot do the two things that make this read as alive — domain-warped noise, so the
 * bands fold into each other instead of sliding past, and a response to the pointer. Both are a
 * handful of instructions on the GPU and neither is expressible in CSS.
 *
 * THEME: both colours are read from the live `--primary` / `--info` tokens at mount and
 * again on a theme flip, so this follows dark mode and any future re-brand without a hex in sight.
 *
 * REDUCED MOTION: the canvas is not mounted at all. A drifting backdrop is pure motion, so its
 * reduced form is stillness — the section keeps the CSS orbs underneath it and looks deliberate
 * rather than broken. Same call `AiLoader` makes, for the same reason.
 *
 * IT IS DECORATION, AND THE PAGE MUST NOT NEED IT. `aria-hidden`, no content of its own, and every
 * failure path (no WebGL, a lost context, a hidden tab) leaves the hero exactly as readable as it
 * was. It also stops rendering entirely once scrolled out of view — a GPU loop running behind a
 * FAQ nobody can see it through is a battery cost with no viewer.
 */
import { Color, Mesh, Program, Renderer, Triangle } from "ogl";
import { useEffect, useRef, useState } from "react";

const VERT = `#version 300 es
in vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }`;

/**
 * Domain-warped value noise. The warp — sampling the field at coordinates that are themselves
 * noise — is what turns flat bands into something that folds; it is the entire difference between
 * this and a CSS gradient that happens to move.
 *
 * NO BACKTICKS AND NO ${} BELOW. This is GLSL inside a JS template literal, so a backtick in a
 * shader comment closes the string and the file stops parsing — with the error pointing at the
 * comment rather than at anything to do with the shader.
 */
const FRAG = `#version 300 es
precision highp float;

uniform vec2  uResolution;
uniform float uTime;
uniform vec2  uPointer;
uniform vec3  uPrimary;
uniform vec3  uInfo;
uniform float uIntensity;

out vec4 fragColor;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  // Smoothstep the cell interpolation, or the field shows its grid as visible diamonds.
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm(vec2 p) {
  float total = 0.0;
  float amplitude = 0.5;
  // Four octaves. Three reads as noticeably banded at this scale and five costs fill rate nobody
  // can see on a backdrop this soft.
  for (int i = 0; i < 4; i++) {
    total += amplitude * noise(p);
    p *= 2.02;
    amplitude *= 0.5;
  }
  return total;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution.xy;
  // Aspect-corrected so the bands do not stretch into stripes on a wide monitor.
  vec2 p = (gl_FragCoord.xy - 0.5 * uResolution.xy) / uResolution.y;

  float t = uTime * 0.045;

  // The pointer moves the FIELD, not the camera — a parallax layer that slides is a cheap trick
  // people notice; a field that bends toward you is one they only feel.
  vec2 lean = uPointer * 0.14;

  vec2 warp = vec2(fbm(p * 1.6 + vec2(t, -t * 0.7)), fbm(p * 1.6 + vec2(-t * 0.9, t * 1.1)));
  float field = fbm(p * 1.15 + warp * 0.9 + lean);

  // Two bands with different phases, so the hues cross rather than move as one sheet.
  //
  // These thresholds are MEASURED, not chosen. Four octaves of value noise at amplitudes
  // 0.5/0.25/0.125/0.0625 sum to at most 0.9375 and sit around 0.46 on average, so the obvious
  // 0.3–0.8 window lights roughly a third of the field and the backdrop came out at about 9%
  // alpha — invisible against a white page. The window has to straddle the field's actual mean.
  float bandA = smoothstep(0.14, 0.62, field);
  float bandB = smoothstep(0.26, 0.80, fbm(p * 1.4 - warp * 0.6 + lean * 1.4 + vec2(0.0, t * 0.6)));

  // A third band of PRIMARY at a coarser scale, not of a third hue. Two attempts at a third colour
  // were rendered and rejected: the accent is amber, amber is near-complementary to the teal, and
  // at backdrop alpha over a near-white page every overlap of the two landed on khaki. What the
  // aurora needed was not another hue but another SCALE — a slow, wide swell under the two fast
  // bands, which is what gives it depth without ever leaving the brand's two stops.
  float swell = smoothstep(0.30, 0.86, fbm(p * 0.55 + warp * 0.5 - lean + vec2(t * 0.35, 0.0)));

  // WEIGHTED HUES, NOT CHAINED MIXES. mix(mix(a, b), c) desaturates every overlap toward grey.
  // Weighting each hue and normalising keeps a region that is mostly one band that band's real
  // colour, so the teal stays teal instead of drifting to slate wherever the bands cross.
  float wPrimary = bandA * 0.60 + swell * 0.26;
  float wInfo    = bandB * 0.52;
  float weight   = wPrimary + wInfo;
  vec3 colour = (uPrimary * wPrimary + uInfo * wInfo) / max(weight, 0.0001);

  // Falls off toward the edges so the canvas has no seam against the page, and toward the bottom
  // so the section hands over to the screenshot below it rather than stopping.
  float vignette = smoothstep(1.25, 0.20, length(p * vec2(0.62, 1.0)));
  float fade = smoothstep(0.0, 0.62, uv.y);

  // QUIET GROUND FOR THE COPY. The headline and sub-copy sit dead centre, and 40%-alpha colour
  // behind body text is where a hero starts costing contrast. This pulls the aurora down to about
  // half strength across the middle and lets it run at full toward the edges — which also gives
  // the light-around-the-words look the effect is for.
  float calm = mix(0.48, 1.0, smoothstep(0.0, 0.80, length(p * vec2(0.72, 1.30))));

  float alpha = weight * vignette * fade * calm * uIntensity;
  fragColor = vec4(colour, clamp(alpha, 0.0, 1.0));
}`;

/** Reads an HSL triple out of a CSS custom property and hands back 0–1 RGB for the shader. */
function tokenColour(name: string, fallback: string): Color {
  if (typeof window === "undefined") return new Color(fallback);
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  // Tokens are stored as bare `H S% L%`, which `Color` cannot parse — wrap it into real CSS and
  // let the browser do the conversion rather than hand-rolling HSL→RGB.
  if (!raw) return new Color(fallback);
  const probe = document.createElement("span");
  probe.style.color = `hsl(${raw})`;
  document.body.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(computed);
  if (!match) return new Color(fallback);
  return new Color(Number(match[1]) / 255, Number(match[2]) / 255, Number(match[3]) / 255);
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)").matches : false
  );
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

export function AuroraBackdrop({ className, intensity = 1 }: { className?: string; intensity?: number }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    const container = containerRef.current;
    if (reduced || !container) return;

    let renderer: Renderer;
    try {
      renderer = new Renderer({ alpha: true, antialias: false, dpr: Math.min(window.devicePixelRatio || 1, 2) });
    } catch {
      // No WebGL, a blocked context, a headless browser. The hero is fully readable without this.
      return;
    }

    const gl = renderer.gl;
    gl.clearColor(0, 0, 0, 0);
    container.appendChild(gl.canvas);
    gl.canvas.style.width = "100%";
    gl.canvas.style.height = "100%";
    gl.canvas.style.display = "block";

    const program = new Program(gl, {
      vertex: VERT,
      fragment: FRAG,
      transparent: true,
      uniforms: {
        uResolution: { value: [1, 1] },
        uTime: { value: 0 },
        uPointer: { value: [0, 0] },
        uPrimary: { value: tokenColour("--primary", "#0F9AA8") },
        uInfo: { value: tokenColour("--info", "#2563EB") },
        uIntensity: { value: intensity }
      }
    });
    const mesh = new Mesh(gl, { geometry: new Triangle(gl), program });

    const resize = () => {
      const { clientWidth, clientHeight } = container;
      renderer.setSize(clientWidth || 1, clientHeight || 1);
      program.uniforms.uResolution.value = [gl.canvas.width, gl.canvas.height];
    };
    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);

    // Pointer is eased rather than followed. A backdrop that snaps to the cursor is a toy; one
    // that drifts after it is atmosphere.
    const target = { x: 0, y: 0 };
    const current = { x: 0, y: 0 };
    const onPointerMove = (event: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      target.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      target.y = ((event.clientY - rect.top) / rect.height) * 2 - 1;
    };
    window.addEventListener("pointermove", onPointerMove, { passive: true });

    // Only render while the backdrop is actually on screen. A GPU loop behind three sections of
    // page is a battery cost with no viewer.
    let visible = true;
    const visibility = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
    });
    visibility.observe(container);

    // Theme flips swap every token, so the shader's colours are re-read rather than frozen at mount.
    const themeObserver = new MutationObserver(() => {
      program.uniforms.uPrimary.value = tokenColour("--primary", "#0F9AA8");
      program.uniforms.uInfo.value = tokenColour("--info", "#2563EB");
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });

    let frame = 0;
    const start = performance.now();
    const loop = () => {
      frame = requestAnimationFrame(loop);
      if (!visible || document.hidden) return;
      current.x += (target.x - current.x) * 0.035;
      current.y += (target.y - current.y) * 0.035;
      program.uniforms.uPointer.value = [current.x, current.y];
      program.uniforms.uTime.value = (performance.now() - start) / 1000;
      renderer.render({ scene: mesh });
    };
    frame = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onPointerMove);
      resizeObserver.disconnect();
      visibility.disconnect();
      themeObserver.disconnect();
      gl.canvas.remove();
      // Free the context explicitly. Browsers cap how many live WebGL contexts a page may hold,
      // and a route the visitor can re-enter would otherwise leak one each time.
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, [reduced, intensity]);

  return <div ref={containerRef} className={className} aria-hidden />;
}
