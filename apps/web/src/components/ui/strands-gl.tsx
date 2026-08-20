/**
 * WHAT: reactbits' Strands — flowing luminous threads on a WebGL canvas — as the app's "the model
 * is answering" loader. Implemented in-tree per this repo's rule (reactbits patterns are ported
 * against our theme, never vendored as a component dependency); `ogl` is the one runtime dep.
 *
 * WHERE IT SITS IN THE AI GRAMMAR (see index.css's AI effect layer): this is the large-canvas form
 * of `.ai-strand` — "waiting for the answer". The SVG `AiStrands` stays for small inline spots (a
 * dialog row, a card corner); this one earns its GPU on surfaces with room, like the Ask AI page's
 * pending answer. Same meaning, two sizes.
 *
 * WHAT WAS CUT FROM THE UPSTREAM SOURCE, deliberately: the refractive glass-ball mode and its
 * second render pass. Nothing here uses it, and dead uniforms in a shader are dead weight someone
 * eventually "fixes". If a surface ever wants the glass ball, port it then.
 *
 * THEME: the strand colours are read from the live CSS tokens (--primary, --info) at mount and on
 * theme flips, so the canvas matches both themes and any future re-brand without a hardcoded hex.
 * REDUCED MOTION: honoured by not mounting the animation at all — callers render the static SVG
 * fallback instead (see AiLoader below). A loader is pure motion; its reduced form is stillness.
 */
import { Color, Mesh, Program, Renderer, Triangle } from "ogl";
import { useEffect, useRef, useState } from "react";
import { AiStrands } from "./ai-strands";
import "./strands-gl.css";

const MAX_STRANDS = 12;
const MAX_COLORS = 8;

const VERT = `#version 300 es
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const FRAG = `#version 300 es
precision highp float;

uniform float uTime;
uniform vec2 uResolution;
uniform vec3 uColors[${MAX_COLORS}];
uniform int uColorCount;
uniform int uStrandCount;
uniform float uSpeed;
uniform float uAmplitude;
uniform float uWaviness;
uniform float uThickness;
uniform float uGlow;
uniform float uTaper;
uniform float uSpread;
uniform float uIntensity;
uniform float uOpacity;
uniform float uScale;
uniform float uSaturation;

out vec4 fragColor;

const float PI = 3.14159265;

vec3 samplePalette(float t) {
  t = fract(t);
  float scaled = t * float(uColorCount);
  int idx = int(floor(scaled));
  float blend = fract(scaled);
  int nextIdx = idx + 1;
  if (nextIdx >= uColorCount) nextIdx = 0;
  return mix(uColors[idx], uColors[nextIdx], blend);
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
  uv /= max(uScale, 0.0001);

  float e = 0.06 + uIntensity * 0.94;
  float env = pow(max(cos(uv.x * PI * 1.3), 0.0), uTaper);

  vec3 col = vec3(0.0);

  for (int i = 0; i < ${MAX_STRANDS}; i++) {
    if (i >= uStrandCount) break;

    float fi = float(i);
    float ph = fi * 1.7 * uSpread;
    float freq = (2.0 + fi * 0.35) * uWaviness;
    float spd = 1.4 + fi * 1.2;

    float tt = uTime * uSpeed;
    float w = sin(uv.x * freq + tt * spd + ph) * 0.60
            + sin(uv.x * freq * 1.1 - tt * spd * 0.7 + ph * 1.7) * 0.40;

    float amp = (0.1 + 0.02 * e) * env * uAmplitude;
    float y = w * amp;

    float d = abs(uv.y - y);
    float thick = (0.001 + 0.05 * e) * (0.35 + env) * uThickness;
    float g = thick / (d + thick * 0.45);
    g = g * g;

    float h = fi / float(uStrandCount) + uv.x * 0.30 + uTime * 0.04;
    col += samplePalette(h) * g * env;
  }

  col *= 0.45 + 0.7 * e;
  col = 1.0 - exp(-col * uGlow);

  float gray = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = max(mix(vec3(gray), col, uSaturation), 0.0);

  float lum = max(max(col.r, col.g), col.b);
  float alpha = clamp(lum, 0.0, 1.0) * uOpacity;

  fragColor = vec4(col * uOpacity, alpha);
}
`;

/** "173 80% 40%" (a raw HSL token) → "#0d9488"-style hex the shader palette can take. */
function tokenToHex(token: string): string | null {
  const match = token.trim().match(/^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/);
  if (!match) return null;
  const h = Number(match[1]) / 360;
  const s = Number(match[2]) / 100;
  const l = Number(match[3]) / 100;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  const toByte = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${toByte(channel(h + 1 / 3))}${toByte(channel(h))}${toByte(channel(h - 1 / 3))}`;
}

/** The live theme's own hues, read from the tokens the whole app renders from. */
function themePalette(): string[] {
  const style = getComputedStyle(document.documentElement);
  const primary = tokenToHex(style.getPropertyValue("--primary"));
  const info = tokenToHex(style.getPropertyValue("--info"));
  // A mid-lightness fallback pair, only for the first paint before tokens resolve.
  return [primary ?? "#0d9488", info ?? "#0284c7", primary ?? "#0d9488"];
}

const buildPalette = (colors: string[]) => {
  const filled = colors.length ? colors : ["#ffffff"];
  const padded: Array<[number, number, number]> = [];
  for (let i = 0; i < MAX_COLORS; i++) {
    const c = new Color(filled[i] ?? filled[filled.length - 1]);
    padded.push([c.r, c.g, c.b]);
  }
  return padded;
};

export function StrandsGL({ className }: { className?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let renderer: Renderer;
    try {
      renderer = new Renderer({ alpha: true, premultipliedAlpha: true, antialias: true });
    } catch {
      // No WebGL (a locked-down browser, a headless run) — the container simply stays empty and
      // the label beside it still says what is happening. A loader must never be the crash.
      return;
    }
    const gl = renderer.gl;
    gl.clearColor(0, 0, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.canvas.style.backgroundColor = "transparent";

    const geometry = new Triangle(gl);
    if (geometry.attributes.uv) delete geometry.attributes.uv;

    const program = new Program(gl, {
      vertex: VERT,
      fragment: FRAG,
      uniforms: {
        uTime: { value: 0 },
        uResolution: { value: [container.offsetWidth, container.offsetHeight] },
        uColors: { value: buildPalette(themePalette()) },
        uColorCount: { value: 3 },
        uStrandCount: { value: 4 },
        uSpeed: { value: 0.8 },
        uAmplitude: { value: 1 },
        uWaviness: { value: 1 },
        uThickness: { value: 0.7 },
        uGlow: { value: 2.4 },
        uTaper: { value: 3 },
        uSpread: { value: 1 },
        uIntensity: { value: 0.55 },
        uOpacity: { value: 1 },
        uScale: { value: 1.4 },
        uSaturation: { value: 1.3 }
      }
    });

    const mesh = new Mesh(gl, { geometry, program });
    container.appendChild(gl.canvas);

    const resize = () => {
      renderer.setSize(container.offsetWidth, container.offsetHeight);
      program.uniforms.uResolution.value = [container.offsetWidth, container.offsetHeight];
    };
    window.addEventListener("resize", resize);
    resize();

    // Theme flips swap the tokens under us; watching the root's class/attr keeps the canvas on
    // palette without a re-mount.
    const observer = new MutationObserver(() => {
      program.uniforms.uColors.value = buildPalette(themePalette());
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });

    let frame = 0;
    const update = (t: number) => {
      frame = requestAnimationFrame(update);
      program.uniforms.uTime.value = t * 0.001;
      renderer.render({ scene: mesh });
    };
    frame = requestAnimationFrame(update);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", resize);
      if (gl.canvas.parentNode === container) container.removeChild(gl.canvas);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, []);

  return <div ref={containerRef} className={`strands-gl ${className ?? ""}`} aria-hidden />;
}

/** Honours the OS setting, and keeps honouring it if it changes mid-session. */
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

/**
 * The loader surfaces actually mount: the GL strands where motion is welcome, the quiet SVG where
 * it is not. A loader is pure motion, so its reduced-motion form is stillness — not a slower
 * animation, and never a canvas burning a GPU for someone who asked things to hold still.
 */
export function AiLoader({ label, className }: { label: string; className?: string }) {
  const reduced = usePrefersReducedMotion();
  if (reduced) return <AiStrands label={label} className={className} />;
  return (
    <div className={`grid gap-1 ${className ?? ""}`}>
      <StrandsGL className="h-16" />
      <p className="text-center text-xs text-muted-foreground" role="status">
        {label}
      </p>
    </div>
  );
}
