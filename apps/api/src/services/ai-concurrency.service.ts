/**
 * WHAT: a per-provider concurrency gate for AI calls — how many requests may be in flight against
 * one `AIProviderConfig` at a time, and how long a caller waits for a slot before giving up on
 * that provider and trying the next one.
 *
 * WHY IT EXISTS: `callChat` had no bound of any kind, so N simultaneous users opened N simultaneous
 * provider sockets. That is survivable against a hosted API and actively bad against a self-hosted
 * Ollama, which does not reject excess load — it QUEUES it (OLLAMA_NUM_PARALLEL served at once,
 * OLLAMA_MAX_QUEUE waiting, then HTTP 503). So twelve people asking at once produced twelve
 * requests all sitting inside Ollama until the 90-second client timeout fired, with nothing to
 * show for the wait. Bounding admission HERE, outside the provider, is what turns "everyone waits
 * 90s and fails" into "two run, the rest fall over to another provider or are told to retry".
 *
 * WHY IN-MEMORY, STATED PLAINLY: this bounds load PER API PROCESS. One process in front of one
 * Ollama box — the deployment this is for — is exactly bounded. Behind a multi-process/multi-pod
 * deployment each process would enforce its own ceiling, so the effective limit is
 * `processes × maxConcurrent`; a genuinely global limit would need a shared counter (Redis, or a
 * DB row like `AiSpendMonth`'s admission token). That is a real limitation, not a rounding error,
 * and it is written here rather than discovered later.
 *
 * WHY NOT A LIBRARY: the whole mechanism is a counter and a FIFO of waiters. `p-limit` and friends
 * would add a dependency to own thirty lines that need to behave in exactly one specific way —
 * particularly around releasing on the throw path, which is the one bug that would matter (a
 * leaked permit wedges a provider permanently).
 */

interface Gate {
  inFlight: number;
  /** FIFO — first waiter in is first served, so a burst can't starve its earliest caller. */
  waiters: Array<{ resolve: () => void; timer: NodeJS.Timeout }>;
}

const gates = new Map<string, Gate>();

/** Callers that share no config id (the synthesised default provider) share one bucket, which is
 *  correct: they are all pointed at the same place. */
function gateFor(key: string): Gate {
  let gate = gates.get(key);
  if (!gate) {
    gate = { inFlight: 0, waiters: [] };
    gates.set(key, gate);
  }
  return gate;
}

export type AcquireResult =
  | { ok: true; release: () => void }
  | { ok: false; reason: "timeout" };

/**
 * Takes a slot on `key`, waiting up to `waitMs` for one to free up.
 *
 * Returns a `release` the caller MUST invoke — in a `finally`, never on the happy path alone.
 * Releasing twice is harmless (guarded), because the alternative is a caller having to reason
 * about whether an error path already released.
 */
export function acquireAiSlot(key: string, maxConcurrent: number, waitMs: number): Promise<AcquireResult> {
  const gate = gateFor(key);
  // A non-positive ceiling would deadlock every caller forever; treat it as "unconfigured, allow 1"
  // rather than honouring an obviously wrong value.
  const ceiling = maxConcurrent > 0 ? maxConcurrent : 1;

  if (gate.inFlight < ceiling) {
    gate.inFlight += 1;
    return Promise.resolve({ ok: true, release: makeRelease(key) });
  }

  return new Promise<AcquireResult>((resolve) => {
    const timer = setTimeout(() => {
      // Drop ourselves from the queue so a later release doesn't hand a slot to a caller that has
      // already given up and moved to the next provider — that slot would be leaked.
      const index = gate.waiters.findIndex((w) => w.timer === timer);
      if (index >= 0) gate.waiters.splice(index, 1);
      resolve({ ok: false, reason: "timeout" });
    }, waitMs);

    gate.waiters.push({
      resolve: () => {
        clearTimeout(timer);
        resolve({ ok: true, release: makeRelease(key) });
      },
      timer
    });
  });
}

function makeRelease(key: string): () => void {
  let released = false;
  return () => {
    if (released) return; // idempotent on purpose — see acquireAiSlot's doc comment
    released = true;
    const gate = gates.get(key);
    if (!gate) return;

    const next = gate.waiters.shift();
    if (next) {
      // Hand the slot straight to the next waiter rather than decrementing and letting them race
      // for it — inFlight stays constant, which is the invariant that keeps the ceiling honest.
      next.resolve();
      return;
    }
    gate.inFlight = Math.max(0, gate.inFlight - 1);
    // Nothing in flight and nobody waiting: drop the bucket so this map can't grow unbounded across
    // the lifetime of a process that has seen many provider configs.
    if (gate.inFlight === 0 && gate.waiters.length === 0) gates.delete(key);
  };
}

/** Test-only: module state is shared by every test in a file. */
export function __resetAiConcurrencyForTests() {
  for (const gate of gates.values()) {
    for (const waiter of gate.waiters) clearTimeout(waiter.timer);
  }
  gates.clear();
}

/** Test/diagnostic: how many calls are currently in flight against a key. */
export function __aiSlotsInFlight(key: string): number {
  return gates.get(key)?.inFlight ?? 0;
}
