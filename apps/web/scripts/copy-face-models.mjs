/**
 * Copies the two Human models the BROWSER needs into `public/human-models/`.
 *
 * WHY COPY RATHER THAN USE THE CDN: Human's default `modelBasePath` points at a public CDN. This
 * product is installed on-premise behind corporate firewalls and, in several deployments, with no
 * outbound internet at all — a camera check that silently stops working because a CDN is
 * unreachable is worse than one that was never offered. Serving the models from the app's own
 * origin also keeps them inside the same CSP as everything else.
 *
 * WHY ONLY TWO MODELS: the browser's job is detection and head pose — deciding when the frame is
 * good enough to send and whether the user has actually turned their head. It does NOT compute
 * the embedding and it does NOT decide the match; both stay on the server, because a client that
 * decides its own verification outcome is not a security control. So `faceres` (7MB, the
 * embedding model) and `antispoof`/`liveness` are deliberately absent — shipping them would be
 * 8MB of download that buys the client nothing it is allowed to use.
 *
 *   blazeface  ~0.6MB  face detection (is there a face, where, how big)
 *   facemesh   ~1.6MB  468-point mesh -> yaw/pitch, which is what the head-turn challenge needs
 *
 * Runs from `predev` and `prebuild`, so both the dev server and a production bundle have them
 * without anybody having to remember. Idempotent — skips files that are already current.
 */
import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

/** Only what the browser is allowed to use. See the header for why this list is short. */
const NEEDED = ["blazeface.json", "blazeface.bin", "facemesh.json", "facemesh.bin"];

async function main() {
  // `require.resolve("@vladmandic/human/package.json")` does NOT work: the package ships an
  // exports map that does not expose package.json, so Node refuses the subpath. face.service.ts
  // hits the same wall on the server and solves it the same way — go at the directory directly.
  // npm workspaces hoist, so try the workspace copy first and then the repo root.
  const candidates = [
    path.join(here, "..", "node_modules", "@vladmandic", "human", "models"),
    path.join(here, "..", "..", "..", "node_modules", "@vladmandic", "human", "models")
  ];
  let modelsDir = null;
  for (const dir of candidates) {
    if (await stat(dir).then(() => true).catch(() => false)) {
      modelsDir = dir;
      break;
    }
  }
  if (!modelsDir) {
    console.warn("[face-models] @vladmandic/human not installed yet — skipping. Run npm install first.");
    return;
  }

  const outDir = path.join(here, "..", "public", "human-models");
  await mkdir(outDir, { recursive: true });

  const existing = new Set(await readdir(outDir).catch(() => []));
  let copied = 0;
  for (const name of NEEDED) {
    const from = path.join(modelsDir, name);
    const to = path.join(outDir, name);
    if (existing.has(name)) {
      const [a, b] = await Promise.all([stat(from), stat(to)]);
      if (a.size === b.size) continue; // already current
    }
    await copyFile(from, to);
    copied += 1;
  }
  console.log(
    copied === 0
      ? "[face-models] already up to date"
      : `[face-models] copied ${copied} file(s) into public/human-models/`
  );
}

main().catch((err) => {
  // Never fail the build over this: the camera degrades to the manual shutter without local
  // models, and a broken `npm run build` over an optional enhancement is the wrong trade.
  console.warn("[face-models] skipped:", err?.message ?? err);
});
