#!/usr/bin/env node
/**
 * Writes a `.gz` beside every compressible file in dist/ — run after `vite build`.
 *
 * WHY. nginx's `gzip on` compresses each response again on every request, at a low level to keep
 * that CPU affordable. With `gzip_static on` (nginx.conf.template) it serves these files instead:
 * compressed ONCE, at the build, at level 9 — smaller transfers and no per-request compression CPU.
 * Uses node:zlib only, so it adds no dependency and runs anywhere `vite build` does.
 */
import fs from "node:fs";
import path from "node:path";
import { gzipSync, constants } from "node:zlib";

const root = path.resolve(import.meta.dirname, "../dist");
const COMPRESSIBLE = /\.(js|mjs|css|html|json|svg|txt|xml|wasm|map|webmanifest)$/i;
const MIN_BYTES = 1024; // below this, the gzip header outweighs the saving (nginx's own gzip_min_length)

let files = 0;
let before = 0;
let after = 0;
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!COMPRESSIBLE.test(entry.name) || entry.name.endsWith(".map")) continue;
    const raw = fs.readFileSync(full);
    if (raw.length < MIN_BYTES) continue;
    const gz = gzipSync(raw, { level: constants.Z_BEST_COMPRESSION });
    if (gz.length >= raw.length) continue; // already-compressed content (some wasm/json) — skip
    fs.writeFileSync(`${full}.gz`, gz);
    files++; before += raw.length; after += gz.length;
  }
}
if (!fs.existsSync(root)) { console.error(`[precompress] no ${root} — run vite build first`); process.exit(1); }
walk(root);
console.log(`[precompress] ${files} files: ${(before / 1048576).toFixed(1)} MB -> ${(after / 1048576).toFixed(1)} MB gzip (level 9)`);
