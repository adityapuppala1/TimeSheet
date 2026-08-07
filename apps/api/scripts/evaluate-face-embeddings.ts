/**
 * FACE EMBEDDING SEPARATION REPORT — the harness that answers "would a stronger face model
 * actually help?" with measurements instead of opinion.
 *
 * THE QUESTION IT EXISTS FOR. A quarter of this workspace's real verification attempts come back
 * NO_MATCH, and the obvious reaction is "the embedding model is too weak, swap it for an
 * InsightFace-class one". That is a decision that invalidates every stored enrollment (see
 * FACE_MODEL_VERSION in face.service.ts), so it needs evidence. The evidence is the shape of two
 * distributions:
 *
 *   GENUINE  — similarity between two templates OF THE SAME PERSON.
 *   IMPOSTOR — similarity between templates of DIFFERENT people.
 *
 * If those two clusters are well separated, no threshold can be blamed on the model: the threshold
 * is simply sitting in the wrong place, and moving it is a settings change. If they OVERLAP, no
 * threshold exists that admits genuine users without admitting impostors, and only a better
 * embedding can fix that. That is the whole test.
 *
 * WHAT IT DELIBERATELY DOES NOT MEASURE. These are enrollment-template-to-enrollment-template
 * comparisons: all captured in one session, in one light, seconds apart. Live verification compares
 * a capture taken weeks later in a different room. So the genuine numbers here are an OPTIMISTIC
 * CEILING on live genuine similarity, and the FRR computed from them is a floor. Section 5 puts the
 * real observed live scores next to them precisely so the gap is visible rather than assumed.
 *
 * READ-ONLY. Every query is a find/count/groupBy; the script writes, deletes and purges nothing,
 * and is safe to run against production. It NEVER prints an embedding, a template, an image path,
 * a name or an email — subjects are anonymous ordinals and everything reported is a statistic.
 *
 * Run from apps/api:  npx dotenv-cli -e .env -- npx tsx scripts/evaluate-face-embeddings.ts
 */
import { prisma } from "../src/config/prisma.js";
import { requireTenantContext } from "../src/config/tenant-context.js";
import { decodeEmbedding, FACE_MODEL_VERSION, getFaceSettings, MULTI_POSE_TEMPLATE_MIN, similarity } from "../src/services/face.service.js";
import { runForEveryOrg } from "../src/workers/run-for-every-org.js";

/**
 * The counts below which a number is a coincidence rather than a measurement.
 *
 * The "rule of three": observing zero failures in n trials only bounds the true rate at 3/n with
 * 95% confidence. 100 impostor pairs therefore cannot demonstrate a false-accept rate below 3% no
 * matter how clean they look — which is two orders of magnitude away from any rate you would put in
 * front of a customer. These floors are the point at which the report stops saying "insufficient".
 */
const MIN_GENUINE_PAIRS = 30;
const MIN_IMPOSTOR_PAIRS = 200;

interface Stats {
  n: number;
  mean: number;
  sd: number;
  min: number;
  max: number;
  p05: number;
  p50: number;
  p95: number;
}

function stats(values: number[]): Stats {
  if (values.length === 0) return { n: 0, mean: NaN, sd: NaN, min: NaN, max: NaN, p05: NaN, p50: NaN, p95: NaN };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  // Population SD: these ARE every pair that exists in the corpus, not a sample drawn from it.
  const sd = Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
  return { n: values.length, mean, sd, min: sorted[0], max: sorted[sorted.length - 1], p05: at(0.05), p50: at(0.5), p95: at(0.95) };
}

const f = (v: number, digits = 3) => (Number.isFinite(v) ? v.toFixed(digits) : "—");
const pct = (v: number) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : "—");

function printStats(label: string, s: Stats): void {
  if (s.n === 0) {
    console.log(`  ${label.padEnd(22)} no pairs`);
    return;
  }
  console.log(
    `  ${label.padEnd(22)} n=${String(s.n).padStart(6)}  mean=${f(s.mean)}  sd=${f(s.sd)}  ` +
      `min=${f(s.min)}  p05=${f(s.p05)}  p50=${f(s.p50)}  p95=${f(s.p95)}  max=${f(s.max)}`
  );
}

/**
 * Fisher's discriminant (d'), the standard single number for "how far apart are two distributions
 * relative to how wide they are". Biometrics convention: d' below ~2 is poor, ~3 is workable, above
 * ~4 is strong. Reported alongside the raw gap because a large gap between two very wide clusters
 * separates nothing, and the gap alone would hide that.
 */
function dPrime(genuine: Stats, impostor: Stats): number {
  const pooled = Math.sqrt((genuine.sd ** 2 + impostor.sd ** 2) / 2);
  return pooled > 0 ? (genuine.mean - impostor.mean) / pooled : NaN;
}

interface SweepRow {
  threshold: number;
  /** Fraction of impostor pairs that would be ACCEPTED at this threshold. */
  far: number;
  /** Fraction of genuine pairs that would be REJECTED at this threshold. */
  frr: number;
}

function sweep(genuine: number[], impostor: number[]): SweepRow[] {
  const rows: SweepRow[] = [];
  // Human's similarity() rounds to 2dp and clamps to 0..1, so a finer step would only invent
  // resolution the metric does not have.
  for (let t = 0; t <= 1.0001; t += 0.01) {
    const threshold = Number(t.toFixed(2));
    rows.push({
      threshold,
      far: impostor.length ? impostor.filter((v) => v >= threshold).length / impostor.length : NaN,
      frr: genuine.length ? genuine.filter((v) => v < threshold).length / genuine.length : NaN
    });
  }
  return rows;
}

/** The equal-error point — where a false accept and a false reject are equally likely. The single
 *  number that describes a matcher independently of where anyone chose to put the threshold. */
function equalError(rows: SweepRow[]): SweepRow | null {
  const usable = rows.filter((r) => Number.isFinite(r.far) && Number.isFinite(r.frr));
  if (usable.length === 0) return null;
  return usable.reduce((best, row) => (Math.abs(row.far - row.frr) < Math.abs(best.far - best.frr) ? row : best));
}

interface Subject {
  /** Anonymous ordinal — no name, no email, no id ever leaves this process. */
  ordinal: number;
  templates: number[][];
  multiPose: boolean;
  userId: string;
}

async function loadSubjects(): Promise<Subject[]> {
  const enrollments = await prisma.faceEnrollment.findMany({
    where: { modelVersion: FACE_MODEL_VERSION },
    select: { id: true, userId: true, encryptedEmbedding: true },
    orderBy: { createdAt: "asc" }
  });
  if (enrollments.length === 0) return [];

  const extras = await prisma.faceEnrollmentTemplate.findMany({
    where: { enrollmentId: { in: enrollments.map((e) => e.id) }, modelVersion: FACE_MODEL_VERSION },
    select: { enrollmentId: true, encryptedEmbedding: true }
  });
  const byEnrollment = new Map<string, string[]>();
  for (const row of extras) {
    const list = byEnrollment.get(row.enrollmentId) ?? [];
    list.push(row.encryptedEmbedding);
    byEnrollment.set(row.enrollmentId, list);
  }

  return enrollments.map((enrollment, index) => {
    const ciphertexts = [enrollment.encryptedEmbedding, ...(byEnrollment.get(enrollment.id) ?? [])];
    // A corrupt/undecryptable row must not abort the whole report — drop it and let the counts
    // show the shortfall.
    const templates = ciphertexts
      .map((c) => {
        try {
          return decodeEmbedding(c);
        } catch {
          return null;
        }
      })
      .filter((v): v is number[] => Array.isArray(v) && v.length > 0);
    return {
      ordinal: index + 1,
      userId: enrollment.userId,
      templates,
      multiPose: templates.length >= MULTI_POSE_TEMPLATE_MIN
    };
  });
}

async function report(): Promise<void> {
  const settings = await getFaceSettings();
  const subjects = await loadSubjects();

  console.log(`\n${"=".repeat(96)}`);
  console.log(`ORG: ${requireTenantContext().orgSlug}   model: ${FACE_MODEL_VERSION}   matchThreshold: ${settings.matchThreshold}`);
  console.log("=".repeat(96));

  if (subjects.length === 0) {
    console.log("\nNo enrollments on the current model version. Nothing to evaluate.\n");
    return;
  }

  // --- 1. corpus -----------------------------------------------------------------------------
  const multi = subjects.filter((s) => s.multiPose);
  const single = subjects.filter((s) => !s.multiPose);
  const totalTemplates = subjects.reduce((sum, s) => sum + s.templates.length, 0);

  console.log("\n=== 1. Corpus ===");
  console.log(`  enrolled subjects        ${subjects.length}`);
  console.log(`  templates total          ${totalTemplates} (${(totalTemplates / subjects.length).toFixed(1)} per subject)`);
  console.log(`  multi-pose (>=${MULTI_POSE_TEMPLATE_MIN})         ${multi.length}`);
  console.log(`  single-pose (<${MULTI_POSE_TEMPLATE_MIN})         ${single.length}`);
  console.log(`  template-count histogram ${histogram(subjects.map((s) => s.templates.length))}`);

  // --- 2. genuine vs impostor ----------------------------------------------------------------
  const genuine: number[] = [];
  const genuineMulti: number[] = [];
  const genuineSingle: number[] = [];
  for (const subject of subjects) {
    for (let i = 0; i < subject.templates.length; i++) {
      for (let j = i + 1; j < subject.templates.length; j++) {
        const score = await similarity(subject.templates[i], subject.templates[j]);
        genuine.push(score);
        (subject.multiPose ? genuineMulti : genuineSingle).push(score);
      }
    }
  }

  const impostor: number[] = [];
  const impostorMultiOnly: number[] = [];
  for (let a = 0; a < subjects.length; a++) {
    for (let b = a + 1; b < subjects.length; b++) {
      for (const left of subjects[a].templates) {
        for (const right of subjects[b].templates) {
          const score = await similarity(left, right);
          impostor.push(score);
          if (subjects[a].multiPose && subjects[b].multiPose) impostorMultiOnly.push(score);
        }
      }
    }
  }

  /**
   * BEST-OF-SET, which is what the product actually decides on. `matchAgainstEnrollment` compares a
   * probe against EVERY stored template and keeps the highest score, so a decision is never made on
   * a random pair — it is made on the best of N. Scoring pairwise (above) therefore understates
   * genuine performance and overstates impostor risk in exactly opposite directions, and a verdict
   * drawn from it would be wrong twice.
   *
   * Leave-one-out: each template takes a turn as the probe against the rest of its own subject's
   * set (genuine) and against each other subject's whole set (impostor). This mirrors production
   * one for one.
   */
  const genuineBest: number[] = [];
  const impostorBest: number[] = [];
  for (let a = 0; a < subjects.length; a++) {
    for (let k = 0; k < subjects[a].templates.length; k++) {
      const probe = subjects[a].templates[k];
      const own = subjects[a].templates.filter((_, index) => index !== k);
      if (own.length > 0) {
        let best = 0;
        for (const t of own) best = Math.max(best, await similarity(probe, t));
        genuineBest.push(best);
      }
      for (let b = 0; b < subjects.length; b++) {
        if (b === a) continue;
        let best = 0;
        for (const t of subjects[b].templates) best = Math.max(best, await similarity(probe, t));
        impostorBest.push(best);
      }
    }
  }

  const g = stats(genuine);
  const i = stats(impostor);
  const gb = stats(genuineBest);
  const ib = stats(impostorBest);

  console.log("\n=== 2. Genuine vs impostor similarity ===");
  console.log("  Genuine = two templates of the SAME subject. Impostor = templates of DIFFERENT subjects.");
  console.log("  Note: Human's similarity() rounds to 2dp and clamps to 0..1 — a reported 0.00 means");
  console.log("  'at or below the floor', not a measured zero.\n");
  printStats("genuine · pairwise", g);
  printStats("impostor · pairwise", i);
  printStats("genuine · best-of-set", gb);
  printStats("impostor · best-of-set", ib);
  console.log(`\n  best-of-set is the one that decides anything — matchAgainstEnrollment keeps the highest`);
  console.log(`  score across the whole enrollment, so every line below is computed from it.\n`);
  console.log(`  gap (mean_g - mean_i)  ${f(gb.mean - ib.mean)}`);
  console.log(`  d' (Fisher)            ${f(dPrime(gb, ib), 2)}   [<2 poor · ~3 workable · >4 strong]`);
  if (gb.n > 0 && ib.n > 0) {
    const overlapping = ib.max >= gb.min;
    console.log(
      `  overlap                ${overlapping ? `YES — worst genuine ${f(gb.min)} <= best impostor ${f(ib.max)}` : `NO — every genuine probe (min ${f(gb.min)}) outscores every impostor probe (max ${f(ib.max)})`}`
    );
    console.log(`  genuine below max impostor   ${genuineBest.filter((v) => v <= ib.max).length} of ${gb.n}`);
    console.log(`  impostor above min genuine   ${impostorBest.filter((v) => v >= gb.min).length} of ${ib.n}`);
  }

  // --- 3. threshold sweep --------------------------------------------------------------------
  const rows = sweep(genuineBest, impostorBest);
  const eer = equalError(rows);
  const atCurrent = rows.find((r) => Math.abs(r.threshold - settings.matchThreshold) < 0.005);

  console.log("\n=== 3. Error rates across candidate thresholds ===");
  console.log("  FAR = impostor probes accepted. FRR = genuine probes rejected, best-of-set as production");
  console.log("  scores it. Template-to-template, so the real FRR is WORSE: every template here was shot");
  console.log("  in one session, and a live check weeks later is a harder comparison than any of these.\n");
  console.log("  threshold    FAR      FRR");
  for (const row of rows) {
    // Only the operating band is worth printing; below 0.5 everything is accepted and above 0.95
    // everything is rejected, and 100 lines of that buries the region a decision is made in.
    if (row.threshold < 0.5 || row.threshold > 0.95) continue;
    const marker = atCurrent && row.threshold === atCurrent.threshold ? "  <- configured" : eer && row.threshold === eer.threshold ? "  <- equal-error" : "";
    console.log(`    ${row.threshold.toFixed(2)}      ${pct(row.far).padStart(6)}   ${pct(row.frr).padStart(6)}${marker}`);
  }
  if (eer) console.log(`\n  equal-error point      threshold ${eer.threshold.toFixed(2)} at EER ~${pct((eer.far + eer.frr) / 2)}`);
  if (atCurrent) console.log(`  at configured ${settings.matchThreshold}       FAR ${pct(atCurrent.far)} · FRR ${pct(atCurrent.frr)}`);

  // --- 4. by enrollment quality --------------------------------------------------------------
  console.log("\n=== 4. Broken down by enrollment quality ===");
  console.log("  THE HYPOTHESIS UNDER TEST: thin enrollments, not a weak model, produce the marginal scores.\n");
  printStats("genuine · multi-pose", stats(genuineMulti));
  printStats("genuine · single-pose", stats(genuineSingle));
  printStats("impostor · multi only", stats(impostorMultiOnly));
  console.log(`  (pairwise, not best-of-set: a single-pose subject has no set to take a best of.)`);
  if (genuineSingle.length === 0) {
    console.log(
      `\n  Single-pose subjects contribute ZERO genuine pairs — a one-template enrollment has nothing\n` +
        `  to compare against itself. That is not a gap in this script; it is the finding. Those subjects\n` +
        `  have no measurable within-person consistency at all, and every live check they make is a\n` +
        `  single unrehearsed angle against a single stored angle.`
    );
  }

  // --- 5. live cross-check -------------------------------------------------------------------
  const allAttempts = await prisma.faceVerificationAttempt.findMany({
    where: { similarity: { not: null } },
    select: { userId: true, similarity: true, outcome: true, userAgent: true, effectiveThreshold: true }
  });
  /**
   * SCRIPTED RUNS MUST BE EXCLUDED OR THE WHOLE SECTION IS A LIE. verify-face-e2e.ts enrolls and
   * verifies with the SAME image file, which scores a perfect 1.00 every time. Those rows are the
   * majority of this table on any machine where the e2e suite has been run, and averaging them in
   * produces a live mean near 1.0 — a workspace that looks flawless precisely because none of it
   * came from a camera. `node` in the UA is the tell: a browser always sends a Mozilla token.
   */
  const isBrowser = (ua: string | null) => Boolean(ua && /mozilla/i.test(ua));
  const attempts = allAttempts.filter((a) => isBrowser(a.userAgent));
  const scripted = allAttempts.length - attempts.length;

  const quality = new Map(subjects.map((s) => [s.userId, s.multiPose]));
  const liveMulti = attempts.filter((a) => quality.get(a.userId) === true).map((a) => Number(a.similarity));
  const liveSingle = attempts.filter((a) => quality.get(a.userId) === false).map((a) => Number(a.similarity));
  const liveUnknown = attempts.filter((a) => !quality.has(a.userId)).map((a) => Number(a.similarity));

  console.log("\n=== 5. Cross-check against REAL live attempts ===");
  console.log("  Real-browser attempts only, split by the enrollment quality of the person who made it.");
  console.log("  These are the operational numbers section 2 can only bound from above.\n");
  printStats("live · multi-pose", stats(liveMulti));
  printStats("live · single-pose", stats(liveSingle));
  printStats("live · no enrollment", stats(liveUnknown));
  const noMatch = attempts.filter((a) => a.outcome === "NO_MATCH");
  console.log(
    `\n  browser attempts ${attempts.length} · NO_MATCH ${noMatch.length} (${attempts.length ? pct(noMatch.length / attempts.length) : "—"})` +
      ` · of those, ${noMatch.filter((a) => quality.get(a.userId) === false).length} came from single-pose enrollments`
  );
  console.log(`  excluded ${scripted} scripted attempt(s) (non-browser user agent — verify-face-e2e.ts and friends).`);

  /**
   * Rejections the WORKSPACE threshold would have passed. effectiveMatchThreshold tightens the bar
   * for users whose own history is consistent, and it can only tighten — so a rejection above the
   * global setting was made by the adaptive rule, not by the admin's number. Those are invisible in
   * a sweep over the global threshold, and they change what "retune the threshold" would even buy.
   */
  const escalated = noMatch.filter((a) => Number(a.similarity) >= settings.matchThreshold);
  if (escalated.length > 0) {
    console.log(
      `  ${escalated.length} of the ${noMatch.length} NO_MATCH scored AT OR ABOVE the workspace threshold ${settings.matchThreshold} —` +
        ` rejected by the per-user adaptive tightening (effectiveMatchThreshold), not by the global setting.`
    );
  }

  /**
   * THE CROSS-TABLE THE DECISION ACTUALLY TURNS ON.
   *
   * Every scored live attempt is a person verifying THEMSELVES, so the live distribution is a
   * genuine distribution and its FRR at any threshold is MEASURED, not modelled. There is no live
   * impostor data and there never will be without a deliberate cross-matching exercise, so the FAR
   * column stays the template-derived estimate. Putting a measured column next to an estimated one
   * is the honest way to show the trade; collapsing them into one "error rate" would not be.
   *
   * NOTHING HERE CHANGES A SETTING. This prints what each threshold would cost. Choosing one is a
   * human's call, on a workspace's own risk appetite.
   */
  const liveGenuine = [...liveMulti, ...liveSingle];
  if (liveGenuine.length > 0) {
    console.log("\n  If the threshold moved (live FRR is measured; FAR remains the template-derived estimate):\n");
    console.log("    threshold   live FRR (measured)   est. FAR (templates)");
    for (const t of [0.6, 0.65, 0.67, 0.7, 0.72, 0.75, 0.8]) {
      const frr = liveGenuine.filter((v) => v < t).length / liveGenuine.length;
      const far = rows.find((r) => Math.abs(r.threshold - t) < 0.005)?.far;
      console.log(`      ${t.toFixed(2)}          ${pct(frr).padStart(6)}                ${far == null ? "—" : pct(far).padStart(6)}`);
    }
  }

  // --- 6. verdict ----------------------------------------------------------------------------
  console.log("\n=== 6. Verdict ===");
  verdict({ genuine: gb, impostor: ib, eer, threshold: settings.matchThreshold, liveMulti, liveSingle });
  console.log("");
}

function histogram(counts: number[]): string {
  const tally = new Map<number, number>();
  for (const c of counts) tally.set(c, (tally.get(c) ?? 0) + 1);
  return [...tally.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([templates, subjects]) => `${templates}×${subjects}`)
    .join("  ");
}

function verdict(input: {
  /** Best-of-set, both of them — the pairwise figures describe no decision anyone makes. */
  genuine: Stats;
  impostor: Stats;
  eer: SweepRow | null;
  threshold: number;
  liveMulti: number[];
  liveSingle: number[];
}): void {
  const { genuine, impostor, eer } = input;
  const say = (line: string) => console.log(`  ${line}`);

  /**
   * ADEQUACY FIRST, ALWAYS. A d' computed from a dozen pairs is a number, not a measurement, and
   * printing a confident conclusion under it is how a weak result gets quoted as a strong one.
   */
  const underpowered = genuine.n < MIN_GENUINE_PAIRS || impostor.n < MIN_IMPOSTOR_PAIRS;
  if (underpowered) {
    say("INSUFFICIENT DATA — the numbers above describe this corpus, not this model.");
    say(`  genuine pairs  ${genuine.n} (need >= ${MIN_GENUINE_PAIRS} for a usable FRR estimate)`);
    say(`  impostor pairs ${impostor.n} (need >= ${MIN_IMPOSTOR_PAIRS} for a usable FAR estimate)`);
    say("");
    say("  Pairs grow with the SQUARE of the enrolled population, so the shortfall closes fast:");
    for (const n of [10, 20, 30, 50]) {
      const perSubject = 4;
      const gPairs = n * ((perSubject * (perSubject - 1)) / 2);
      const iPairs = ((n * (n - 1)) / 2) * perSubject * perSubject;
      say(`    ${String(n).padStart(3)} subjects × 4 templates -> ${String(gPairs).padStart(5)} genuine, ${String(iPairs).padStart(6)} impostor pairs`);
    }
    say("");
    say("  Rule of three: n impostor pairs can only bound FAR at 3/n. Demonstrating a 0.1% FAR needs");
    say("  ~3,000 impostor pairs — around 15 fully enrolled subjects. Below that, quote the direction");
    say("  of these numbers, never the rate.");
    say("");
  }

  const separated = Number.isFinite(genuine.min) && Number.isFinite(impostor.max) && genuine.min > impostor.max;
  const d = dPrime(genuine, impostor);
  const eerRate = eer ? (eer.far + eer.frr) / 2 : NaN;

  if (separated) {
    say(`${underpowered ? "DIRECTIONAL: " : ""}THE THRESHOLD IS THE LEVER, NOT THE MODEL.`);
    say(`  Every genuine pair (min ${f(genuine.min)}) outscores every impostor pair (max ${f(impostor.max)}).`);
    say(`  A clean corridor of ${f(genuine.min - impostor.max)} exists between them, so a threshold placed inside it`);
    say("  separates perfectly on this corpus. A stronger embedding model cannot improve on already-");
    say("  perfect separation — it can only widen a corridor that is not currently the binding constraint.");
  } else if (Number.isFinite(d) && d >= 3) {
    say(`${underpowered ? "DIRECTIONAL: " : ""}SEPARATION IS WORKABLE — tune the threshold before touching the model.`);
    say(`  d'=${f(d, 2)} with an equal-error point of ~${pct(eerRate)}. The clusters overlap, but only in the tail.`);
  } else {
    say(`${underpowered ? "DIRECTIONAL: " : ""}OVERLAP IS SUBSTANTIAL — no threshold separates these two clusters cleanly.`);
    say(`  d'=${f(d, 2)}, equal-error ~${pct(eerRate)}. Every threshold trades a false accept for a false reject.`);
    if (underpowered) {
      // The distinction that stops this being quoted as "the model is the problem": at these pair
      // counts a d' of this size is also what you get from a handful of awkward enrollment shots.
      // Those two causes are indistinguishable here, and only more enrolled subjects separate them.
      say("  On a corpus this small that shape has TWO indistinguishable causes — an embedding that");
      say("  genuinely cannot separate these faces, or a few poor enrollment captures dragging the");
      say("  genuine tail down. Do not spend a model migration on this number. Fill the enrollments");
      say("  in first: it is cheap, it is the stated hypothesis, and it is what makes the re-run decisive.");
    } else {
      say("  That is the signature of an embedding model that is genuinely the limiting factor.");
    }
  }

  // The enrollment-depth comparison is the actionable half, and it is measurable from live data
  // even when the pair counts are far too small for a statement about the model.
  const lm = stats(input.liveMulti);
  const ls = stats(input.liveSingle);
  /** Below this per side, a difference in means is one person having a good day. */
  const MIN_LIVE_PER_GROUP = 10;
  say("");
  if (lm.n >= MIN_LIVE_PER_GROUP && ls.n >= MIN_LIVE_PER_GROUP) {
    const delta = lm.mean - ls.mean;
    say(`ENROLLMENT DEPTH: live mean ${f(lm.mean)} multi-pose vs ${f(ls.mean)} single-pose (${f(delta)} apart, n=${lm.n} vs ${ls.n}).`);
    say(`  ${delta > 0.02 ? "Depth moves the score in the direction the hypothesis predicts." : "No depth effect visible in this sample."}`);
  } else {
    say(`ENROLLMENT DEPTH: NOT TESTABLE — ${lm.n} multi-pose and ${ls.n} single-pose live scores (need >= ${MIN_LIVE_PER_GROUP} each).`);
    say("  The central hypothesis is currently untested, in either direction. Get every covered user");
    say("  through the four-pose wizard, let a fortnight of real checks accumulate, then re-run: the");
    say("  model can be neither blamed nor cleared until both groups have samples.");
  }
}

async function main() {
  await runForEveryOrg("evaluate-face-embeddings", report);
  console.log("Read-only: no rows were created, updated or deleted.");
  process.exit(0);
}

main().catch((error) => {
  console.error("CRASHED:", error);
  process.exit(1);
});
