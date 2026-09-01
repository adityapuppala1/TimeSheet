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
 * ── IT HAS TO BE HONEST WHEN NOTHING IS SET UP ───────────────────────────────────────────────
 *
 * The whole panel renders, and is useful, with no model downloaded, no llama-server binary
 * installed and the runtime off. That is the state EVERY installation is in the first time this
 * card is opened, so an empty state that looks broken is an empty state that gets a support ticket.
 * Each one names the next step instead.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  nativeContextLadder,
  nativeDownloadInFlightStatuses,
  nativeModelCatalogue,
  type NativeDownloadStatus,
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
  environmentSummary,
  fitVerdictTone,
  formatBytes,
  formatContextTokens,
  isMachineWideWarning,
  liveNativeFit,
  nativeThreadCeiling,
  selectSpeedFigure,
  type NativeBadgeVariant
} from "../../utils/native-model-panel";

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

  const startDownload = useMutation({
    mutationFn: (modelId: string) => settingsApi.startNativeAiDownload(modelId),
    onSuccess: () => {
      toast.success("Download started", { description: "It runs on the server — this page can be closed and the progress will still be here." });
      invalidateDownloads();
    },
    // A 507 names both the free space and the size needed; showing it verbatim is the whole point.
    onError: (err) => toast.error("Could not start the download", { description: errorMessage(err) })
  });
  const cancelDownload = useMutation({
    mutationFn: (id: string) => settingsApi.cancelNativeAiDownload(id),
    onSuccess: () => {
      toast.success("Download cancelled", { description: "The partial file was removed." });
      invalidateDownloads();
    },
    onError: (err) => toast.error("Could not cancel", { description: errorMessage(err) })
  });
  const deleteModel = useMutation({
    mutationFn: (id: string) => settingsApi.deleteNativeAiModel(id),
    onSuccess: () => {
      toast.success("Model deleted from this machine's disk");
      invalidateDownloads();
      queryClient.invalidateQueries({ queryKey: ["settings", "ai", "native", "capability"] });
    },
    onError: (err) => toast.error("Could not delete", { description: errorMessage(err) })
  });
  const startRuntime = useMutation({
    mutationFn: (modelId: string) => settingsApi.startNativeAiRuntime({ modelId, contextTokens, threads, kvCacheType }),
    onSuccess: (status) => {
      if (status.state === "ready") toast.success("The local model is running", { description: status.detail });
      else toast.error(`Runtime is ${status.state}`, { description: status.detail });
      invalidateRuntime();
    },
    onError: (err) => toast.error("Could not start the runtime", { description: errorMessage(err) })
  });
  const stopRuntime = useMutation({
    mutationFn: () => settingsApi.stopNativeAiRuntime(),
    onSuccess: (status) => {
      toast.success("Runtime stopped", { description: status.detail });
      invalidateRuntime();
    },
    onError: (err) => toast.error("Could not stop the runtime", { description: errorMessage(err) })
  });
  const restartRuntime = useMutation({
    mutationFn: () => settingsApi.restartNativeAiRuntime(),
    onSuccess: (status) => {
      toast.success(`Runtime is ${status.state}`, { description: status.detail });
      invalidateRuntime();
    },
    onError: (err) => toast.error("Could not restart the runtime", { description: errorMessage(err) })
  });
  const benchmark = useMutation({
    mutationFn: (modelId: string) => settingsApi.runNativeAiBenchmark(modelId),
    onSuccess: (result) => {
      toast.success(`Measured ${result.benchmark.tokensPerSecond} tokens/sec`, {
        description: `First token after ${Math.round(result.benchmark.timeToFirstTokenMs)} ms. This machine can emit about ${result.benchmark.suggestedMaxOutputTokens} tokens inside the 90-second call ceiling.`
      });
      invalidateDownloads();
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
      queryClient.invalidateQueries({ queryKey: ["settings", "ai", "providers"] });
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

            <div className="min-w-0 rounded-lg border border-border p-3">
              <p className="text-sm font-medium">Tuning</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Pre-filled with what the estimator recommends for this machine. Both numbers change the memory figures on every
                model below as you move them — that is the trade-off, made visible.
              </p>
              <NativeRuntimeTuningControls
                className="mt-3"
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
                <p className="text-sm font-medium">Models this deployment will run</p>
                <p className="text-xs text-muted-foreground">
                  A curated list, not a mirror of Hugging Face — every entry is picked for closing its JSON braces on a CPU.
                </p>
              </div>
              {nativeModelCatalogue.map((entry) => (
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
  const stoppable = status.state === "ready" || status.state === "starting" || status.state === "restarting";

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
          <p className="mt-1 text-xs text-muted-foreground">{status.detail}</p>
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
          {status.binaryProblem && (
            <p className="mt-2 flex items-start gap-2 text-xs text-muted-foreground">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
              {status.binaryProblem}
            </p>
          )}
          {status.lastError && (
            <p className="mt-2 flex items-start gap-2 break-words text-xs text-destructive">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {status.lastError}
            </p>
          )}
          {status.restarts.attempts > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              {status.restarts.attempts} of {status.restarts.maxAttempts} restart attempts used
              {status.restarts.lastExitCode !== null && ` · last exit code ${status.restarts.lastExitCode}`}
              {status.restarts.lastExitSignal && ` · signal ${status.restarts.lastExitSignal}`}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={readOnly || busy || !stoppable} onClick={onStop}>
            {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Square className="mr-1 h-3.5 w-3.5" />}
            Stop
          </Button>
          <Button size="sm" variant="outline" disabled={readOnly || busy || status.modelId === null} onClick={onRestart}>
            <RotateCw className="mr-1 h-3.5 w-3.5" />
            Restart
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={readOnly || benchmarking || !running || status.modelId === null}
            title="Send a short fixed prompt and time it — the only way to replace the speed estimate with a fact"
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
        <Button size="sm" disabled={readOnly || promoting || !running} onClick={onMakePrimary}>
          {promoting ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <ArrowUpToLine className="mr-1 h-3.5 w-3.5" />}
          {nativeProviderRow ? "Update and promote" : "Make it the primary provider"}
        </Button>
      </div>
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
    <div className={cn("min-w-0 rounded-lg border p-3", isRunning ? "border-primary/50 bg-primary/[0.03]" : "border-border")}>
      {/* basis-72 on the description column rather than a bare min-w-0: with only min-w-0 the
          column shrinks to whatever is left and the action buttons wrap under a long "good at"
          sentence on one row and not the next, so six otherwise identical cards line their buttons
          up in six different places. A basis makes the wrap happen at one width for all of them —
          which on a phone is every one of them. */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-72">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
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
          <p className="mt-1 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Good at</span> {entry.goodAt}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Weak at</span> {entry.weakAt}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
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
        <span className={cn("basis-full text-muted-foreground", speed.source === "estimated" && "italic")}>{speed.basis}</span>
      </div>

      {modelWarnings.map((warning) => (
        <p key={warning.code} className="mt-1.5 flex items-start gap-2 text-xs text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
          {warning.message}
        </p>
      ))}

      {download && <DownloadProgress download={download} progress={progress} />}
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
  model
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
}) {
  const ceiling = nativeThreadCeiling(hardware);
  const steps = model ? contextStepsForModel(model) : [4096, 8192, 16384, 32768];

  return (
    <div className={cn("grid gap-4", className)}>
      <div className="grid gap-1.5">
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
        <p className="text-xs text-muted-foreground">
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
        </p>
      </div>

      <div className="grid gap-1.5">
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
        <p className="text-xs text-muted-foreground">
          Steps rather than a free number, because every value between two powers of two buys cache nobody fills. Recommended{" "}
          <span className="font-medium text-foreground">{formatContextTokens(recommendedContext)}</span> for this machine — the
          recommendation never goes above 16k on purpose, since this app's own truncation caps mean its callers never send more.
          Each step doubles the KV cache; watch the memory line on each model move as you press these.
        </p>
      </div>

      <div className="grid gap-1.5">
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
        <p className="text-xs text-muted-foreground">
          An 8-bit cache roughly halves the memory the context costs, for a small quality cost that is hard to see on the
          classification work this app sends a local model. It is the first thing to reach for when a model you want is one step
          of context away from fitting.
        </p>
      </div>
    </div>
  );
}
