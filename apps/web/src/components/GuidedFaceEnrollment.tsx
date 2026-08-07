/**
 * WHAT: the guided enrollment wizard — walks somebody through four head positions and captures one
 * good frame at each, so the stored reference set describes a range of angles rather than one.
 *
 * WHY THIS REPLACED A BURST, and it is the third of three measured causes of the feature not
 * working: enrollment used to grab the pressed frame plus three more 280ms apart. Nobody moves
 * meaningfully in 840ms, so all four templates described the same angle in the same light. A
 * verification taken later at any other angle scored 0.52-0.82 against a 0.75 bar. More frames of
 * one pose is not more information; it is the same information four times.
 *
 * Recognition accuracy falls roughly 10% from frontal to 60-degree yaw, so the poses here are
 * deliberately MODEST — a comfortable turn, not an extreme one. The goal is to cover the range a
 * person actually sits in front of a webcam, not to build a pose-invariant model.
 *
 * WHY IT NEVER ASKS FOR "LEFT": Human's yaw sign convention is not calibrated in this codebase
 * (see face.service.ts's challenge notes), so the wizard asks for "one side" and then "the other
 * side" and enforces only that the two are opposite. Naming a direction we cannot verify would
 * mean telling half the users they did it wrong when they did it right.
 *
 * DEGRADATION: with no tracker (no WebGL, models blocked) this component is not rendered at all —
 * FaceEnrollmentCard falls back to the original single-shot capture, which still works and still
 * stores a template. Guided enrollment is an accuracy improvement, never a prerequisite.
 */
import { useCallback, useRef, useState } from "react";
import { Check, Loader2, RefreshCw, ScanFace } from "lucide-react";

import { Button } from "./ui/button";
import { FaceCapture, type FaceCaptureHandle } from "./FaceCapture";
import { awaitNeutral, awaitPose, poseCoaching, type PoseBlock, type PoseTarget } from "../lib/face-pose";
import { cn } from "../lib/utils";

interface Step {
  key: string;
  title: string;
  help: string;
  /** null = the neutral baseline every other step is measured against. */
  target: PoseTarget | null;
}

/**
 * Four steps, and four is a considered number rather than a round one. Each extra pose is another
 * few seconds a new joiner spends in front of a camera on their first day, and the returns fall
 * away quickly: centre plus two sides plus one vertical already spans the angles a seated person
 * presents to a laptop. More would be a worse trade.
 */
const STEPS: Step[] = [
  {
    key: "centre",
    title: "Look straight at the camera",
    help: "Get comfortable and hold still for a second.",
    target: null
  },
  {
    key: "side-a",
    title: "Turn your head slowly to one side",
    help: "About as far as you'd turn to look at someone next to you.",
    target: { axis: "yaw", minDelta: 0.26, direction: null }
  },
  {
    key: "side-b",
    title: "Now turn to the other side",
    help: "Same amount, the opposite way.",
    target: { axis: "yaw", minDelta: 0.26, direction: null }
  },
  {
    key: "vertical",
    title: "Tilt your head up slightly",
    help: "A small movement is enough — just change the angle.",
    target: { axis: "pitch", minDelta: 0.17, direction: null }
  }
];

const STEP_WINDOW_MS = 12_000;

export function GuidedFaceEnrollment({
  onComplete,
  onCancel,
  busy
}: {
  /** Called with one frame per successfully captured pose. */
  onComplete: (frames: Blob[]) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const captureRef = useRef<FaceCaptureHandle | null>(null);
  const cancelledRef = useRef(false);
  const [running, setRunning] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [pose, setPose] = useState<{ progress: number; block: PoseBlock }>({ progress: 0, block: "short" });
  const [captured, setCaptured] = useState<Blob[]>([]);
  const [note, setNote] = useState<string | null>(null);

  const run = useCallback(async () => {
    cancelledRef.current = false;
    setRunning(true);
    setCaptured([]);
    setNote(null);

    const frames: Blob[] = [];
    const getReading = () => captureRef.current?.getReading();
    const captureFrame = async () => (await captureRef.current?.captureFrame()) ?? null;
    const isCancelled = () => cancelledRef.current;

    try {
      // Step 1 — the baseline. Everything else is a delta from this, so it is the one step that
      // has to be right; a baseline taken mid-turn would make every later target wrong.
      setStepIndex(0);
      setNote(null);
      const neutral = await awaitNeutral({ getReading, windowMs: STEP_WINDOW_MS, isCancelled });
      if (cancelledRef.current) return;
      if (!neutral) {
        setNote("We couldn't get a clear, steady view of your face. Check your lighting and try again.");
        setRunning(false);
        return;
      }
      const neutralFrame = await captureFrame();
      if (neutralFrame) frames.push(neutralFrame);
      setCaptured([...frames]);

      // Steps 2-4. The second side must be the opposite sign from the first, which is how two
      // genuinely different profiles are guaranteed without naming a physical direction.
      let firstSideSign: 1 | -1 | null = null;

      for (let i = 1; i < STEPS.length; i += 1) {
        if (cancelledRef.current) return;
        setStepIndex(i);
        setPose({ progress: 0, block: "short" });
        const step = STEPS[i];
        const target: PoseTarget = {
          ...step.target!,
          direction: step.key === "side-b" && firstSideSign ? ((firstSideSign * -1) as 1 | -1) : null
        };

        const result = await awaitPose({
          getReading,
          captureFrame,
          neutral,
          target,
          windowMs: STEP_WINDOW_MS,
          onProgress: (progress, block) => setPose({ progress, block }),
          isCancelled
        });
        if (cancelledRef.current) return;

        if (result.blob) {
          frames.push(result.blob);
          setCaptured([...frames]);
          if (step.key === "side-a") {
            const reading = getReading();
            if (reading) firstSideSign = Math.sign(reading.yaw - neutral.yaw) >= 0 ? 1 : -1;
          }
        }
        // A missed pose is NOT fatal. Three good templates beat refusing to enrol somebody whose
        // neck doesn't turn that far, or who is on a laptop propped at an awkward angle. The
        // server independently refuses the whole enrollment if nothing usable arrives.
      }

      if (cancelledRef.current) return;
      if (frames.length === 0) {
        setNote("We couldn't capture a usable image. Check your lighting and try again.");
        setRunning(false);
        return;
      }
      onComplete(frames);
    } finally {
      setPose({ progress: 0, block: "short" });
      setRunning(false);
    }
  }, [onComplete]);

  const step = STEPS[stepIndex];
  const done = captured.length;

  return (
    <div className="grid gap-4">
      {/* flex-wrap: on narrow phones the four step chips drop below the title instead of
          squeezing it into a one-word-per-line column. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold">{running ? step.title : "Four quick positions"}</p>
          <p className="text-xs text-muted-foreground">
            {running
              ? step.help
              : // Says WHAT the angles buy, not just that there are angles. A model built from one
                // pose scores 0.52-0.82 against a 0.75 bar the moment you sit differently — which
                // is felt later as an unexplained "we couldn't confirm it's you", with no visible
                // connection back to the fifteen seconds skipped here.
                "Four angles, about fifteen seconds. A model built from a single pose only recognises you sitting exactly as you are now — these four cover how you'll actually be sitting on the day, which is what stops later checks failing for no visible reason."}
          </p>
        </div>
        <div className="flex shrink-0 gap-1" aria-label={`${done} of ${STEPS.length} captured`}>
          {STEPS.map((s, i) => (
            <span
              key={s.key}
              className={cn(
                "grid h-6 w-6 place-items-center rounded-full border text-[10px] font-semibold transition",
                i < done
                  ? "border-success bg-success text-success-foreground"
                  : running && i === stepIndex
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground"
              )}
            >
              {i < done ? <Check className="h-3 w-3" /> : i + 1}
            </span>
          ))}
        </div>
      </div>

      <FaceCapture
        ref={captureRef}
        onCapture={() => {
          /* The wizard drives capture imperatively; controls="none" removes the component's own
             shutter — which used to render as a second, DEAD "Start" beside the wizard's real
             one. Camera-enable/retry stays with FaceCapture in every mode. */
        }}
        busy={busy || running}
        autoStart
        overlayText={running ? step.title : null}
        poseMeter={
          running && step.target
            ? {
                progress: pose.progress,
                satisfied: pose.block === "ready",
                coaching: poseCoaching(pose.block, step.target.axis, pose.progress),
                secondsLeft: null
              }
            : null
        }
        controls="none"
      />

      {running && step.target && (
        <div className="grid gap-1.5">
          <div
            role="progressbar"
            aria-label={`${step.title} progress`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(pose.progress * 100)}
            className="h-2 w-full overflow-hidden rounded-full bg-muted"
          >
            <div
              className={cn(
                "h-full rounded-full motion-safe:transition-[width,background-color] motion-safe:duration-100",
                pose.block === "ready" ? "bg-success" : "bg-primary"
              )}
              style={{ width: `${Math.round(pose.progress * 100)}%` }}
            />
          </div>
          <p className="text-center text-xs text-muted-foreground" role="status" aria-live="polite">
            {poseCoaching(pose.block, step.target.axis, pose.progress)}
          </p>
        </div>
      )}

      {/* The captures are done and the server is now validating each shot and building the
          template set — without this line that stretch reads as a hang, and people re-click. */}
      {busy && !running && (
        <div className="grid gap-1.5" role="status" aria-live="polite">
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full w-1/2 animate-pulse rounded-full bg-primary" />
          </div>
          <p className="text-center text-xs text-muted-foreground">
            Training your face model — validating and storing each shot…
          </p>
        </div>
      )}

      {note && <p className="text-sm text-destructive">{note}</p>}

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void run()} disabled={running || busy}>
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScanFace className="h-4 w-4" />}
          {running ? "Follow the prompts…" : done > 0 ? "Start over" : "Start"}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            cancelledRef.current = true;
            setRunning(false);
            onCancel();
          }}
          disabled={busy}
        >
          {running ? <RefreshCw className="h-4 w-4" /> : null}
          Cancel
        </Button>
      </div>
    </div>
  );
}
