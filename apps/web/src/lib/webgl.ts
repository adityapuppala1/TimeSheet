/**
 * Is WebGL on this machine drawn by the CPU?
 *
 * WHY THIS MATTERS: the marketing pages carry two decorative WebGL scenes (the hero aurora, the
 * standing lattice). On a real GPU they cost nothing a viewer can feel. On a machine with no GPU —
 * a locked-down VM, a remote desktop, a CI runner — the browser falls back to a software
 * rasteriser (SwiftShader in Chromium, llvmpipe on Linux) and a full-viewport fragment shader
 * becomes hundreds of milliseconds per frame. Nothing breaks outright; the page just stutters,
 * scrolls late, and answers clicks late — which in an automated run reads as a 30-second timeout
 * on a button that is plainly there.
 *
 * Both scenes are decoration by contract (`aria-hidden`, nothing communicated only by them), so
 * the honest answer on such a machine is to not start them, exactly as a reduced-motion visitor
 * gets. The check is one throwaway context on first ask, then cached.
 */
const SOFTWARE_RENDERERS = /swiftshader|llvmpipe|softpipe|software|mesa offscreen|microsoft basic render/i;

let cached: boolean | null = null;

export function isSoftwareWebGl(): boolean {
  if (cached !== null) return cached;
  cached = probe();
  return cached;
}

function probe(): boolean {
  if (typeof document === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    const gl = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as WebGLRenderingContext | null;
    if (!gl) return true; // no context at all: the scenes could not run anyway
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return SOFTWARE_RENDERERS.test(renderer);
  } catch {
    return true;
  }
}

/** Test seam: forget the cached answer. */
export function resetWebGlProbe(): void {
  cached = null;
}
