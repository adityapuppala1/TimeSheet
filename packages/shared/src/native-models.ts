/**
 * WHAT: the curated catalogue of GGUF models this deployment is willing to run on its OWN
 * hardware, under the managed `llama-server` that `config/native-ai.ts` addresses. Shared rather
 * than server-side so the model picker can render, sort and explain the list without a round trip,
 * and so the API and the UI can never disagree about which models exist.
 *
 * THIS IS A CURATED LIST FOR THIS APPLICATION. It is deliberately NOT a mirror of Hugging Face.
 * A picker with forty thousand entries makes the operator do the research; a picker with six makes
 * a claim and defends it. The claims are:
 *
 *  1. INSTRUCTION-FOLLOWING AND JSON RELIABILITY BEAT RAW SIZE. Five of this app's classifiers
 *     parse the model's reply as JSON and throw a hard 502 when it is malformed, and one of them
 *     sits on the inbound-email path — a model that returns almost-JSON does not degrade the
 *     feature, it drops real tickets on the floor. So "a bigger model that rambles" loses to "a
 *     smaller model that closes its braces" every time, and that ordering is why a 0.5B tier is
 *     absent from this file rather than present with a warning: at that size the brace-closing is
 *     not reliable enough to be worth the operator's disappointment.
 *
 *  2. GROUPED-QUERY ATTENTION MATTERS MORE THAN PARAMETER COUNT AT THE CONTEXT WE NEED. The app's
 *     own truncation caps mean a useful context here is ~16k tokens, and the KV cache at that
 *     context is not a rounding error — it is frequently larger than the difference between two
 *     adjacent model sizes. KV bytes are
 *         2 (K and V) x layers x kv_heads x head_dim x context x bytes_per_element
 *     so a model with 8 KV heads costs ~4x the KV of one with 2 at the same depth, and a model
 *     with 32 (plain multi-head attention, no grouping) costs ~16x. That is a bigger lever than
 *     1.5B-vs-3B, it is invisible on a model card, and encoding it is the single most useful thing
 *     this catalogue does. `phi-3.5-mini-q4_k_m` is in the list partly as the worked example: an
 *     excellent 3.8B model whose MHA attention makes it the most expensive entry here at 16k.
 *
 *  3. K-QUANTS, NOT I-QUANTS, AND Q4_K_M IS THE FLOOR. Below Q4_K_M the JSON reliability that claim
 *     1 rests on falls off sharply at these sizes — Q3 variants of a 3B model start losing closing
 *     braces, which is the exact failure this app cannot absorb. I-quants (IQ4_XS and relatives)
 *     buy their smaller files with more compute per weight and decode noticeably slower on a CPU
 *     without AVX-512, which is most production CPUs, so they are the wrong trade for a machine
 *     that is already CPU-bound.
 *
 *  4. CPU-ONLY. Nothing here needs a GPU to be useful. An operator running this on the box that
 *     already runs MySQL and Node is the entire audience.
 *
 * ADDING A VALUE: add the entry, and `nativeModelCatalogue` stays the only place that lists it —
 * the fit estimator, the picker and (later) the downloader all read this array. Two things will
 * fail loudly if the entry is wrong rather than merely absent: `native-model-catalogue.test.ts`
 * asserts every id is unique and that every entry carries the fields the estimator needs, and
 * `estimateNativeModelFit` divides by the architecture numbers, so a zero or a missing `layers`
 * produces an obviously broken estimate rather than a plausible one. That failure is the point.
 *
 * A NOTE ON THE NUMBERS, because a catalogue that guesses is worse than one that admits a gap:
 * - The architecture figures (layers / kv_heads / head_dim / max context) are each model's own
 *   published config, and they are what the KV maths runs on. The downloader block will verify
 *   them against the GGUF file's own metadata (`block_count`, `attention.head_count_kv`,
 *   `attention.key_length`) at download time, which is the only way to be certain.
 * - `fileSizeBytes` IS ABSENT ON EVERY ENTRY, deliberately. An exact byte count can only be known
 *   from the file, and a wrong one makes the fit estimator confidently wrong in the one direction
 *   that hurts (claiming a model fits when it does not). Until the downloader can record the real
 *   `Content-Length`, the estimator derives weight bytes from the quantisation's published
 *   bits-per-weight, marks the figure as derived, and errs high. See `nativeModelWeightBytes`.
 * - No SHA hashes are recorded here for the same reason. The downloader will record what it
 *   actually fetched.
 */

/**
 * The quantisations this app will serve, floor first. K-quants only — see claim 3 in the header.
 *
 * ADDING A VALUE: add it here AND to `nativeQuantBitsPerWeight` below, or the weight-size
 * derivation has no figure for it and TypeScript will say so at the `Record` — which is the check.
 */
export const nativeModelQuantisations = ["Q4_K_M", "Q5_K_M", "Q6_K", "Q8_0"] as const;
export type NativeModelQuantisation = (typeof nativeModelQuantisations)[number];

/**
 * llama.cpp's published average bits-per-weight for each K-quant, across the whole file.
 *
 * WHY AN AVERAGE AND NOT THE NOMINAL BIT WIDTH: a "4-bit" K-quant is not uniformly 4 bits. The
 * quantiser keeps the embedding and output tensors at higher precision (that is what the `_M`
 * suffix buys), and every block carries scale/min metadata alongside its weights. Q4_K_M lands
 * near 4.83 bits per weight in practice, not 4.00 — using 4.00 would under-estimate a 7B model's
 * file by roughly 800 MB, which is precisely the size of error that turns "comfortable" into an
 * OOM kill.
 */
export const nativeQuantBitsPerWeight: Record<NativeModelQuantisation, number> = {
  Q4_K_M: 4.83,
  Q5_K_M: 5.67,
  Q6_K: 6.56,
  Q8_0: 8.5
};

/**
 * Applied to a bits-per-weight derivation, never to a real measured file size.
 *
 * WHY IT EXISTS AND WHY IT IS ABOVE 1.0: spot-checking the derivation against real published GGUF
 * files puts it a consistent 3-4% LOW, because the per-tensor precision bumps are not perfectly
 * captured by a single average. An estimate that runs low is the dangerous direction here — it
 * tells the operator a model fits and the kernel disagrees. Rounding the error up costs a few
 * hundred megabytes of caution on a 7B model and costs nothing at all when the downloader later
 * replaces the derivation with the file's real size.
 */
export const nativeWeightEstimateSafetyFactor = 1.05;

/** How a model's on-disk weight size was arrived at — surfaced so the UI can say "about" instead
 *  of stating a derived number as if it were measured. */
export type NativeModelWeightSource = "catalogue" | "derived-from-quantisation";

/**
 * One model this deployment is willing to run. Everything the fit estimator needs, plus everything
 * the (later) downloader needs to fetch exactly the right file.
 */
export interface NativeModelEntry {
  /** Stable across renames — this is what a provider row and a download record will store. */
  id: string;
  displayName: string;
  /** Billions of parameters, as the model publishes them. Drives the derived weight size. */
  parameterCountB: number;
  quantisation: NativeModelQuantisation;
  /** Hugging Face repo id, exactly. */
  repo: string;
  /** File name within that repo, exactly. */
  file: string;
  /**
   * Absent on every entry today — see the header. Present means "measured", and the estimator
   * will prefer it over the derivation the moment the downloader records one.
   */
  fileSizeBytes?: number;
  /** Transformer block count — the `layers` term in the KV formula. */
  layers: number;
  /** KEY-VALUE heads, not attention heads. The GQA lever; see claim 2 in the header. */
  kvHeads: number;
  /** Per-head key/value width. */
  headDim: number;
  /** The model's own trained maximum. */
  maxContextTokens: number;
  /** What this app should actually ask for — bounded by the app's own truncation caps, so paying
   *  KV for more is paying for context the callers never fill. */
  recommendedContextTokens: number;
  /** One honest sentence each. The bad half is not optional: a catalogue with no downsides is
   *  marketing, and the operator finds out the hard way instead. */
  goodAt: string;
  weakAt: string;
  /** Exactly one entry carries this — asserted by the catalogue test. */
  recommendedDefault?: true;
}

/**
 * The list. Ordered smallest to largest, which is also roughly fastest to best.
 *
 * The spread is deliberate and spans the two ends the brief for this list asks for: the fastest
 * thing that still returns valid JSON (`qwen2.5-1.5b`) through the best quality that fits inside
 * 8 GB (`qwen2.5-7b`), with the GQA lesson made visible in the middle by three ~3B models whose KV
 * cost at 16k differs by more than 10x.
 */
export const nativeModelCatalogue: readonly NativeModelEntry[] = [
  {
    id: "qwen2.5-1.5b-instruct-q4_k_m",
    displayName: "Qwen2.5 1.5B Instruct",
    parameterCountB: 1.54,
    quantisation: "Q4_K_M",
    repo: "bartowski/Qwen2.5-1.5B-Instruct-GGUF",
    file: "Qwen2.5-1.5B-Instruct-Q4_K_M.gguf",
    layers: 28,
    kvHeads: 2,
    headDim: 128,
    maxContextTokens: 32768,
    recommendedContextTokens: 8192,
    goodAt:
      "The floor that still closes its braces: short classifications, label suggestions and yes/no routing, on a 2-core box, with a KV cache small enough to be an afterthought.",
    weakAt:
      "Anything needing a chain of reasoning or a long summary — it will answer confidently and shallowly, and it is the entry most likely to need a retry on a complex schema."
  },
  {
    id: "qwen2.5-3b-instruct-q4_k_m",
    displayName: "Qwen2.5 3B Instruct",
    parameterCountB: 3.09,
    quantisation: "Q4_K_M",
    repo: "bartowski/Qwen2.5-3B-Instruct-GGUF",
    file: "Qwen2.5-3B-Instruct-Q4_K_M.gguf",
    layers: 36,
    kvHeads: 2,
    headDim: 128,
    maxContextTokens: 32768,
    recommendedContextTokens: 16384,
    goodAt:
      "The best value in this list and the reason it is the default: solid structured-output discipline, and only 2 KV heads, so a full 16k context costs well under a gigabyte of cache — a 3B that behaves like a 1.5B on memory.",
    weakAt:
      "Long free-form writing reads flat, and it is not the one to hand a heavy generator that a cloud provider would do better.",
    recommendedDefault: true
  },
  {
    id: "llama-3.2-3b-instruct-q4_k_m",
    displayName: "Llama 3.2 3B Instruct",
    parameterCountB: 3.21,
    quantisation: "Q4_K_M",
    repo: "bartowski/Llama-3.2-3B-Instruct-GGUF",
    file: "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
    layers: 28,
    kvHeads: 8,
    headDim: 128,
    maxContextTokens: 131072,
    recommendedContextTokens: 8192,
    goodAt:
      "Warmer, more natural prose than the Qwen entries at the same size, and a genuinely long trained context if a future caller ever needs one.",
    weakAt:
      "8 KV heads against Qwen 3B's 2: at 16k its cache is roughly 3x larger for the same class of model. On a memory-constrained box that difference is the whole decision."
  },
  {
    id: "phi-3.5-mini-instruct-q4_k_m",
    displayName: "Phi-3.5 Mini Instruct (3.8B)",
    parameterCountB: 3.82,
    quantisation: "Q4_K_M",
    repo: "bartowski/Phi-3.5-mini-instruct-GGUF",
    file: "Phi-3.5-mini-instruct-Q4_K_M.gguf",
    layers: 32,
    kvHeads: 32,
    headDim: 96,
    maxContextTokens: 131072,
    recommendedContextTokens: 4096,
    goodAt:
      "Reasoning and step-following well above its size — the strongest entry here on a task that needs the model to actually think before it answers.",
    weakAt:
      "Plain multi-head attention, 32 KV heads and no grouping: its cache costs about 384 KiB per token, so 16k of context is over 6 GB of RAM before the weights are loaded. Read that number twice before raising its context — it is why this entry recommends 4k."
  },
  {
    id: "qwen2.5-3b-instruct-q5_k_m",
    displayName: "Qwen2.5 3B Instruct (Q5)",
    parameterCountB: 3.09,
    quantisation: "Q5_K_M",
    repo: "bartowski/Qwen2.5-3B-Instruct-GGUF",
    file: "Qwen2.5-3B-Instruct-Q5_K_M.gguf",
    layers: 36,
    kvHeads: 2,
    headDim: 128,
    maxContextTokens: 32768,
    recommendedContextTokens: 16384,
    goodAt:
      "The same default model with visibly less quantisation damage on structured output — the upgrade to reach for when the Q4 build is retrying more often than it should.",
    weakAt:
      "~17% more weight bytes than the Q4 build for a modest quality gain, and generation is slower in direct proportion, because CPU decoding is bound by how fast the weights can be read."
  },
  {
    id: "qwen2.5-7b-instruct-q4_k_m",
    displayName: "Qwen2.5 7B Instruct",
    parameterCountB: 7.62,
    quantisation: "Q4_K_M",
    repo: "bartowski/Qwen2.5-7B-Instruct-GGUF",
    file: "Qwen2.5-7B-Instruct-Q4_K_M.gguf",
    layers: 28,
    kvHeads: 4,
    headDim: 128,
    maxContextTokens: 32768,
    recommendedContextTokens: 16384,
    goodAt:
      "The best quality in this list that still fits an 8 GB machine: reliable JSON on awkward schemas, summaries worth reading, and a real shot at the work that currently has to go to a cloud provider.",
    weakAt:
      "About 5 GB of weights that must be read for every single token, so on a typical 4-core desktop CPU expect single-digit tokens per second. Fine for background classification, painful for anything a person is waiting on."
  }
];

/** Lookup by id — returns undefined rather than throwing, because the caller is usually rendering
 *  a stored id whose entry may have been removed from a later build of this list. */
export function findNativeModel(id: string): NativeModelEntry | undefined {
  return nativeModelCatalogue.find((entry) => entry.id === id);
}

/**
 * On-disk weight bytes for a model, and how we know.
 *
 * Prefers a measured `fileSizeBytes` when one exists; otherwise derives from the quantisation's
 * bits-per-weight with the safety factor applied. The `source` is returned rather than being an
 * internal detail because the UI must be able to render "~1.9 GB" instead of "1,946,157,056 B" —
 * a derived number displayed to the byte is a lie about its own precision.
 */
export function nativeModelWeightBytes(entry: NativeModelEntry): { bytes: number; source: NativeModelWeightSource } {
  if (typeof entry.fileSizeBytes === "number" && entry.fileSizeBytes > 0) {
    return { bytes: entry.fileSizeBytes, source: "catalogue" };
  }
  const bitsPerWeight = nativeQuantBitsPerWeight[entry.quantisation];
  const bytes = (entry.parameterCountB * 1e9 * bitsPerWeight) / 8;
  return { bytes: Math.round(bytes * nativeWeightEstimateSafetyFactor), source: "derived-from-quantisation" };
}
