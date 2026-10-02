/**
 * WHAT: the screen an administrator actually uses to run an AI model on this server's own CPU —
 * what the machine is, which catalogue models fit it and why, the two knobs that change that
 * answer, the download, the runtime, the benchmark, and the one button that turns all of it into
 * the primary provider every AI feature calls.
 *
 * WHY A SEPARATE CARD FILE, same reason AIProviderListCard/AIAutonomyCard/AgentRunsCard are their
 * own files: a complete self-contained concern with its own queries, its own mutations and its own
 * dialog does not belong as more JSX on an already very large WorkspaceSettings function.
 *
 * ── THE RULE THIS SCREEN IS BUILT ON: NEVER A NUMBER WITHOUT ITS ARITHMETIC ──────────────────
 *
 * Every verdict here states what it was computed from, on the face of the card and not behind a
 * tooltip. "Won't fit" is a coloured badge and a coloured badge is not actionable; "needs 3.8 GB,
 * 2.1 GB available after reserving 1.5 GB for the database and the API" tells the operator both
 * what to change and by how much. The RAM figure is always shown SPLIT into weights + KV cache +
 * runtime, because an operator choosing between 8k and 16k needs to see which of the three moved —
 * and on a multi-head model (Phi-3.5 here) the answer is startling enough to be the whole reason
 * this card exists. `estimate.reason` and `estimate.warnings` come from the server and are rendered
 * verbatim; nothing here writes its own version of them.
 *
 * ── ESTIMATED AND MEASURED MUST NEVER LOOK ALIKE ─────────────────────────────────────────────
 *
 * The speed figure is either arithmetic over an ASSUMED memory bandwidth (no platform reports the
 * real one) or a stopwatch over real tokens, and those two drive the same decision. So they never
 * share a treatment: an estimate wears a dashed outline badge, a "≈" in front of the number and
 * muted text; a measurement wears a solid badge, an exact number, its time-to-first-token and the
 * date it was taken. `selectSpeedFigure` (utils/native-model-panel.ts) decides which one the card
 * is entitled to show, and a test breaks it on purpose.
 *
 * ── WHY MODELS THAT DO NOT FIT ARE STILL LISTED ──────────────────────────────────────────────
 *
 * Hiding them answers "why isn't the 7B here?" with silence, and an operator who cannot see the
 * refusal cannot see that lowering the context or halving the KV cache would lift it. They render
 * with a destructive verdict, the sentence explaining it, and Run disabled — Download stays enabled,
 * because fetching a model you intend to run after adding RAM is a legitimate thing to do.
 *
 * ── POLLING, AND WHY THERE IS NO SOCKET ──────────────────────────────────────────────────────
 *
 * A conditional `refetchInterval` that switches ITSELF off when nothing is in flight, exactly like
 * AgentRunsCard. There is no SSE and no WebSocket anywhere in this repo and this card is not the
 * place to introduce one; an idle workspace must not issue a request every two seconds forever.
 *
 * ── THE LAYOUT (2026-09-21): THE ORDER OF OPERATIONS ACROSS, NOT DOWN ────────────────────────
 *
 * The machine, then the engine and the runtime SIDE BY SIDE (each is the other's precondition
 * and both are short), then tuning as three columns with the long explanation folded under each
 * control, then the models as a GRID of cards rather than six full-width rows. What stays on the
 * face of every model card, per the rule above: the verdict and its sentence, the memory bar, the
 * split arithmetic, the speed figure with its estimated/measured treatment, and any warning. What
 * folds behind "Good at, weak at, and the basis" is prose a person reads once when choosing and
 * never again when operating. Nothing was removed; the card was 1,100 px per model and is ~300.
 *
 * ── IT HAS TO BE HONEST WHEN NOTHING IS SET UP ───────────────────────────────────────────────
 *
 * The whole panel renders, and is useful, with no model downloaded, no llama-server binary
 * installed and the runtime off. That is the state EVERY installation is in the first time this
 * card is opened, so an empty state that looks broken is an empty state that gets a support ticket.
 * Each one names the next step instead.
 */
import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  nativeContextLadder,
  nativeDownloadInFlightStatuses,
  nativeEngineInstallInFlightStatuses,
  nativeModelCatalogue,
  type NativeDownloadStatus,
  type NativeEngineBinarySource,
  type NativeEngineInstallRow,
  type NativeEngineInstallStatus,
  type NativeEngineReport,
  type NativeFitEstimate,
  type NativeHardwareSnapshot,
  type NativeKvCacheType,
  type NativeModelDownloadRow,
  type NativeModelEntry,
  type NativeRuntimeState,
  type NativeRuntimeStatus
} from "@timesheet/shared";
import {
  AlertTriangle,
  ArrowUpToLine,
  Boxes,
  ChevronRight,
  SlidersHorizontal,
  CheckCircle2,
  Cpu,
  Download,
  Gauge,
  HardDrive,
  Loader2,
  MemoryStick,
  Play,
  RotateCw,
  Server,
  Square,
  Trash2,
  X
} from "lucide-react";
import { settingsApi, type AIProviderConfigRow } from "../../services/api";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Progress } from "../../components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Skeleton } from "../../components/ui/skeleton";
import { toast } from "../../components/ui/toaster";
import { cn } from "../../lib/utils";
import {
  containerMemoryCaveat,
  contextStepsForModel,
  downloadProgressPercent,
  downloadStatusLabel,
  engineInstallOffer,
  engineInstallStatusLabel,
  environmentSummary,
  fitVerdictTone,
  formatBytes,
  formatContextTokens,
  isMachineWideWarning,
  liveNativeFit,
  nativeProviderRowPlan,
  nativeRuntimeActionAvailability,
  nativeThreadCeiling,
  runtimeMessageLines,
  selectSpeedFigure,
  type NativeBadgeVariant,
  type NativeRuntimeAction
} from "../../utils/native-model-panel";
import { runInBackground } from "../../lib/run-in-background";

/** The download statuses worth polling on, straight from the shared list rather than a second copy
 *  of it — the API decides what "in flight" means and the UI agrees by construction. */
const DOWNLOAD_IN_FLIGHT = new Set<NativeDownloadStatus>(nativeDownloadInFlightStatuses);

/** The runtime states that are going somewhere on their own. Everything else is settled, and a
 *  settled runtime is not worth a request every three seconds. */
const RUNTIME_TRANSIENT = new Set<NativeRuntimeState>(["starting", "restarting"]);

/** State → badge. `unavailable` and `failed` are deliberately different colours because the
 *  operator does different things about them: unavailable means it cannot run here at all (no
 *  binary, no model) and no amount of retrying helps; failed means it ran, kept exiting, and is
 *  worth a Start button. */
const RUNTIME_TONE: Record<NativeRuntimeState, { badge: NativeBadgeVariant; label: string }> = {
  off: { badge: "muted", label: "Off" },
  unavailable: { badge: "warning", label: "Unavailable" },
  stopped: { badge: "muted", label: "Stopped" },
  starting: { badge: "info", label: "Starting" },
  ready: { badge: "success", label: "Ready" },
  restarting: { badge: "info", label: "Restarting" },
  failed: { badge: "destructive", label: "Failed" }
};

/** The engine-install statuses worth polling on, from the shared list rather than a second copy. */
const ENGINE_IN_FLIGHT = new Set<NativeEngineInstallStatus>(nativeEngineInstallInFlightStatuses);

/** Where a resolved `llama-server` came from, in words. Which of the three answered is exactly the
 *  question an operator debugging a version mismatch has to be able to settle. */
const ENGINE_SOURCE_LABEL: Record<NativeEngineBinarySource, string> = {
  configured: "from NATIVE_AI_SERVER_BIN",
  managed: "installed from this screen",
  path: "found on PATH"
};

const KV_LABEL: Record<NativeKvCacheType, string> = { f16: "16-bit", q8_0: "8-bit" };

function errorMessage(err: unknown, fallback = "Try again."): string {
  return (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback;
}

/**
 * "8 physical · 16 logical", plus the cgroup quota when one binds.
 *
 * Written as statements rather than nested ternaries because the three cases are three genuinely
 * different sentences: both counts known, only the logical one (so say the physical count is
 * unknown, since it is the number that matters for threads), or neither. "core count unknown" must
 * never come out as a number.
 */
function describeCores(cpu: NativeHardwareSnapshot["cpu"]): string {
  const parts: string[] = [];
  if (cpu.physicalCores !== null) parts.push(`${cpu.physicalCores} physical`);
  if (cpu.logicalCores !== null) parts.push(`${cpu.logicalCores} logical`);
  if (parts.length === 0) parts.push("core count unknown");
  else if (cpu.physicalCores === null) parts.push("physical count unknown");
  if (cpu.quotaCores !== null) parts.push(`capped at ${cpu.quotaCores} cores by ${cpu.quotaSource ?? "a cgroup quota"}`);
  return parts.join(" · ");
}

/** What is free, and what set the ceiling. When a cgroup limit exists it is NAMED, because the host
 *  figure beside it is then not the number anything downstream is allowed to believe. */
function describeMemory(memory: NativeHardwareSnapshot["memory"]): string {
  const free = `${formatBytes(memory.effectiveAvailableBytes)} free now`;
  if (memory.cgroupLimitBytes !== null) {
    return `${free} · limited to ${formatBytes(memory.cgroupLimitBytes)} by ${memory.cgroupSource ?? "a cgroup"}`;
  }
  return `${free} · host reports ${formatBytes(memory.hostTotalBytes)}`;
}

/** One labelled fact about the machine. `value` is already a string because "unknown" is a
 *  first-class answer here and a nullable number rendered as 0 is the failure this card is most
 *  determined not to commit. */
function Fact({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: string; detail?: string | null }) {
  return (
    <div className="min-w-0">
      <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
      </p>
      <p className="mt-0.5 break-words text-sm font-medium">{value}</p>
      {detail && <p className="mt-0.5 break-words text-xs text-muted-foreground">{detail}</p>}
    </div>
  );
}

export function NativeModelRunnerCard({ readOnly }: { readOnly: boolean }) {
  const queryClient = useQueryClient();

  const capability = useQuery({ queryKey: ["settings", "ai", "native", "capability"], queryFn: settingsApi.getNativeAiCapability });
  const downloads = useQuery({
    queryKey: ["settings", "ai", "native", "downloads"],
    queryFn: settingsApi.listNativeAiDownloads,
    // Switches ITSELF off the moment nothing is transferring — the AgentRunsCard pattern, and the
    // only long-job pattern this repo has.
    refetchInterval: (query) => ((query.state.data ?? []).some((row: NativeModelDownloadRow) => DOWNLOAD_IN_FLIGHT.has(row.status)) ? 2000 : false)
  });
  const runtime = useQuery({
    queryKey: ["settings", "ai", "native", "runtime"],
    queryFn: settingsApi.getNativeAiRuntime,
    refetchInterval: (query) => (query.state.data && RUNTIME_TRANSIENT.has(query.state.data.state) ? 3000 : false)
  });
  // The engine — `llama-server` itself. Polled on the same conditional-interval pattern as the
  // download list, and OFF the moment nothing is transferring.
  const engine = useQuery({
    queryKey: ["settings", "ai", "native", "engine"],
    queryFn: settingsApi.getNativeAiEngine,
    refetchInterval: (query) => (query.state.data?.install && ENGINE_IN_FLIGHT.has(query.state.data.install.status) ? 2000 : false)
  });
  // Same key AIProviderListCard fetches under, so this shares its cache instead of re-fetching —
  // both cards live in the same tab and both need to know whether a native row already exists.
  const providers = useQuery({ queryKey: ["settings", "ai", "providers"], queryFn: settingsApi.listAiProviders });

  const hardware = capability.data?.hardware ?? null;

  /* The tuning state. Held as "override or nothing" rather than seeded by an effect: the
     recommendation for THIS machine arrives with the capability report, and `?? recommended` means
     the controls are pre-filled the instant it lands without a render pass showing a wrong value
     first, and without an effect that would fight an operator mid-edit on every refetch. */
  const [contextOverride, setContextOverride] = useState<number | null>(null);
  const [threadsOverride, setThreadsOverride] = useState<string | null>(null);
  const [kvCacheType, setKvCacheType] = useState<NativeKvCacheType>("f16");

  const anyEstimate: NativeFitEstimate | null = capability.data?.models[0]?.estimate ?? null;
  const suggestedEstimate = capability.data?.models.find((row) => row.modelId === capability.data?.suggestedModelId)?.estimate ?? null;
  const recommendedContext = suggestedEstimate?.recommended.contextTokens ?? nativeContextLadder[2];
  const recommendedThreads = anyEstimate?.recommended.threads ?? null;
  const contextTokens = contextOverride ?? recommendedContext;
  const threadsField = threadsOverride ?? (recommendedThreads === null ? "" : String(recommendedThreads));
  const threads = Number(threadsField) > 0 ? Number(threadsField) : undefined;

  const downloadByModel = new Map((downloads.data ?? []).map((row) => [row.modelId, row]));
  const nativeProviderRow = (providers.data ?? []).find((row: AIProviderConfigRow) => row.provider === "LLAMA_CPP") ?? null;

  const invalidateDownloads = () => queryClient.invalidateQueries({ queryKey: ["settings", "ai", "native", "downloads"] });
  const invalidateRuntime = () => queryClient.invalidateQueries({ queryKey: ["settings", "ai", "native", "runtime"] });
  // The engine and the runtime are refreshed TOGETHER, always: `binaryPath` on the runtime status is
  // what gates Restart, and an install that finishes without the runtime being re-read would leave
  // that button disabled with a sentence that has just stopped being true.
  const invalidateEngine = () => {
    void queryClient.invalidateQueries({ queryKey: ["settings", "ai", "native", "engine"] });
    void invalidateRuntime();
  };

  const installEngine = useMutation({
    mutationFn: () => settingsApi.installNativeAiEngine(),
    onSuccess: () => {
      toast.success("Installing the engine", {
        description: "It downloads on the server, is checked, extracted and then run once to prove it works. This page can be closed."
      });
      invalidateEngine();
    },
    // A 422 (musl, an unsupported architecture) and a 409 (external/off mode) both carry the sentence
    // that says what to do instead. Showing it verbatim is the whole point of writing it.
    onError: (err) => toast.error("Could not install the engine", { description: errorMessage(err) })
  });
  const cancelEngineInstall = useMutation({
    mutationFn: (id: string) => settingsApi.cancelNativeAiEngineInstall(id),
    onSuccess: () => {
      toast.success("Install cancelled", { description: "The partial download was removed." });
      invalidateEngine();
    },
    onError: (err) => toast.error("Could not cancel", { description: errorMessage(err) })
  });

  const startDownload = useMutation({
    mutationFn: (modelId: string) => settingsApi.startNativeAiDownload(modelId),
    onSuccess: () => {
      toast.success("Download started", { description: "It runs on the server — this page can be closed and the progress will still be here." });
      void invalidateDownloads();
    },
    // A 507 names both the free space and the size needed; showing it verbatim is the whole point.
    onError: (err) => toast.error("Could not start the download", { description: errorMessage(err) })
  });
  const cancelDownload = useMutation({
    mutationFn: (id: string) => settingsApi.cancelNativeAiDownload(id),
    onSuccess: () => {
      toast.success("Download cancelled", { description: "The partial file was removed." });
      void invalidateDownloads();
    },
    onError: (err) => toast.error("Could not cancel", { description: errorMessage(err) })
  });
  const deleteModel = useMutation({
    mutationFn: (id: string) => settingsApi.deleteNativeAiModel(id),
    onSuccess: () => {
      toast.success("Model deleted from this machine's disk");
      void invalidateDownloads();
      runInBackground(queryClient.invalidateQueries({ queryKey: ["settings", "ai", "native", "capability"] }));
    },
    onError: (err) => toast.error("Could not delete", { description: errorMessage(err) })
  });
  const startRuntime = useMutation({
    mutationFn: (modelId: string) => settingsApi.startNativeAiRuntime({ modelId, contextTokens, threads, kvCacheType }),
    onSuccess: (status) => {
      if (status.state === "ready") toast.success("The local model is running", { description: status.detail });
      else toast.error(`Runtime is ${status.state}`, { description: status.detail });
      void invalidateRuntime();
    },
    onError: (err) => toast.error("Could not start the runtime", { description: errorMessage(err) })
  });
  const stopRuntime = useMutation({
    mutationFn: () => settingsApi.stopNativeAiRuntime(),
    onSuccess: (status) => {
      toast.success("Runtime stopped", { description: status.detail });
      void invalidateRuntime();
    },
    onError: (err) => toast.error("Could not stop the runtime", { description: errorMessage(err) })
  });
  const restartRuntime = useMutation({
    mutationFn: () => settingsApi.restartNativeAiRuntime(),
    onSuccess: (status) => {
      toast.success(`Runtime is ${status.state}`, { description: status.detail });
      void invalidateRuntime();
    },
    onError: (err) => toast.error("Could not restart the runtime", { description: errorMessage(err) })
  });
  const benchmark = useMutation({
    mutationFn: (modelId: string) => settingsApi.runNativeAiBenchmark(modelId),
    onSuccess: (result) => {
      toast.success(`Measured ${result.benchmark.tokensPerSecond} tokens/sec`, {
        description: `First token after ${Math.round(result.benchmark.timeToFirstTokenMs)} ms. This machine can emit about ${result.benchmark.suggestedMaxOutputTokens} tokens inside the 90-second call ceiling.`
      });
      void invalidateDownloads();
    },
    onError: (err) => toast.error("The benchmark did not finish", { description: errorMessage(err) })
  });

  /**
   * MAKE IT THE PRIMARY PROVIDER — one action, at the TOP of the priority order, which is the
   * entire design: a model running on this machine's own CPU is the thing decisions should be made
   * with, and a cloud row is the fallback behind it. That is the opposite of `createProviderConfig`'s
   * default (new rows APPEND, because an admin adding a provider is usually adding a fallback), so
   * the promotion is an explicit `reorder` with the new row first rather than a new endpoint.
   *
   * An existing native row is UPDATED rather than duplicated — two LLAMA_CPP rows pointing at the
   * same single-slot server would queue behind each other and look like a hung provider.
   *
   * `maxConcurrent: 1` because llama.cpp serves one request per slot; anything higher just
   * recreates the unbounded queueing `maxConcurrent` exists to prevent. `maxOutputTokens` carries
   * the BENCHMARK's number when one exists and stays null otherwise — "no declared limit" is the
   * honest value for a machine nobody has measured, and the dispatcher treats it as such.
   */
  const makePrimary = useMutation({
    mutationFn: async () => {
      const status = runtime.data;
      const modelId = status?.modelId;
      if (!modelId) throw new Error("Nothing is running, so there is no model to point a provider row at.");
      const entry = nativeModelCatalogue.find((model) => model.id === modelId);
      const measured = downloadByModel.get(modelId)?.benchmark ?? null;
      const rows = providers.data ?? [];
      const payload = {
        label: `${entry?.displayName ?? modelId} on this server`,
        model: modelId,
        enabled: true,
        maxConcurrent: 1,
        contextWindow: status?.contextTokens ?? contextTokens,
        maxOutputTokens: measured?.suggestedMaxOutputTokens ?? null
      };
      const existing = rows.find((row) => row.provider === "LLAMA_CPP");
      const saved = existing
        ? await settingsApi.updateAiProvider(existing.id, payload)
        : await settingsApi.createAiProvider({ provider: "LLAMA_CPP", ...payload });
      const others = rows.filter((row) => row.id !== saved.id).map((row) => row.id);
      await settingsApi.reorderAiProviders([saved.id, ...others]);
      return { saved, measured };
    },
    onSuccess: ({ measured }) => {
      toast.success("The local model is now the primary provider", {
        description: measured
          ? `Every AI feature tries it first, declaring ${measured.suggestedMaxOutputTokens} output tokens. Anything asking for more skips it and falls through to the next provider.`
          : "Every AI feature tries it first. It declares no output-token limit — run a benchmark and set one, or a heavy call will spend the full 90 seconds finding out."
      });
      runInBackground(queryClient.invalidateQueries({ queryKey: ["settings", "ai", "providers"] }));
    },
    onError: (err) => toast.error("Could not make it the primary provider", { description: errorMessage(err, (err as Error)?.message ?? "Try again.") })
  });

  const busy = startRuntime.isPending || stopRuntime.isPending || restartRuntime.isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Cpu className="h-4 w-4 text-primary" />
          Run a model on this server
        </CardTitle>
        <CardDescription>
          A model that runs on this machine's own CPU costs nothing per call, sends nothing to a vendor, and works with no
          internet connection at all — which is why it belongs at the TOP of the provider list rather than behind one. What it
          costs instead is memory and speed, so everything below states the arithmetic: what each model needs, what this box
          has, and what changes when you move the context.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {capability.isLoading && <Skeleton className="h-40 w-full" />}

        {capability.isError && (
          <Alert variant="warning">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Could not read this machine</AlertTitle>
            <AlertDescription>
              The hardware probe did not answer, so nothing below can be judged honestly. This needs Super Admin rights; if you
              have them, the API's own log will say what failed.
            </AlertDescription>
          </Alert>
        )}

        {hardware && (
          <>
            <SystemStrip hardware={hardware} warnings={anyEstimate?.warnings ?? []} />

            {/* THE ENGINE COMES BEFORE THE MODEL LIST, because nothing below it works without one.
                The old order let an operator download 940 MB and only then discover the panel's last
                word was "install llama.cpp yourself". Beside the runtime rather than above it: the
                two are short, each is read against the other, and stacked they cost a screen. */}
            <div className="grid min-w-0 gap-3 xl:grid-cols-2">
              <EngineStrip
                report={engine.data ?? null}
                loading={engine.isLoading}
                readOnly={readOnly}
                installing={installEngine.isPending}
                onInstall={() => installEngine.mutate()}
                onCancel={(id) => cancelEngineInstall.mutate(id)}
              />

              <RuntimeStrip
                status={runtime.data ?? null}
                loading={runtime.isLoading}
                readOnly={readOnly}
                busy={busy}
                benchmarking={benchmark.isPending}
                promoting={makePrimary.isPending}
                nativeProviderRow={nativeProviderRow}
                onStop={() => stopRuntime.mutate()}
                onRestart={() => restartRuntime.mutate()}
                onBenchmark={(modelId) => benchmark.mutate(modelId)}
                onMakePrimary={() => makePrimary.mutate()}
              />
            </div>

            <div className="min-w-0 rounded-lg border border-border p-3">
              <p className="flex items-center gap-2 text-sm font-medium">
                <SlidersHorizontal className="h-4 w-4 text-primary" aria-hidden />
                Tuning
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Pre-filled with what the estimator recommends for this machine. Both numbers change the memory figures on every
                model below as you move them — that is the trade-off, made visible.
              </p>
              <NativeRuntimeTuningControls
                className="mt-3"
                layout="row"
                idPrefix="native-runner"
                disabled={readOnly}
                hardware={hardware}
                recommendedThreads={recommendedThreads}
                threadsBasis={anyEstimate?.recommended.threadsBasis ?? null}
                threads={threadsField}
                onThreadsChange={setThreadsOverride}
                contextTokens={contextTokens}
                recommendedContext={recommendedContext}
                onContextChange={setContextOverride}
                kvCacheType={kvCacheType}
                onKvCacheTypeChange={setKvCacheType}
              />
            </div>

            <div className="grid min-w-0 gap-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <Boxes className="h-4 w-4 text-primary" aria-hidden />
                  Models this deployment will run
                </p>
                <p className="text-xs text-muted-foreground">
                  A curated list, not a mirror of Hugging Face — every entry is picked for closing its JSON braces on a CPU.
                </p>
              </div>
              {/* A grid, not a column: six rows of prose was a screen and a half per model. The
                  running model, when there is one, is sorted first so it is never below the fold. */}
              <div className="grid min-w-0 gap-3 md:grid-cols-2 2xl:grid-cols-3">
              {[...nativeModelCatalogue].sort((a, b) => Number(runtime.data?.modelId === b.id) - Number(runtime.data?.modelId === a.id)).map((entry) => (
                <ModelRow
                  key={entry.id}
                  entry={entry}
                  hardware={hardware}
                  contextTokens={contextTokens}
                  kvCacheType={kvCacheType}
                  download={downloadByModel.get(entry.id) ?? null}
                  isBestFitHere={capability.data?.suggestedModelId === entry.id}
                  runtime={runtime.data ?? null}
                  readOnly={readOnly}
                  starting={startRuntime.isPending}
                  benchmarking={benchmark.isPending}
                  onDownload={() => startDownload.mutate(entry.id)}
                  onCancel={(id) => cancelDownload.mutate(id)}
                  onDelete={(id) => {
                    if (confirm(`Delete ${entry.displayName} from this machine's disk? The file has to be downloaded again to use it.`)) {
                      deleteModel.mutate(id);
                    }
                  }}
                  onRun={() => startRuntime.mutate(entry.id)}
                  onBenchmark={() => benchmark.mutate(entry.id)}
                />
              ))}
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/* ── what this machine is ───────────────────────────────────────────────────────────────────── */

/**
 * The hardware, with its reasoning attached. Every value that could not be read says "unknown"
 * rather than showing a zero, and the environment label carries the signals that produced it —
 * "Kubernetes" on its own is a claim an operator has no way to check, and container detection is
 * wrong often enough to be worth showing its work.
 *
 * THE WARNING BLOCK IS THE IMPORTANT PART. `os.totalmem()` always reports the HOST's memory, so a
 * container with no cgroup limit is told it has the whole box — every estimate below it is then
 * optimistic, and the operator finds out when the kernel kills the process. The machine-wide
 * warnings from the estimator are shown ONCE here rather than six times down the page, because six
 * copies of a sentence train a reader to skip all of them.
 */
function SystemStrip({
  hardware,
  warnings
}: {
  hardware: NativeHardwareSnapshot;
  warnings: NativeFitEstimate["warnings"];
}) {
  const environment = environmentSummary(hardware);
  const caveat = containerMemoryCaveat(hardware);
  // The container caveat gets its own Alert below, so it is filtered out of the plain warning list
  // rather than said twice.
  const machineWarnings = warnings.filter((warning) => isMachineWideWarning(warning.code) && warning.code !== "container-without-memory-limit");
  const { cpu, memory, disk } = hardware;

  return (
    <div className="grid min-w-0 gap-3">
      <div className="min-w-0 rounded-lg border border-border p-3">
        <p className="text-sm font-medium">Your system</p>
        {/* min-w-0 on the grid AND on each Fact: a grid item defaults to `min-width: auto`, so a
            long CPU model or disk path sets a min-content floor that stretches every ancestor
            past a phone viewport instead of wrapping. `break-words` alone does not lower that
            floor — only a zero min-width does. */}
        <div className="mt-3 grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Fact
            icon={<Cpu className="h-3.5 w-3.5" />}
            label="CPU"
            value={cpu.model ?? "unknown"}
            detail={describeCores(cpu)}
          />
          <Fact
            icon={<MemoryStick className="h-3.5 w-3.5" />}
            label="Usable RAM"
            value={formatBytes(memory.effectiveTotalBytes)}
            detail={describeMemory(memory)}
          />
          <Fact
            icon={<HardDrive className="h-3.5 w-3.5" />}
            label="Disk free"
            value={formatBytes(disk?.freeBytes ?? null)}
            detail={disk ? `of ${formatBytes(disk.totalBytes)} on ${disk.path}` : "the model directory could not be measured"}
          />
          <Fact icon={<Server className="h-3.5 w-3.5" />} label="Environment" value={environment.label} detail={environment.reason} />
        </div>
      </div>

      {caveat && (
        <Alert variant="warning">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>These memory figures are the host's, not this container's</AlertTitle>
          <AlertDescription>{caveat}</AlertDescription>
        </Alert>
      )}

      {machineWarnings.map((warning) => (
        <p key={warning.code} className="flex items-start gap-2 text-xs text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
          {warning.message}
        </p>
      ))}
    </div>
  );
}

/* ── the runtime ────────────────────────────────────────────────────────────────────────────── */

/**
 * Who runs llama-server here, whether it is up, and the sentence saying why when it is not.
 *
 * `detail` and `modeReason` are rendered verbatim from the API rather than being re-derived from
 * `state` — a state badge nobody can explain is a badge somebody argues with, and the server is the
 * only thing that knows whether the binary is missing, the model is not downloaded, or a sidecar
 * owns the process. Start lives on each MODEL row (you start a runtime on a model, not in the
 * abstract); Stop, Restart, Measure and the provider promotion live here.
 */
function RuntimeStrip({
  status,
  loading,
  readOnly,
  busy,
  benchmarking,
  promoting,
  nativeProviderRow,
  onStop,
  onRestart,
  onBenchmark,
  onMakePrimary
}: {
  status: NativeRuntimeStatus | null;
  loading: boolean;
  readOnly: boolean;
  busy: boolean;
  benchmarking: boolean;
  promoting: boolean;
  nativeProviderRow: AIProviderConfigRow | null;
  onStop: () => void;
  onRestart: () => void;
  onBenchmark: (modelId: string) => void;
  onMakePrimary: () => void;
}) {
  if (loading) return <Skeleton className="h-20 w-full" />;
  if (!status) return null;

  const tone = RUNTIME_TONE[status.state];
  const running = status.state === "ready";

  // Each button asks what IT requires, and carries the answer's sentence as its title. Restart used
  // to be gated on `modelId === null` alone, which left it live and certain to fail on any host with
  // a model on disk and no llama-server — see `nativeRuntimeActionAvailability` for the rules.
  const availability = (action: NativeRuntimeAction) => nativeRuntimeActionAvailability({ status, action, readOnly, busy });
  const stop = availability("stop");
  const restart = availability("restart");
  const measure = nativeRuntimeActionAvailability({ status, action: "measure", readOnly, busy: busy || benchmarking });

  // The three message fields, collapsed to what is actually distinct. `detail` leads; the rest are
  // rendered below the endpoint line only when they add something.
  const messages = runtimeMessageLines(status);
  const detailMessage = messages.find((message) => message.kind === "detail") ?? null;
  const extraMessages = messages.filter((message) => message.kind !== "detail");

  // The promotion has the same honesty requirement the Add-provider dialog now has: a native row
  // with nothing behind it goes to the top of the priority order and fails first for every AI call.
  const promotionPlan = nativeProviderRowPlan({ isNew: nativeProviderRow === null, requestedEnabled: true, runtime: status });

  return (
    <div className="min-w-0 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
            Local runtime
            <Badge variant={tone.badge}>{tone.label}</Badge>
            <Badge variant="outline" className="text-xs font-normal">
              {status.mode} mode
            </Badge>
          </p>
          {/* `detail` is always the first line, and `runtimeMessageLines` guarantees it is the one
              the others are measured against — so a mode explanation is never suppressed by a
              problem sentence that happens to repeat it. */}
          {detailMessage && <p className="mt-1 text-xs text-muted-foreground">{detailMessage.text}</p>}
          <p className="mt-0.5 text-xs text-muted-foreground">{status.modeReason}</p>
          {status.state === "ready" && (
            <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
              <span className="tabular-nums">{status.modelId}</span>
              {status.contextTokens !== null && <span className="tabular-nums">{formatContextTokens(status.contextTokens)} context</span>}
              {status.threads !== null && <span className="tabular-nums">{status.threads} threads</span>}
              {status.kvCacheType !== null && <span>{KV_LABEL[status.kvCacheType]} KV cache</span>}
              {status.parallelSlots !== null && <span className="tabular-nums">{status.parallelSlots} slot(s)</span>}
            </p>
          )}
          {status.baseUrl && <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">{status.baseUrl}</p>}
          {/* `binaryProblem` and `lastError`, each said ONLY IF IT ADDS SOMETHING the lines above it
              did not already say. With no binary installed all three fields used to carry the same
              sentence and all three used to render, so the card printed one paragraph three times
              under three icons — correct underneath and unmistakably broken-looking on screen. The
              decision is `runtimeMessageLines`' (utils/native-model-panel.ts), which dedupes on
              CONTENT rather than by deleting renders, so three genuinely different messages still
              all appear. `detail` itself is rendered above; only the tail is mapped here. */}
          {extraMessages.map((message) => (
            <p
              key={message.kind}
              className={cn(
                "mt-2 flex items-start gap-2 break-words text-xs",
                message.kind === "lastError" ? "text-destructive" : "text-muted-foreground"
              )}
            >
              <AlertTriangle className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", message.kind === "lastError" ? "" : "text-warning")} />
              {message.text}
            </p>
          ))}
          {status.restarts.attempts > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              {status.restarts.attempts} of {status.restarts.maxAttempts} restart attempts used
              {status.restarts.lastExitCode !== null && ` · last exit code ${status.restarts.lastExitCode}`}
              {status.restarts.lastExitSignal && ` · signal ${status.restarts.lastExitSignal}`}
            </p>
          )}
        </div>
        {/* Every disabled control carries WHY in its title. A greyed-out button with no explanation
            is a support ticket, and Restart in particular used to be neither disabled nor
            explicable — it was enabled on a host that could not possibly honour it. */}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={!stop.enabled} title={stop.reason ?? "Stop llama-server on this host"} onClick={onStop}>
            {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Square className="mr-1 h-3.5 w-3.5" />}
            Stop
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!restart.enabled}
            title={restart.reason ?? "Stop llama-server and start it again on the same model and settings"}
            onClick={onRestart}
          >
            <RotateCw className="mr-1 h-3.5 w-3.5" />
            Restart
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!measure.enabled}
            title={measure.reason ?? "Send a short fixed prompt and time it — the only way to replace the speed estimate with a fact"}
            onClick={() => status.modelId && onBenchmark(status.modelId)}
          >
            {benchmarking ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Gauge className="mr-1 h-3.5 w-3.5" />}
            Measure
          </Button>
        </div>
      </div>

      {/* The promotion. Only offered once something is actually serving requests — a provider row
          pointing at a runtime that is off would be tried first by every AI feature and fail first
          for every one of them. */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/30 p-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">
            {nativeProviderRow ? "Update the local provider row and put it first" : "Use it for every AI feature"}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Adds a <code className="rounded bg-muted px-1 py-0.5 text-[11px]">LLAMA_CPP</code> row at the TOP of the provider list
            — native is primary, and a cloud key is the fallback behind it. It carries the running context and, once you have
            measured this machine, the output-token ceiling that measurement implies. One concurrent call, because llama.cpp
            serves one request per slot. After that the provider list above owns it: reorder, disable and delete all work there.
          </p>
        </div>
        <Button
          size="sm"
          disabled={readOnly || promoting || !running}
          title={running ? "Create or update the LLAMA_CPP row and put it first" : (promotionPlan.warning ?? undefined)}
          onClick={onMakePrimary}
        >
          {promoting ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <ArrowUpToLine className="mr-1 h-3.5 w-3.5" />}
          {nativeProviderRow ? "Update and promote" : "Make it the primary provider"}
        </Button>
      </div>
      {/* The reason this button is off, on the face of the card rather than only in its tooltip —
          the same sentence the Add-provider dialog shows, from the same function, so the two
          surfaces cannot come to describe this differently. */}
      {!running && promotionPlan.warning && <p className="mt-2 text-xs text-muted-foreground">{promotionPlan.warning}</p>}
    </div>
  );
}

/* ── the engine ─────────────────────────────────────────────────────────────────────────────── */

/**
 * STEP ZERO: getting `llama-server` onto this machine.
 *
 * WHY IT SITS ABOVE THE MODEL LIST. Nothing below it works without a binary. The panel used to open
 * with the hardware, then the runtime, then six models to download — and an operator could do all of
 * that, watch a 940 MB file verify, and only then meet the sentence "install llama.cpp on this host
 * and point NATIVE_AI_SERVER_BIN at the binary". Putting acquisition first makes the order of
 * operations the order on screen.
 *
 * WHAT IT SAYS BEFORE THE CLICK, ALWAYS. The release, the host, the asset name and the approximate
 * size. Downloading and then EXECUTING a binary from the internet is a decision an operator makes
 * knowingly or not at all, so the offer is rendered whether or not they ever press it, and the
 * button is never the first place the plan appears.
 *
 * WHEN IT CANNOT BE DONE HERE, IT SAYS SO SPECIFICALLY AND KEEPS THE ALTERNATIVE. On Alpine (musl)
 * there is no glibc build that can run, and the honest answer is a sidecar; the same is true of an
 * unsupported architecture, and of `external`/`off` modes where a local binary would sit unused. A
 * clear "not here, do this instead" is a good outcome — the dead end was never the refusal, it was
 * the absence of a path.
 */
function EngineStrip({
  report,
  loading,
  readOnly,
  installing,
  onInstall,
  onCancel
}: {
  report: NativeEngineReport | null;
  loading: boolean;
  readOnly: boolean;
  installing: boolean;
  onInstall: () => void;
  onCancel: (id: string) => void;
}) {
  if (loading) return <Skeleton className="h-24 w-full" />;
  if (!report) return null;

  const install = report.install;
  const inFlight = install !== null && ENGINE_IN_FLIGHT.has(install.status);
  const installed = report.binaryPath !== null;
  const progress = install ? downloadProgressPercent(install) : null;
  const offer = report.resolution.ok ? engineInstallOffer(report.resolution.asset) : null;
  // The button is only live where an install could actually succeed AND is worth doing: a host with
  // a published build, in embedded mode, with nothing already transferring.
  const canInstall = !readOnly && report.installable && !inFlight && !installing;

  return (
    <div className="min-w-0 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-72">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
            Inference engine
            {installed ? (
              <Badge variant="success" className="text-xs font-normal">
                Installed
              </Badge>
            ) : (
              <Badge variant="warning" className="text-xs font-normal">
                Not installed
              </Badge>
            )}
            <Badge variant="outline" className="text-xs font-normal">
              {report.platform} · {report.arch}
              {report.libc ? ` · ${report.libc}` : ""}
            </Badge>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            <code className="rounded bg-muted px-1 py-0.5 text-[11px]">llama-server</code> is the program that actually runs a model.
            Nothing below this works without it, and nothing here is fetched on its own — installing is this button and only this button.
          </p>

          {/* WHAT IS ALREADY THERE, and which of the three sources produced it. "There is a
              llama-server" and "there is the one this panel installed" are different facts, and a
              version mismatch is diagnosed from the difference. */}
          {installed && (
            <p className="mt-2 break-all font-mono text-[11px] text-muted-foreground">
              {report.binaryPath}
              {report.binarySource && <span className="ml-1 font-sans">({ENGINE_SOURCE_LABEL[report.binarySource]})</span>}
            </p>
          )}

          {/* THE REFUSAL, when there is one — musl above all. It carries the sidecar instructions,
              which is what turns "no" into a path rather than a wall. */}
          {!report.resolution.ok && (
            <Alert variant="warning" className="mt-2">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>No published build can run on this host</AlertTitle>
              <AlertDescription>{report.resolution.message}</AlertDescription>
            </Alert>
          )}

          {/* THE OFFER, stated before the click and regardless of whether it is ever pressed. */}
          {report.resolution.ok && !installed && offer && <p className="mt-2 text-xs text-muted-foreground">{offer}</p>}

          {/* Mode is a separate refusal from platform: this host may have a perfectly good build
              available and still be one where a local binary would never be spawned. */}
          {report.resolution.ok && !report.installable && (
            <p className="mt-2 flex items-start gap-2 text-xs text-muted-foreground">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
              {report.sidecarInstructions}
            </p>
          )}

          {install && <EngineInstallProgress install={install} progress={progress} />}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {inFlight && install ? (
            <Button size="sm" variant="ghost" disabled={readOnly} onClick={() => onCancel(install.id)}>
              <X className="mr-1 h-3.5 w-3.5" />
              Cancel
            </Button>
          ) : (
            <Button
              size="sm"
              variant={installed ? "outline" : "default"}
              disabled={!canInstall}
              title={
                canInstall
                  ? (offer ?? undefined)
                  : report.resolution.ok
                    ? report.sidecarInstructions
                    : report.resolution.message
              }
              onClick={onInstall}
            >
              {installing ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Download className="mr-1 h-3.5 w-3.5" />}
              {installed ? "Reinstall the engine" : "Install the engine"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The install's progress, with the two steps that move no bytes given their own words.
 *
 * A bar frozen at 100% while an archive is hashed, extracted and then RUN is how an operator
 * concludes the install hung — the same reasoning `DownloadProgress` uses for `verifying`, and the
 * reason `installing` is a state here rather than a flicker at the end of the transfer.
 *
 * A SUCCESS SHOWS WHAT THE BINARY SAID. That string is the evidence behind the word "installed":
 * the installer ran the thing and got an answer, rather than assuming a file that extracted is a
 * file that works. Showing it is what lets an operator confirm the version themselves.
 */
function EngineInstallProgress({ install, progress }: { install: NativeEngineInstallRow; progress: number | null }) {
  if (install.status === "ready") {
    return (
      <div className="mt-2">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
          <span>
            {engineInstallStatusLabel(install.status)} — {install.assetName}, release {install.releaseTag}
          </span>
          <span className="tabular-nums">{formatBytes(install.fileSizeBytes)}</span>
          {install.sha256 && <span className="break-all font-mono text-[10px]">sha256 {install.sha256.slice(0, 16)}…</span>}
        </p>
        {install.versionOutput && (
          <p className="mt-1 break-words font-mono text-[10px] text-muted-foreground">it answered: {install.versionOutput.split("\n")[0]}</p>
        )}
      </div>
    );
  }

  if (install.status === "failed" || install.status === "cancelled") {
    return (
      <p className="mt-2 flex items-start gap-2 break-words text-xs">
        <AlertTriangle className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", install.status === "failed" ? "text-destructive" : "text-muted-foreground")} />
        <span className={install.status === "failed" ? "text-destructive" : "text-muted-foreground"}>
          {engineInstallStatusLabel(install.status)}
          {install.error ? ` — ${install.error}` : ""}
        </span>
      </p>
    );
  }

  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        <span>{engineInstallStatusLabel(install.status)}</span>
        <span className="tabular-nums">
          {formatBytes(install.bytesDownloaded)} of {formatBytes(install.bytesTotal)}
        </span>
      </div>
      <Progress
        value={progress ?? 100}
        indicatorClassName={progress === null ? "animate-pulse bg-muted-foreground/40" : "bg-primary"}
        className="mt-1 h-1.5"
      />
    </div>
  );
}

/* ── one model ──────────────────────────────────────────────────────────────────────────────── */

function ModelRow({
  entry,
  hardware,
  contextTokens,
  kvCacheType,
  download,
  isBestFitHere,
  runtime,
  readOnly,
  starting,
  benchmarking,
  onDownload,
  onCancel,
  onDelete,
  onRun,
  onBenchmark
}: {
  entry: NativeModelEntry;
  hardware: NativeHardwareSnapshot;
  contextTokens: number;
  kvCacheType: NativeKvCacheType;
  download: NativeModelDownloadRow | null;
  isBestFitHere: boolean;
  runtime: NativeRuntimeStatus | null;
  readOnly: boolean;
  starting: boolean;
  benchmarking: boolean;
  onDownload: () => void;
  onCancel: (id: string) => void;
  onDelete: (id: string) => void;
  onRun: () => void;
  onBenchmark: () => void;
}) {
  const ready = download?.status === "ready";
  const inFlight = download !== null && DOWNLOAD_IN_FLIGHT.has(download.status);
  const isRunning = runtime?.state === "ready" && runtime.modelId === entry.id;

  // The live recomputation: the same shared estimator the API runs, at the context and KV precision
  // currently selected on screen, against the measured file size once one exists.
  const fit = liveNativeFit({ hardware, entry, measuredFileSizeBytes: download?.fileSizeBytes, contextTokens, kvCacheType });
  const tone = fitVerdictTone(fit.verdict);
  const speed = selectSpeedFigure({ estimate: fit, benchmark: download?.benchmark });
  const modelWarnings = fit.warnings.filter((warning) => !isMachineWideWarning(warning.code));
  const usedPercent =
    fit.ram.availableBytes !== null && fit.ram.availableBytes > 0
      ? Math.min(100, Math.round((fit.ram.requiredBytes / fit.ram.availableBytes) * 100))
      : null;
  const progress = download ? downloadProgressPercent(download) : null;

  return (
    <div
      className={cn("flex min-w-0 flex-col rounded-lg border p-3 transition-shadow hover:shadow-soft", isRunning ? "border-primary/50 bg-primary/[0.03]" : "border-border")}
      data-native-model={entry.id}
    >
      {/* Title and badges on the left, the actions on the right; `basis-40` on the title keeps the
          action buttons wrapping at ONE width across the six cards rather than under whichever
          title happens to be longest. */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 basis-40">
          <p className="flex flex-wrap items-center gap-1.5 text-sm font-semibold">
            {entry.displayName}
            <Badge variant="outline" className="text-xs font-normal tabular-nums">
              {entry.parameterCountB}B · {entry.quantisation}
            </Badge>
            {/* The catalogue's pick and this machine's pick are marked SEPARATELY, because when
                they differ that difference is the most useful thing on the row. */}
            {entry.recommendedDefault && (
              <Badge variant="secondary" className="text-xs font-normal">
                Catalogue default
              </Badge>
            )}
            {isBestFitHere && (
              <Badge variant="info" className="text-xs font-normal">
                Best fit for this machine
              </Badge>
            )}
            {ready && !isRunning && (
              <Badge variant="muted" className="text-xs font-normal">
                On disk
              </Badge>
            )}
            {isRunning && (
              <Badge variant="success" className="text-xs font-normal">
                Running
              </Badge>
            )}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {!ready && !inFlight && (
            <Button size="sm" variant="outline" disabled={readOnly} onClick={onDownload}>
              <Download className="mr-1 h-3.5 w-3.5" />
              Download
            </Button>
          )}
          {inFlight && download && (
            <Button size="sm" variant="ghost" disabled={readOnly} onClick={() => onCancel(download.id)} aria-label={`Cancel the ${entry.displayName} download`}>
              <X className="mr-1 h-3.5 w-3.5" />
              Cancel
            </Button>
          )}
          {ready && !isRunning && (
            <Button
              size="sm"
              disabled={readOnly || starting || fit.verdict === "will-not-fit"}
              onClick={onRun}
              title={fit.verdict === "will-not-fit" ? `Not at this context: ${fit.reason}` : "Start llama-server on this model"}
            >
              {starting ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1 h-3.5 w-3.5" />}
              Run
            </Button>
          )}
          {isRunning && (
            <Button size="sm" variant="outline" disabled={readOnly || benchmarking} onClick={onBenchmark}>
              {benchmarking ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Gauge className="mr-1 h-3.5 w-3.5" />}
              Measure
            </Button>
          )}
          {ready && download && (
            <Button
              size="sm"
              variant="ghost"
              disabled={readOnly}
              onClick={() => onDelete(download.id)}
              aria-label={`Delete ${entry.displayName} from disk`}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* The verdict, with its reason on the face of the card. Never a bare badge. */}
      <div className="mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <Badge variant={tone.badge} className="text-xs font-normal">
          {tone.label}
        </Badge>
        <span className="text-xs">{fit.reason}</span>
      </div>
      {usedPercent !== null && (
        <Progress
          value={usedPercent}
          indicatorClassName={tone.meterClassName}
          className="mt-2 h-1.5"
          aria-label={`${entry.displayName} uses ${usedPercent}% of the memory available after the reserve`}
        />
      )}

      {/* The arithmetic behind that verdict, split so the operator can see which term the context
          moved. Scrolls inside itself rather than widening the page on a phone. */}
      <div className="mt-2 overflow-x-auto">
        <p className="flex min-w-max items-center gap-x-1.5 whitespace-nowrap text-xs text-muted-foreground">
          <span className="font-medium tabular-nums text-foreground">{formatBytes(fit.ram.weightBytes)}</span>
          <span>weights{fit.ram.weightSource === "catalogue" ? " (measured file)" : " (derived, not measured)"}</span>
          <span aria-hidden>+</span>
          <span className="font-medium tabular-nums text-foreground">{formatBytes(fit.ram.kvCacheBytes)}</span>
          <span>
            KV cache at {formatContextTokens(fit.contextTokens)}, {KV_LABEL[kvCacheType]}
          </span>
          <span aria-hidden>+</span>
          <span className="font-medium tabular-nums text-foreground">{formatBytes(fit.ram.runtimeOverheadBytes)}</span>
          <span>runtime</span>
          <span aria-hidden>=</span>
          <span className="font-medium tabular-nums text-foreground">{formatBytes(fit.ram.requiredBytes)}</span>
          <span>of {formatBytes(fit.ram.availableBytes)} available</span>
        </p>
      </div>

      {/* Speed. An estimate and a measurement are never allowed to look alike: dashed outline and a
          "≈" for the first, a solid badge and an exact figure for the second. */}
      <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
        {speed.source === "measured" ? (
          <Badge variant="success" className="text-xs font-normal">
            <Gauge className="mr-1 h-3 w-3" />
            Measured
          </Badge>
        ) : (
          <Badge variant="outline" className="border-dashed text-xs font-normal text-muted-foreground">
            {speed.label}
          </Badge>
        )}
        {speed.tokensPerSecond !== null && (
          <span className={cn("font-medium tabular-nums", speed.source === "measured" ? "text-foreground" : "text-muted-foreground")}>
            {speed.source === "measured" ? "" : "≈ "}
            {speed.tokensPerSecond} tokens/sec
          </span>
        )}
        {speed.timeToFirstTokenMs !== null && (
          <span className="tabular-nums text-muted-foreground">first token after {Math.round(speed.timeToFirstTokenMs)} ms</span>
        )}
        {speed.suggestedMaxOutputTokens !== null && (
          <span className="tabular-nums text-muted-foreground">
            · {speed.suggestedMaxOutputTokens} output tokens — what this machine can emit inside the 90-second call ceiling
          </span>
        )}
      </div>

      {modelWarnings.map((warning) => (
        <p key={warning.code} className="mt-1.5 flex items-start gap-2 text-xs text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
          {warning.message}
        </p>
      ))}

      {download && <DownloadProgress download={download} progress={progress} />}

      {/* The prose, folded: read once when choosing, never again when operating. A native
          <details> so it needs no state, works with the keyboard, and prints open. The verdict,
          the arithmetic and the speed figure above are NOT in here — those are the rule. */}
      <details className="group mt-auto pt-2 text-xs">
        <summary className="flex cursor-pointer list-none items-center gap-1 font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
          <ChevronRight className="h-3.5 w-3.5 transition-transform motion-reduce:transition-none group-open:rotate-90" aria-hidden />
          Good at, weak at, and the basis
        </summary>
        <div className="mt-2 grid gap-1.5 text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">Good at</span> {entry.goodAt}
          </p>
          <p>
            <span className="font-medium text-foreground">Weak at</span> {entry.weakAt}
          </p>
          <p className={cn(speed.source === "estimated" && "italic")}>{speed.basis}</p>
        </div>
      </details>
    </div>
  );
}

/**
 * The transfer, with verification as its OWN visible step.
 *
 * A bar frozen at 100% while a five-gigabyte file is re-read and hashed is how an operator concludes
 * the download hung, so `verifying` gets its own line saying what is happening and why no bytes are
 * moving. A failure prints the server's own sentence verbatim — it quotes what actually arrived, so
 * an HTML error page saved under a `.gguf` name reads as a diagnosis (`<!DO`) rather than as the
 * useless "verification failed".
 */
function DownloadProgress({ download, progress }: { download: NativeModelDownloadRow; progress: number | null }) {
  if (download.status === "ready") {
    return (
      <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
        <span>{downloadStatusLabel(download.status)}</span>
        <span className="tabular-nums">{formatBytes(download.fileSizeBytes)}</span>
        {download.sha256 && <span className="break-all font-mono text-[10px]">sha256 {download.sha256.slice(0, 16)}…</span>}
      </p>
    );
  }

  if (download.status === "failed" || download.status === "cancelled") {
    return (
      <p className="mt-2 flex items-start gap-2 break-words text-xs">
        <AlertTriangle className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", download.status === "failed" ? "text-destructive" : "text-muted-foreground")} />
        <span className={download.status === "failed" ? "text-destructive" : "text-muted-foreground"}>
          {downloadStatusLabel(download.status)}
          {download.error ? ` — ${download.error}` : ""}
        </span>
      </p>
    );
  }

  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        <span>{downloadStatusLabel(download.status)}</span>
        <span className="tabular-nums">
          {formatBytes(download.bytesDownloaded)} of {formatBytes(download.bytesTotal)}
          {progress === null && download.status === "downloading" && " — this server sent no total, so the bar cannot say how far along it is"}
        </span>
      </div>
      {/* An indeterminate transfer gets a full-width muted track rather than a bar pinned at 0%,
          which reads as "not started" for something that is visibly moving. */}
      <Progress
        value={progress ?? 100}
        indicatorClassName={progress === null ? "animate-pulse bg-muted-foreground/40" : "bg-primary"}
        className="mt-1 h-1.5"
      />
    </div>
  );
}

/* ── the knobs, shared with the Add provider dialog ─────────────────────────────────────────── */

/**
 * Threads, context and KV precision — with the CONSEQUENCE of each stated next to it rather than in
 * a tooltip, because every one of these is a trade an operator is making on someone else's behalf.
 *
 * EXPORTED because AIProviderListCard's Add-provider dialog offers the native kind and must present
 * the SAME three controls; a second copy of them would drift, and a copy that only looked the same
 * while writing different values would be worse. Neither `Slider` nor `RadioGroup` exists in this
 * app, and adding a dependency for one screen is not how this codebase does UI: the context steps
 * are a row of outline buttons, which is also more legible than a slider for four discrete values.
 */
export function NativeRuntimeTuningControls({
  className,
  idPrefix,
  disabled,
  hardware,
  recommendedThreads,
  threadsBasis,
  threads,
  onThreadsChange,
  contextTokens,
  recommendedContext,
  onContextChange,
  kvCacheType,
  onKvCacheTypeChange,
  model,
  layout = "stack"
}: {
  className?: string;
  idPrefix: string;
  disabled: boolean;
  hardware: NativeHardwareSnapshot;
  recommendedThreads: number | null;
  threadsBasis: string | null;
  threads: string;
  onThreadsChange: (value: string) => void;
  contextTokens: number;
  recommendedContext: number;
  onContextChange: (value: number) => void;
  kvCacheType: NativeKvCacheType;
  onKvCacheTypeChange: (value: NativeKvCacheType) => void;
  /** When a specific model is in play, its own maximum caps the steps offered. Omitted on the card
   *  itself, where the steps apply to every row and each row clamps its own figures. */
  model?: NativeModelEntry | null;
  /** "row": the three controls side by side with each explanation folded under a "Why" — the
   *  card's layout, where the same three paragraphs used to cost a screen. "stack" (default): the
   *  dialog's layout, where there is room and the explanation is the point. */
  layout?: "stack" | "row";
}) {
  const ceiling = nativeThreadCeiling(hardware);
  const steps = model ? contextStepsForModel(model) : [4096, 8192, 16384, 32768];
  const row = layout === "row";

  return (
    <div className={cn("grid gap-4", row && "sm:grid-cols-3", className)}>
      <div className="grid content-start gap-1.5">
        <Label htmlFor={`${idPrefix}-threads`}>Inference threads</Label>
        <Input
          id={`${idPrefix}-threads`}
          type="number"
          min={1}
          max={ceiling.max}
          className="max-w-[10rem]"
          value={threads}
          disabled={disabled}
          onChange={(event) => onThreadsChange(event.target.value)}
        />
        <TuningHint
          folded={row}
          lead={
            recommendedThreads !== null ? (
              <>
                Recommended <span className="font-medium tabular-nums text-foreground">{recommendedThreads}</span>, ceiling {ceiling.max}.
              </>
            ) : (
              <>No core count reported — llama.cpp's default unless you type one.</>
            )
          }
        >
          {recommendedThreads !== null ? (
            <>
              Recommended <span className="font-medium tabular-nums text-foreground">{recommendedThreads}</span> — {threadsBasis}. The
              recommendation is deliberately not every core: llama.cpp saturates whatever it is given, and a box with no core left
              for MySQL and the API answers the request that ASKED for the completion slowly.
            </>
          ) : (
            <>This machine would not report a core count, so llama.cpp's own default is used unless you type one.</>
          )}{" "}
          Ceiling {ceiling.max} — {ceiling.basis}.
        </TuningHint>
      </div>

      <div className="grid content-start gap-1.5">
        <Label>Context window</Label>
        <div className="flex flex-wrap gap-2">
          {steps.map((step) => (
            <Button
              key={step}
              type="button"
              size="sm"
              variant={step === contextTokens ? "default" : "outline"}
              disabled={disabled}
              aria-pressed={step === contextTokens}
              onClick={() => onContextChange(step)}
            >
              {formatContextTokens(step)}
            </Button>
          ))}
        </div>
        <TuningHint
          folded={row}
          lead={
            <>
              Recommended <span className="font-medium text-foreground">{formatContextTokens(recommendedContext)}</span>; each step doubles the KV cache.
            </>
          }
        >
          Steps rather than a free number, because every value between two powers of two buys cache nobody fills. Recommended{" "}
          <span className="font-medium text-foreground">{formatContextTokens(recommendedContext)}</span> for this machine — the
          recommendation never goes above 16k on purpose, since this app's own truncation caps mean its callers never send more.
          Each step doubles the KV cache; watch the memory line on each model move as you press these.
        </TuningHint>
      </div>

      <div className="grid content-start gap-1.5">
        <Label htmlFor={`${idPrefix}-kv`}>KV cache precision</Label>
        <Select value={kvCacheType} disabled={disabled} onValueChange={(value) => onKvCacheTypeChange(value as NativeKvCacheType)}>
          <SelectTrigger id={`${idPrefix}-kv`} className="max-w-[16rem]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="f16">16-bit (f16) — llama.cpp's default</SelectItem>
            <SelectItem value="q8_0">8-bit (q8_0) — half the cache</SelectItem>
          </SelectContent>
        </Select>
        <TuningHint folded={row} lead={<>8-bit halves what the context costs in memory.</>}>
          An 8-bit cache roughly halves the memory the context costs, for a small quality cost that is hard to see on the
          classification work this app sends a local model. It is the first thing to reach for when a model you want is one step
          of context away from fitting.
        </TuningHint>
      </div>
    </div>
  );
}

/** A control's explanation: the whole paragraph where there is room (the dialog), or one line with
 *  the rest behind "Why" where there is not (the card). The full text is identical in both. */
function TuningHint({ folded, lead, children }: { folded: boolean; lead: ReactNode; children: ReactNode }) {
  if (!folded) return <p className="text-xs text-muted-foreground">{children}</p>;
  return (
    <details className="group text-xs text-muted-foreground">
      <summary className="flex cursor-pointer list-none items-start gap-1 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 transition-transform motion-reduce:transition-none group-open:rotate-90" aria-hidden />
        <span>{lead}</span>
      </summary>
      <p className="mt-1.5 pl-[1.125rem]">{children}</p>
    </details>
  );
}
