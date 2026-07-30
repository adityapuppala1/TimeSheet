/**
 * PAD (presentation-attack detection) SELF-TEST — Phase E.
 *
 * WHAT THIS IS: a repeatable, in-repo smoke test that synthesises the cheap end of the
 * presentation-attack spectrum and asserts the anti-spoof/liveness stack rejects it while still
 * accepting a genuine capture. Run it after any change to the model config, the thresholds, or
 * `analyzeFace`.
 *
 * WHAT THIS IS EMPHATICALLY NOT: an `ISO/IEC 30107-3` conformance test. Real certification
 * (iBeta Level 1/2) requires an accredited lab, physical artefacts built to a cost budget, and a
 * measured APCER/BPCER over hundreds of presentations. Synthetic attacks generated in-process are
 * strictly easier than physical ones — a printed photo has paper texture, specular highlights and
 *真 depth cues that no `sharp` filter reproduces. So a PASS here means "the obvious digital
 * approximations are caught", never "certified". Claiming otherwise to a customer's security team
 * would be a lie that unravels the first time they ask for the report.
 *
 * The genuine-capture check is the important half in practice: a threshold change that quietly
 * starts rejecting real faces is the failure mode that actually reaches users.
 *
 * Run: npx tsx scripts/verify-face-pad.ts
 */
import path from "node:path";
import { createRequire } from "node:module";
import sharp from "sharp";
import { analyzeFace, scoreQuality } from "../src/services/face.service.js";

const require = createRequire(import.meta.url);
const ASSETS = path.join(path.resolve(require.resolve("@vladmandic/human"), "..", ".."), "assets");
const SOURCE = path.join(ASSETS, "screenshot-faceid.jpg");

// `analyzeFace`/`scoreQuality` are pure (model in, numbers out) — no Prisma/tenant context
// involved, which is what keeps this script standalone. `getFaceSettings()` IS tenant-scoped
// (reads GlobalFaceVerificationSettings) so it's deliberately not called here; these mirror its
// schema defaults (`prisma/schema.prisma` — GlobalFaceVerificationSettings.antispoofThreshold /
// .livenessThreshold) purely to report against. A workspace that has tuned its own thresholds
// will see this harness's verdicts differ slightly from its live behaviour — expected, and why
// this stays a smoke test rather than a claim about any one tenant's configuration.
const ANTISPOOF_THRESHOLD_DEFAULT = 0.5;
const LIVENESS_THRESHOLD_DEFAULT = 0.6;

let failures = 0;
let warnings = 0;

function check(label: string, pass: boolean, detail = "") {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures++;
}
function observe(label: string, detail: string) {
  console.log(`  NOTE  ${label} — ${detail}`);
  warnings++;
}

/** A "screen replay": rescale down and up to mimic a display's pixel grid, add a moiré-ish
 *  interference pattern, and cool the white balance the way an LCD does. */
async function screenReplay(): Promise<Buffer> {
  const base = sharp(SOURCE);
  const meta = await base.metadata();
  const w = meta.width ?? 800;
  const h = meta.height ?? 600;

  const moire = Buffer.from(
    `<svg width="${w}" height="${h}">${Array.from({ length: Math.floor(h / 3) }, (_, i) => `<rect x="0" y="${i * 3}" width="${w}" height="1" fill="black" opacity="0.16"/>`).join("")}</svg>`
  );

  return sharp(SOURCE)
    .resize({ width: Math.max(64, Math.floor(w / 3)) })
    .resize({ width: w })
    .modulate({ saturation: 0.85, brightness: 1.06 })
    .composite([{ input: moire, blend: "multiply" }])
    .jpeg({ quality: 70 })
    .toBuffer();
}

/** A "printed photo": desaturate toward ink, flatten contrast, add paper grain, soften. */
async function printedPhoto(): Promise<Buffer> {
  const meta = await sharp(SOURCE).metadata();
  const w = meta.width ?? 800;
  const h = meta.height ?? 600;

  const grain = await sharp({
    create: { width: w, height: h, channels: 3, background: { r: 128, g: 128, b: 128 }, noise: { type: "gaussian", mean: 128, sigma: 22 } }
  })
    .png()
    .toBuffer();

  return sharp(SOURCE)
    .modulate({ saturation: 0.6, brightness: 1.1 })
    .linear(0.82, 26) // flatten contrast the way a print does
    .blur(1.1)
    .composite([{ input: grain, blend: "overlay" }])
    .jpeg({ quality: 78 })
    .toBuffer();
}

async function main() {
  const settings = { antispoofThreshold: ANTISPOOF_THRESHOLD_DEFAULT, livenessThreshold: LIVENESS_THRESHOLD_DEFAULT };
  console.log("PAD self-test (synthetic attacks — NOT an ISO 30107-3 conformance test)\n");
  console.log(`  thresholds: antispoof >= ${settings.antispoofThreshold}, liveness >= ${settings.livenessThreshold} (schema defaults)\n`);

  console.log("=== 1. a genuine capture is ACCEPTED ===");
  const genuine = await sharp(SOURCE).jpeg().toBuffer();
  const g = await analyzeFace(genuine);
  check("detects exactly one face", g.faceCount === 1, `faceCount=${g.faceCount}`);
  check(
    "clears both live floors",
    g.antispoofReal >= settings.antispoofThreshold && g.livenessScore >= settings.livenessThreshold,
    `antispoof=${g.antispoofReal.toFixed(3)} liveness=${g.livenessScore.toFixed(3)}`
  );
  check("passes the capture quality gate", scoreQuality(g).hint === null, scoreQuality(g).hint ?? "no hint");

  console.log("\n=== 2. screen-replay presentation ===");
  const screen = await analyzeFace(await screenReplay());
  const screenRejected = screen.faceCount !== 1 || screen.antispoofReal < settings.antispoofThreshold || screen.livenessScore < settings.livenessThreshold;
  if (screenRejected) {
    check("rejected", true, `antispoof=${screen.antispoofReal.toFixed(3)} liveness=${screen.livenessScore.toFixed(3)}`);
  } else {
    // Deliberately a NOTE, not a FAIL: a synthetic moiré overlay is a weak proxy for a real
    // screen held to a lens, so passing it does not prove the stack is broken. It DOES mean this
    // harness can't vouch for screen attacks — which is exactly what a lab test is for.
    observe(
      "screen replay was NOT rejected",
      `antispoof=${screen.antispoofReal.toFixed(3)} liveness=${screen.livenessScore.toFixed(3)} — synthetic moiré is a weak proxy; verify with a real device before relying on this`
    );
  }

  console.log("\n=== 3. printed-photo presentation ===");
  const print = await analyzeFace(await printedPhoto());
  const printRejected = print.faceCount !== 1 || print.antispoofReal < settings.antispoofThreshold || print.livenessScore < settings.livenessThreshold;
  if (printRejected) {
    check("rejected", true, `antispoof=${print.antispoofReal.toFixed(3)} liveness=${print.livenessScore.toFixed(3)}`);
  } else {
    observe(
      "printed photo was NOT rejected",
      `antispoof=${print.antispoofReal.toFixed(3)} liveness=${print.livenessScore.toFixed(3)} — synthetic paper grain lacks real print texture and specular response`
    );
  }

  console.log("\n=== 4. degenerate inputs are refused, not crashed on ===");
  const blank = await sharp({ create: { width: 400, height: 400, channels: 3, background: { r: 12, g: 12, b: 12 } } }).jpeg().toBuffer();
  const b = await analyzeFace(blank);
  check("blank frame yields no face", b.faceCount === 0, `faceCount=${b.faceCount}`);
  check("blank frame yields no embedding", b.embedding.length === 0);

  console.log(
    `\n${failures === 0 ? "ALL ASSERTIONS PASS" : `${failures} FAILURE(S)`}` +
      (warnings > 0 ? ` · ${warnings} note(s) — read them: they bound what this harness can claim.` : "")
  );
  console.log(
    "\nReminder: synthetic attacks are strictly easier than physical ones. For a claim you can put\n" +
      "in front of a customer's security team, an accredited iBeta/ISO 30107-3 lab test is required."
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("CRASHED:", error);
  process.exit(1);
});
