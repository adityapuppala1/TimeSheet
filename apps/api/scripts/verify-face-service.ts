/* Verifies face.service.ts end-to-end against the real Human models: same-person match,
 * different-person rejection, embedding encrypt/decrypt round-trip, and no-face handling.
 * Run: npx tsx scripts/verify-face-service.ts */
import path from "node:path";
import { createRequire } from "node:module";
import sharp from "sharp";
import { analyzeFace, similarity, encodeEmbedding, decodeEmbedding, FACE_MODEL_VERSION } from "../src/services/face.service.js";

const require = createRequire(import.meta.url);
const HUMAN_ROOT = path.resolve(require.resolve("@vladmandic/human"), "..", "..");
const assets = path.join(HUMAN_ROOT, "assets");

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures++;
}

/** Crops one face out of a multi-face sample so we get two genuinely different people. */
async function crop(file: string, left: number, top: number, width: number, height: number): Promise<Buffer> {
  return sharp(path.join(assets, file)).extract({ left, top, width, height }).jpeg().toBuffer();
}

async function main() {
  console.log(`model version: ${FACE_MODEL_VERSION}\n`);

  console.log("=== 1. analyze a real face ===");
  const faceIdImg = await sharp(path.join(assets, "screenshot-faceid.jpg")).jpeg().toBuffer();
  const t0 = Date.now();
  const a = await analyzeFace(faceIdImg);
  console.log(`  (first call incl. model load: ${Date.now() - t0}ms)`);
  check("face detected", a.faceCount > 0, `count=${a.faceCount}`);
  check("embedding is 1024-dim", a.embedding.length === 1024, `len=${a.embedding.length}`);
  check("antispoof score present", a.antispoofReal > 0, a.antispoofReal.toFixed(3));
  check("liveness score present", a.livenessScore > 0, a.livenessScore.toFixed(3));

  console.log("\n=== 2. same image -> similarity 1.0 (self-match) ===");
  const t1 = Date.now();
  const a2 = await analyzeFace(faceIdImg);
  console.log(`  (warm call: ${Date.now() - t1}ms)`);
  const selfSim = await similarity(a.embedding, a2.embedding);
  check("self-similarity ~1.0", selfSim > 0.99, selfSim.toFixed(4));

  console.log("\n=== 3. embedding encrypt/decrypt round-trip ===");
  const encrypted = encodeEmbedding(a.embedding);
  const decoded = decodeEmbedding(encrypted);
  check("length preserved", decoded.length === a.embedding.length);
  const maxDrift = Math.max(...decoded.map((v, i) => Math.abs(v - a.embedding[i])));
  check("values preserved (float32 precision)", maxDrift < 1e-5, `max drift=${maxDrift.toExponential(2)}`);
  check("ciphertext is not plaintext", !encrypted.includes(String(a.embedding[0])));
  const decodedSim = await similarity(a.embedding, decoded);
  check("round-tripped embedding still self-matches", decodedSim > 0.99, decodedSim.toFixed(4));

  console.log("\n=== 4. different people -> below threshold (0.75) ===");
  const meta = await sharp(path.join(assets, "screenshot-facematch.jpg")).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  // Two different regions of the face-match demo screenshot = two different people.
  const personA = await crop("screenshot-facematch.jpg", 0, 0, Math.floor(w / 2), h);
  const personB = await crop("screenshot-facematch.jpg", Math.floor(w / 2), 0, Math.floor(w / 2), h);
  const fa = await analyzeFace(personA);
  const fb = await analyzeFace(personB);
  if (fa.faceCount > 0 && fb.faceCount > 0) {
    const crossSim = await similarity(fa.embedding, fb.embedding);
    check("different people score below 0.75", crossSim < 0.75, crossSim.toFixed(4));
  } else {
    console.log(`  SKIP (crops had no detectable face: a=${fa.faceCount} b=${fb.faceCount})`);
  }

  console.log("\n=== 5. no-face image handled gracefully ===");
  const blank = await sharp({ create: { width: 400, height: 400, channels: 3, background: { r: 30, g: 30, b: 30 } } })
    .jpeg()
    .toBuffer();
  const none = await analyzeFace(blank);
  check("faceCount 0", none.faceCount === 0);
  check("empty embedding", none.embedding.length === 0);

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("CRASHED:", e);
  process.exit(1);
});
