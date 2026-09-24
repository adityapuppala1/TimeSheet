export interface SetupStep {
  done: boolean;
  blocking?: boolean;
}

export function summarizeSetup<T extends SetupStep>(steps: readonly T[]) {
  const rank = (step: T) => {
    if (step.done) return 2;
    return step.blocking ? 0 : 1;
  };
  const ordered = [...steps].sort((a, b) => rank(a) - rank(b));
  return {
    ordered,
    total: steps.length,
    completed: steps.filter((step) => step.done).length,
    hasBlockingOpen: steps.some((step) => step.blocking && !step.done)
  };
}
