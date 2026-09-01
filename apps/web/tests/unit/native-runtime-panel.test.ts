/**
 * THE THREE THINGS THE NATIVE PANEL GOT WRONG IN FRONT OF A REAL OPERATOR, each pinned by a test
 * that goes red when the fix is removed.
 *
 * ── WHY THESE ARE UNIT TESTS OVER PURE FUNCTIONS ────────────────────────────────────────────
 *
 * The web suite here is utility-level and deliberately has no component harness (see
 * apps/web/vitest.config.ts). So the rule this codebase already follows for this card holds: the
 * decisions worth being sure about live in `utils/native-model-panel.ts` as pure functions, and the
 * component renders their output rather than re-deriving it. That is why `selectSpeedFigure` exists,
 * and it is why `runtimeMessageLines`, `nativeRuntimeActionAvailability` and `nativeProviderRowPlan`
 * do.
 *
 * ── WHAT EACH ONE IS ABOUT ──────────────────────────────────────────────────────────────────
 *
 * 1. THE PANEL SAID THE SAME THING THREE TIMES. With no binary installed, `detail`, `binaryProblem`
 *    and `lastError` all carried the identical sentence and the card rendered all three — one
 *    paragraph, three icons, three colours. The state underneath was correct and the screen read as
 *    broken, which costs more trust than a wrong number does. The fix must NOT be "render fewer
 *    fields": these three mean different things and routinely differ, so the test insists that three
 *    genuinely distinct messages still all appear.
 *
 * 2. RESTART WAS ENABLED WHEN IT COULD NOT POSSIBLY WORK. Gated on `modelId === null` alone, it was
 *    live and confident on any host with a model on disk and no `llama-server` — and every press was
 *    guaranteed to fail.
 *
 * 3. A NATIVE PROVIDER ROW COULD BE CREATED WITH NOTHING BEHIND IT. Because a native row goes to the
 *    TOP of the priority order, it became the first provider every AI feature tried and the first
 *    one every AI feature failed on: "Native (llama.cpp) · Primary · Down", with the fallback
 *    quietly doing the work.
 */
import { describe, expect, it } from "vitest";
import {
  engineInstallOffer,
  engineInstallStatusLabel,
  nativeProviderRowPlan,
  nativeRuntimeActionAvailability,
  runtimeMessageLines,
  type NativeActionStatus
} from "../../src/utils/native-model-panel";
import { nativeEnginePinnedReleaseTag, resolveNativeEngineAsset } from "@timesheet/shared";

/** The exact sentence the API produced for all three fields on the screen that prompted this work. */
const NO_BINARY =
  '"llama-server" was not found on PATH (48 directories searched) and NATIVE_AI_SERVER_BIN is not set.';

describe("the runtime block says each distinct thing exactly once", () => {
  it("collapses three identical sentences to one, and keeps the one that leads", () => {
    // THE OBSERVED BUG, in one assertion. Three fields, one sentence, three renders.
    const lines = runtimeMessageLines({ detail: NO_BINARY, binaryProblem: NO_BINARY, lastError: NO_BINARY });
    expect(lines).toHaveLength(1);
    expect(lines[0].kind).toBe("detail");
    expect(lines[0].text).toBe(NO_BINARY);
  });

  it("shows all three when all three genuinely differ — the fix must not be 'render fewer fields'", () => {
    // A mode explanation, a fixable configuration problem, and a real crash. Every one of these is
    // something an operator acts on differently, and a dedupe that swallowed any of them would be a
    // worse bug than the one it replaced.
    const lines = runtimeMessageLines({
      detail: "NATIVE_AI_RUNTIME_MODE is off, so no local model runtime is used on this host.",
      binaryProblem: "NATIVE_AI_SERVER_BIN points at /opt/nope/llama-server, which does not exist on this host.",
      lastError: "llama-server exited with exit code 139."
    });
    expect(lines.map((line) => line.kind)).toEqual(["detail", "binaryProblem", "lastError"]);
  });

  it("drops a later line whose content is already contained in an earlier one", () => {
    // The common real shape: `detail` is the problem sentence plus a clause of context. The second
    // render adds nothing an operator has not just read.
    const lines = runtimeMessageLines({
      detail: `${NO_BINARY} Install the engine above, or point NATIVE_AI_SERVER_BIN at a binary.`,
      binaryProblem: NO_BINARY,
      lastError: null
    });
    expect(lines).toHaveLength(1);
    expect(lines[0].kind).toBe("detail");
  });

  it("keeps a later line that is longer and adds to an earlier one, rather than hiding the extra", () => {
    // The deliberate ASYMMETRY of the containment rule. Suppressing here would be the "deleted two
    // renders" mistake wearing a cleverer hat.
    const lines = runtimeMessageLines({
      detail: NO_BINARY,
      binaryProblem: `${NO_BINARY} It is also not in the engine directory this deployment installs to.`,
      lastError: null
    });
    expect(lines).toHaveLength(2);
    expect(lines[1].kind).toBe("binaryProblem");
  });

  it("ignores whitespace and case, because 'the same sentence' is a claim about content", () => {
    const lines = runtimeMessageLines({ detail: NO_BINARY, binaryProblem: `  ${NO_BINARY.toUpperCase()}\n `, lastError: null });
    expect(lines).toHaveLength(1);
  });

  it("skips empty and null fields without leaving a blank line behind", () => {
    expect(runtimeMessageLines({ detail: "Not started.", binaryProblem: null, lastError: "   " })).toEqual([
      { kind: "detail", text: "Not started." }
    ]);
    expect(runtimeMessageLines({})).toEqual([]);
  });
});

/* ── each action's own precondition ─────────────────────────────────────────────────────────── */

function status(overrides: Partial<NativeActionStatus> = {}): NativeActionStatus {
  return {
    state: "ready",
    mode: "embedded",
    modelId: "qwen2.5-3b-instruct-q4_k_m",
    binaryPath: "/usr/local/bin/llama-server",
    binaryProblem: null,
    ...overrides
  };
}

const ask = (action: "stop" | "restart" | "measure", overrides: Partial<NativeActionStatus> = {}, extra: { readOnly?: boolean; busy?: boolean } = {}) =>
  nativeRuntimeActionAvailability({ status: status(overrides), action, readOnly: extra.readOnly ?? false, busy: extra.busy ?? false });

describe("Restart is only offered when it could actually succeed", () => {
  it("is REFUSED with a model on disk and no binary — the exact state that shipped it enabled", () => {
    // THE BUG. `modelId` is set, so the old `status.modelId === null` gate let this through, and the
    // button was live on a host with no llama-server anywhere.
    const result = ask("restart", { state: "unavailable", binaryPath: null, binaryProblem: NO_BINARY });
    expect(result.enabled).toBe(false);
    // The reason has to be reachable, and it has to be the SERVER's sentence — it names the actual
    // problem far better than anything the client could reconstruct from a null.
    expect(result.reason).toBe(NO_BINARY);
  });

  it("still refuses when there is no binary and no prior launch, naming the binary as the blocker", () => {
    const result = ask("restart", { state: "unavailable", modelId: null, binaryPath: null, binaryProblem: null });
    expect(result.enabled).toBe(false);
    expect(result.reason).toMatch(/no llama-server on this host/i);
  });

  it("refuses with a binary but no previous launch, because a restart repeats a launch", () => {
    const result = ask("restart", { state: "stopped", modelId: null });
    expect(result.enabled).toBe(false);
    expect(result.reason).toMatch(/no previous launch/i);
  });

  it("allows it when a binary and a model are both there", () => {
    expect(ask("restart", { state: "failed" })).toEqual({ enabled: true, reason: null });
  });

  it("refuses in external mode, where the process belongs to a sidecar", () => {
    const result = ask("restart", { mode: "external" });
    expect(result.enabled).toBe(false);
    expect(result.reason).toMatch(/restart it where it runs/i);
  });
});

describe("Stop needs something this process is actually supervising", () => {
  it("is allowed while ready, starting or restarting", () => {
    for (const state of ["ready", "starting", "restarting"] as const) {
      expect(ask("stop", { state }).enabled).toBe(true);
    }
  });

  it("is refused when nothing is running, and says what the state is instead", () => {
    for (const state of ["stopped", "failed", "unavailable"] as const) {
      const result = ask("stop", { state });
      expect(result.enabled).toBe(false);
      expect(result.reason).toContain(state);
    }
  });

  it("is refused in external mode even though the sidecar answers as ready — pressing it would no-op", () => {
    const result = ask("stop", { mode: "external", state: "ready" });
    expect(result.enabled).toBe(false);
    expect(result.reason).toMatch(/nothing here to stop/i);
  });
});

describe("Measure needs a ready runtime and nothing else", () => {
  it("is allowed against a READY sidecar, because the benchmark is an HTTP call", () => {
    // No local binary at all, and that is fine: measuring a sidecar is a perfectly sensible thing.
    expect(ask("measure", { mode: "external", binaryPath: null }).enabled).toBe(true);
  });

  it("is refused whenever the runtime is not ready, naming the state", () => {
    const result = ask("measure", { state: "starting" });
    expect(result.enabled).toBe(false);
    expect(result.reason).toContain("starting");
  });

  it("is refused with nothing loaded", () => {
    expect(ask("measure", { modelId: null }).enabled).toBe(false);
  });
});

describe("every disabled action explains itself", () => {
  it("never returns a disabled control with no reason — a greyed-out mystery is a support ticket", () => {
    const cases: Array<Partial<NativeActionStatus>> = [
      { state: "off", mode: "off" },
      { state: "unavailable", binaryPath: null },
      { state: "stopped", modelId: null },
      { mode: "external" }
    ];
    for (const overrides of cases) {
      for (const action of ["stop", "restart", "measure"] as const) {
        const result = ask(action, overrides);
        if (!result.enabled) expect(result.reason && result.reason.length > 10).toBe(true);
      }
    }
  });

  it("puts read-only and busy ahead of everything else", () => {
    expect(ask("restart", {}, { readOnly: true }).reason).toMatch(/read-only/i);
    expect(ask("restart", {}, { busy: true }).reason).toMatch(/still running/i);
    expect(nativeRuntimeActionAvailability({ status: null, action: "stop", readOnly: false, busy: false })).toEqual({
      enabled: false,
      reason: "The runtime status has not loaded yet."
    });
  });
});

/* ── a native provider row that cannot serve anything ───────────────────────────────────────── */

describe("a native provider row created with no runtime does not become the primary failing provider", () => {
  it("is held back DISABLED, and says so", () => {
    // THE BUG. The dialog would happily create this enabled, it would sort to the top, and every AI
    // feature would try it first and fail.
    const plan = nativeProviderRowPlan({
      isNew: true,
      requestedEnabled: true,
      runtime: { state: "unavailable", mode: "embedded", detail: NO_BINARY }
    });
    expect(plan.enabled).toBe(false);
    expect(plan.heldBack).toBe(true);
    // AND IT IS NOT SILENT. The requirement was never "a disabled row" — it was "an operator who
    // knows what their click did".
    expect(plan.warning).toBeTruthy();
    expect(plan.warning).toMatch(/DISABLED/);
    expect(plan.warning).toMatch(/top of the priority list/i);
  });

  it("is held back for every not-ready state, not just the one that was on screen", () => {
    for (const state of ["off", "unavailable", "stopped", "starting", "failed", "restarting"] as const) {
      const plan = nativeProviderRowPlan({ isNew: true, requestedEnabled: true, runtime: { state, mode: "embedded" } });
      expect(plan.enabled).toBe(false);
      expect(plan.heldBack).toBe(true);
    }
  });

  it("is held back when the runtime status could not be read at all", () => {
    // "We do not know" must not resolve to "probably fine". An unknown runtime enabled at the top of
    // the list is the same outage as a known-broken one.
    const plan = nativeProviderRowPlan({ isNew: true, requestedEnabled: true, runtime: null });
    expect(plan.enabled).toBe(false);
    expect(plan.warning).toMatch(/could not be read/i);
  });

  it("creates it ENABLED and says nothing when a runtime is actually serving", () => {
    const plan = nativeProviderRowPlan({ isNew: true, requestedEnabled: true, runtime: { state: "ready", mode: "embedded" } });
    expect(plan).toEqual({ enabled: true, heldBack: false, warning: null });
  });

  it("never turns an EXISTING enabled row off behind an administrator's back", () => {
    // Editing a row while the runtime happens to be down is not the moment to overrule a decision
    // somebody already made. They get told; they do not get surprised.
    const plan = nativeProviderRowPlan({
      isNew: false,
      requestedEnabled: true,
      runtime: { state: "unavailable", mode: "embedded" }
    });
    expect(plan.enabled).toBe(true);
    expect(plan.heldBack).toBe(false);
    expect(plan.warning).toMatch(/fail over to the next provider/i);
  });
});

/* ── the engine offer ───────────────────────────────────────────────────────────────────────── */

describe("what the install button promises before it is pressed", () => {
  it("names the asset, the host, an approximate size and the pinned release", () => {
    const resolution = resolveNativeEngineAsset({ platform: "linux", arch: "x64", libc: "glibc" });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    const offer = engineInstallOffer(resolution.asset);
    expect(offer).toContain(resolution.asset.assetName);
    expect(offer).toContain("github.com");
    expect(offer).toMatch(/about \d+/);
    expect(offer).toContain(nativeEnginePinnedReleaseTag);
    // The size is always hedged: it is a published-size ballpark and the REAL count is measured from
    // what arrives. An unhedged figure here would be an estimate wearing a measurement's clothes,
    // which is the one thing this whole panel refuses to do.
    expect(offer).toContain("about");
    // And it states the thing that makes the download reproducible.
    expect(offer).toMatch(/nothing resolves "latest"/i);
  });

  it("gives the two no-bytes-moving steps their own words, so a stalled bar is never a mystery", () => {
    expect(engineInstallStatusLabel("verifying")).toMatch(/hashing/i);
    expect(engineInstallStatusLabel("installing")).toMatch(/running the binary/i);
  });
});
