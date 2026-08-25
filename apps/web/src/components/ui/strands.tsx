import { useEffect, useRef } from "react";

import { cn } from "../../lib/utils";

/**
 * WHAT: the flowing-strands background used by the app-wide loader — a full-viewport fragment
 * shader drawing `count` glowing sine ribbons that drift and interfere.
 *
 * WHY IT IS WRITTEN HERE RATHER THAN INSTALLED: the React Bits original is built on `ogl`, and for
 * a single full-screen quad `ogl` abstracts almost nothing — one buffer, one program, one draw
 * call, which is what this file is. Taking a WebGL runtime into the dependency tree to avoid
 * thirty lines of setup is a poor trade in a codebase whose supply chain we audit, and the loader
 * is the one component that renders on EVERY route transition, so its cost is paid constantly.
 * The prop API is kept identical to the original so the documented presets transfer unchanged.
 *
 * ── THREE THINGS THIS HAS TO GET RIGHT, BECAUSE IT IS A LOADER ────────────────────────────────
 *
 * 1. IT MUST NEVER BE THE REASON A PAGE FAILS. Every WebGL step is checked and any failure returns
 *    quietly, leaving the caller's own fallback visible. A machine with no GPU, a blocked context,
 *    or a browser that refuses a second context still gets a working app — see `AppLoader`, which
 *    paints a CSS gradient underneath this canvas rather than relying on it.
 *
 * 2. IT MUST STOP. A loader outlives its usefulness the moment content arrives, and an
 *    unreferenced `requestAnimationFrame` loop keeps a GPU busy on a laptop battery. The effect
 *    cancels the frame and deletes its GL objects on unmount. It does NOT force the context away
 *    — see the cleanup, where doing so is what made this render nothing at all under StrictMode.
 *
 * 3. IT MUST RESPECT `prefers-reduced-motion`. Flowing, undulating motion across a whole viewport
 *    is exactly what that setting is for. Reduced motion renders ONE still frame — the strands are
 *    still drawn, they simply do not move — rather than hiding the visual entirely.
 *
 * WHO calls this: components/ui/app-loader.tsx. Nothing else should — a second live WebGL context
 * competing with the face-verification models is not worth a decoration.
 */

export interface StrandsProps {
  /** Ribbon colours, cycled across `count`. Any CSS-parseable hex. */
  colors?: string[];
  /** How many ribbons. Clamped to MAX_STRANDS. */
  count?: number;
  speed?: number;
  amplitude?: number;
  waviness?: number;
  thickness?: number;
  glow?: number;
  taper?: number;
  spread?: number;
  intensity?: number;
  saturation?: number;
  opacity?: number;
  scale?: number;
  className?: string;
  style?: React.CSSProperties;
}

/** Matches the original's ceiling; the uniform arrays below are sized to it. */
const MAX_STRANDS = 12;

const VERTEX_SHADER = `#version 300 es
in vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }`;

/**
 * Each strand is a horizontal sine ribbon; a pixel's brightness is its distance from that curve,
 * shaped by `thickness` and `glow`. `taper` fades the ends so ribbons do not stop dead at the
 * viewport edge, and `intensity` is the final exposure applied before the tone curve.
 *
 * Accumulated ADDITIVELY, which is why overlaps brighten into white — that interference is the
 * effect, not an artefact to correct.
 */
const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform vec2  uResolution;
uniform float uTime;
uniform int   uCount;
uniform vec3  uColors[${MAX_STRANDS}];
uniform float uAmplitude;
uniform float uWaviness;
uniform float uThickness;
uniform float uGlow;
uniform float uTaper;
uniform float uSpread;
uniform float uIntensity;
uniform float uSaturation;
uniform float uOpacity;
uniform float uScale;

out vec4 fragColor;

vec3 saturate3(vec3 c, float s) {
  // Rec. 709 luma, so desaturating keeps perceived brightness rather than dimming reds.
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  return mix(vec3(l), c, s);
}

void main() {
  // Aspect-corrected, origin at centre: strands stay the same shape on a phone and a 4K monitor.
  vec2 uv = (gl_FragCoord.xy * 2.0 - uResolution) / uResolution.y;
  uv /= max(uScale, 0.001);

  vec3 total = vec3(0.0);
  int count = int(min(float(uCount), float(${MAX_STRANDS})));

  for (int i = 0; i < ${MAX_STRANDS}; i++) {
    if (i >= count) break;
    float fi = float(i);

    // Spread the ribbons vertically around the centre and give each its own phase, so they drift
    // in and out of alignment instead of moving as one rigid comb.
    float offset = (fi - (float(count) - 1.0) * 0.5) * uSpread * 0.22;
    float phase  = fi * 1.7;

    // The multipliers here are the mapping from the documented prop range onto this viewport,
    // and they are tuned, not arbitrary. At 1:1 the published defaults (waviness 1.5, amplitude
    // 0.8) put barely half a wavelength across the width and swung each ribbon clear off the top
    // and bottom — the result read as three huge diagonal sweeps rather than a flowing bundle.
    // 2.2x on the frequency gives roughly two crests across a desktop width; 0.42x on the swing
    // keeps the ribbons inside the frame so they overlap and interfere, which is the effect.
    float x = uv.x * uWaviness * 2.2;
    float wave =
        sin(x + uTime + phase) * uAmplitude * 0.42
      + sin(x * 1.9 + uTime * 0.7 + phase * 1.3) * uAmplitude * 0.15;

    float dist = abs(uv.y - offset - wave);

    // Thin core, wide falloff: the core is the ribbon, the falloff is the glow around it.
    float core = uThickness * 0.06 + 0.004;
    float line = core / (dist + core);
    line = pow(line, max(uGlow, 0.1));

    // Ends fade rather than being clipped by the viewport edge.
    // Normalised against the visible half-width rather than raw uv, so uTaper behaves the same
    // on a phone and an ultrawide instead of being effectively off on one of them.
    float taper = 1.0 - smoothstep(0.55, 1.0, abs(uv.x) / max(uTaper * 0.5, 0.001));

    total += uColors[i] * line * max(taper, 0.0);
  }

  vec3 color = saturate3(total * uIntensity, uSaturation);
  // Reinhard rather than a hard clamp: overlaps roll off into white instead of flat-topping into
  // a posterised blob.
  color = color / (1.0 + color);

  // Premultiplied: the canvas composites over whatever the loader painted beneath it, and
  // straight alpha would fringe dark at the ribbon edges.
  float a = clamp(max(max(color.r, color.g), color.b), 0.0, 1.0) * uOpacity;
  fragColor = vec4(color * uOpacity, a);
}`;

/** `#RGB` / `#RRGGBB` -> linear-ish 0..1 triple. Unparseable input falls back to white, which is
 *  visible rather than an invisible strand somebody would have to debug. */
function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.trim().replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  if (full.length !== 6 || /[^0-9a-f]/i.test(full)) return [1, 1, 1];
  return [
    parseInt(full.slice(0, 2), 16) / 255,
    parseInt(full.slice(2, 4), 16) / 255,
    parseInt(full.slice(4, 6), 16) / 255
  ];
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    // Logged, not thrown: a shader that will not compile on some driver must degrade to the
    // caller's fallback, never take the route transition down with it.
    console.warn("[strands] shader did not compile:", gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export function Strands({
  colors = ["#F97316", "#7C3AED", "#06B6D4"],
  count = 5,
  speed = 0.9,
  amplitude = 0.8,
  waviness = 1.5,
  thickness = 0.5,
  glow = 2.6,
  taper = 3.5,
  spread = 1.5,
  intensity = 0.65,
  saturation = 1.5,
  opacity = 1,
  scale = 1.4,
  className,
  style
}: StrandsProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Live props read by the render loop, so a prop change does not tear down the GL context and
  // rebuild the program — it just changes what the next frame uploads.
  const props = useRef({ colors, count, speed, amplitude, waviness, thickness, glow, taper, spread, intensity, saturation, opacity, scale });
  props.current = { colors, count, speed, amplitude, waviness, thickness, glow, taper, spread, intensity, saturation, opacity, scale };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false });
    if (!gl) return; // No WebGL2 — the caller's own background stays visible. See the header.

    const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    if (!vs || !fs) return;

    const program = gl.createProgram();
    if (!program) return;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.warn("[strands] program did not link:", gl.getProgramInfoLog(program));
      return;
    }
    gl.useProgram(program);

    // One triangle larger than the viewport, not two for a quad: it covers the same pixels with
    // no seam down the diagonal and one fewer vertex to interpolate across.
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const u = (name: string) => gl.getUniformLocation(program, name);
    const uniforms = {
      resolution: u("uResolution"),
      time: u("uTime"),
      count: u("uCount"),
      colors: u("uColors"),
      amplitude: u("uAmplitude"),
      waviness: u("uWaviness"),
      thickness: u("uThickness"),
      glow: u("uGlow"),
      taper: u("uTaper"),
      spread: u("uSpread"),
      intensity: u("uIntensity"),
      saturation: u("uSaturation"),
      opacity: u("uOpacity"),
      scale: u("uScale")
    };

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const resize = () => {
      // Capped at 2x: beyond that a full-viewport shader costs four times the fill rate for a
      // difference nobody can see on a loader that shows for a few hundred milliseconds.
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      const height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        gl.viewport(0, 0, width, height);
      }
    };

    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    let frame = 0;
    const start = performance.now();

    const draw = (now: number) => {
      resize();
      const p = props.current;

      // Frozen at a non-zero time under reduced motion: t=0 puts every strand at the same phase,
      // which draws a flat comb rather than the effect.
      const t = reduceMotion ? 2.5 : ((now - start) / 1000) * p.speed;

      const palette = new Float32Array(MAX_STRANDS * 3);
      const strandCount = Math.max(1, Math.min(p.count, MAX_STRANDS));
      for (let i = 0; i < strandCount; i++) {
        const [r, g, b] = hexToRgb(p.colors[i % p.colors.length] ?? "#ffffff");
        palette[i * 3] = r;
        palette[i * 3 + 1] = g;
        palette[i * 3 + 2] = b;
      }

      gl.uniform2f(uniforms.resolution, canvas.width, canvas.height);
      gl.uniform1f(uniforms.time, t);
      gl.uniform1i(uniforms.count, strandCount);
      gl.uniform3fv(uniforms.colors, palette);
      gl.uniform1f(uniforms.amplitude, p.amplitude);
      gl.uniform1f(uniforms.waviness, p.waviness);
      gl.uniform1f(uniforms.thickness, p.thickness);
      gl.uniform1f(uniforms.glow, p.glow);
      gl.uniform1f(uniforms.taper, p.taper);
      gl.uniform1f(uniforms.spread, p.spread);
      gl.uniform1f(uniforms.intensity, p.intensity);
      gl.uniform1f(uniforms.saturation, p.saturation);
      gl.uniform1f(uniforms.opacity, p.opacity);
      gl.uniform1f(uniforms.scale, p.scale);

      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // One frame and stop when motion is reduced — no loop to cancel, no battery to spend.
      if (!reduceMotion) frame = requestAnimationFrame(draw);
    };

    frame = requestAnimationFrame(draw);

    return () => {
      // Stop the loop and hand back the GL objects. That is the whole cleanup: the context itself
      // dies with the canvas when React removes the node, and the browser reclaims it.
      cancelAnimationFrame(frame);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);

      /**
       * DO NOT ADD `WEBGL_lose_context.loseContext()` HERE. It was here, and it made the loader
       * render nothing at all.
       *
       * `loseContext()` kills the context PERMANENTLY, and a canvas cannot be given a new one —
       * `getContext("webgl2")` afterwards returns the same dead object. React StrictMode (which
       * this app enables in main.tsx) mounts every effect, tears it down, and mounts it again on
       * the SAME canvas node. So the second mount got the corpse: `createShader` and
       * `compileShader` fail silently, `getShaderInfoLog` returns null rather than a message, and
       * the canvas stays transparent. It looked exactly like a shader bug, and it was not.
       *
       * The reason it was added — browsers cap simultaneous contexts and evict the oldest — is
       * real, but it does not apply: this component holds ONE context, unmounts with its canvas,
       * and the count only climbs if contexts are leaked from canvases still in the document.
       */
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={cn("h-full w-full", className)}
      style={{ display: "block", ...style }}
    />
  );
}
