/**
 * lib/webgl.ts: the one question it answers is "would a WebGL scene here be drawn by the CPU?".
 * The probe is exercised through a fake canvas context, because jsdom has no WebGL at all — and
 * that case is asserted too, since "no context" must count as "do not start the scene".
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { isSoftwareWebGl, resetWebGlProbe } from "../../src/lib/webgl";

function fakeContext(renderer: string) {
  const info = { UNMASKED_RENDERER_WEBGL: 0x9246 };
  return {
    RENDERER: 0x1f01,
    getExtension: (name: string) => (name === "WEBGL_debug_renderer_info" ? info : null),
    getParameter: (key: number) => (key === info.UNMASKED_RENDERER_WEBGL ? renderer : "WebKit WebGL")
  } as unknown as WebGLRenderingContext;
}

afterEach(() => {
  resetWebGlProbe();
  vi.restoreAllMocks();
});

describe("isSoftwareWebGl", () => {
  it("is true where there is no WebGL context at all (jsdom)", () => {
    expect(isSoftwareWebGl()).toBe(true);
  });

  it.each(["Google SwiftShader", "llvmpipe (LLVM 15.0.7, 256 bits)", "Microsoft Basic Render Driver"])("recognises %s as software", (name) => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(fakeContext(name) as never);
    expect(isSoftwareWebGl()).toBe(true);
  });

  it("is false on a real GPU, and caches the answer", () => {
    const spy = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(fakeContext("ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)") as never);
    expect(isSoftwareWebGl()).toBe(false);
    expect(isSoftwareWebGl()).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
