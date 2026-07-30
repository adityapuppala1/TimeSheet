/* Live end-to-end check of the face-verification feature against a RUNNING api.
 * Proves the things unit tests can't: that the gate actually blocks a real submit, that a real
 * face really enrolls and verifies through HTTP, and that a different face is really rejected.
 * Usage: start the API, then `npx tsx scripts/verify-face-e2e.ts` */
import path from "node:path";
import { createRequire } from "node:module";
import sharp from "sharp";

const require = createRequire(import.meta.url);
const ASSETS = path.join(path.resolve(require.resolve("@vladmandic/human"), "..", ".."), "assets");
const BASE = process.env.E2E_BASE ?? "http://localhost:4000";

let failures = 0;
function check(label: string, pass: boolean, detail = "") {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures++;
}

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  if (!res.ok) throw new Error(`login failed for ${email}: ${res.status} ${await res.text()}`);
  return (await res.json()).accessToken;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function patchSettings(token: string, body: Record<string, unknown>) {
  const res = await fetch(`${BASE}/api/settings/face-verification`, {
    method: "PATCH",
    headers: { ...auth(token), "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`settings patch failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function postCapture(token: string, route: string, jpeg: Buffer | Buffer[], fields: Record<string, string>) {
  const form = new FormData();
  const frames = Array.isArray(jpeg) ? jpeg : [jpeg];
  for (const [index, frame] of frames.entries()) {
    form.append("capture", new Blob([new Uint8Array(frame)], { type: "image/jpeg" }), `capture-${index}.jpg`);
  }
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const res = await fetch(`${BASE}/api${route}`, { method: "POST", headers: auth(token), body: form });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function faceOf(file: string): Promise<Buffer> {
  return sharp(path.join(ASSETS, file)).jpeg().toBuffer();
}

async function main() {
  console.log(`base: ${BASE}\n`);

  const admin = await login("superadmin@timesheet.local", "Admin@12345");
  const employee = await login("employee@timesheet.local", "Admin@12345");

  // This script mutates WORKSPACE-WIDE settings, so snapshot them first and restore every
  // field at the end. Restoring only the fields we set would leave the workspace in a state
  // the operator never chose — and since enabling this genuinely blocks ticket/timesheet
  // creation, a leaked "on" state breaks unrelated test suites and real users alike.
  const original = await (await fetch(`${BASE}/api/settings/face-verification`, { headers: auth(admin) })).json();

  console.log("=== 1. feature off by default -> nothing required ===");
  await patchSettings(admin, { enabled: false });
  let status = await (await fetch(`${BASE}/api/face/status`, { headers: auth(employee) })).json();
  check("not required when disabled", status.requiredForTimesheet === false);

  console.log("\n=== 2. enable for ALL, employee now required ===");
  // challengeEnabled off for the single-frame sections below; the challenge flow gets its own
  // dedicated section (7b) that turns it back on.
  await patchSettings(admin, { enabled: true, requireForTimesheet: true, enforcementMode: "ALL", challengeEnabled: false });
  status = await (await fetch(`${BASE}/api/face/status`, { headers: auth(employee) })).json();
  check("required after enabling", status.requiredForTimesheet === true);
  check("not yet enrolled", status.enrolled === false);
  check("consent text present", typeof status.consentText === "string" && status.consentText.length > 20);
  check("plan entitlement reported (default org is ENTERPRISE)", status.allowedByPlan === true);

  console.log("\n=== 3. timesheet submit is BLOCKED without verification ===");
  const slotHour = 5 + Math.floor(Math.random() * 14);
  const projects = await (await fetch(`${BASE}/api/projects`, { headers: auth(employee) })).json();
  const project = projects[0];
  const submitBody = {
    projectId: project?.id,
    moduleId: project?.modules?.[0]?.id,
    activityType: "Development",
    taskDescription: "Face verification gate check — automated script",
    workDate: new Date().toISOString().slice(0, 10),
    // Randomised 1-hour slot so re-running the script doesn't collide with its own previous
    // entries (the API correctly rejects overlapping ranges with 409) and stays under the
    // 12-hour-per-entry cap.
    startTime: `${String(slotHour).padStart(2, "0")}:00`,
    endTime: `${String(slotHour).padStart(2, "0")}:45`
  };
  const blocked = await fetch(`${BASE}/api/timesheets/submit`, {
    method: "POST",
    headers: { ...auth(employee), "content-type": "application/json" },
    body: JSON.stringify(submitBody)
  });
  check("submit rejected with 428", blocked.status === 428, `got ${blocked.status}`);

  console.log("\n=== 4. verify before enrolling -> NOT_ENROLLED ===");
  const personA = await faceOf("screenshot-faceid.jpg");
  const notEnrolled = await postCapture(employee, "/face/verify", personA, { context: "TIMESHEET" });
  check("rejected as not enrolled", notEnrolled.status === 428, `status ${notEnrolled.status}`);

  console.log("\n=== 5. enroll requires consent ===");
  const noConsent = await postCapture(employee, "/face/enroll", personA, { consent: "false" });
  check("enroll without consent rejected", noConsent.status === 422, `status ${noConsent.status}`);

  console.log("\n=== 6. enroll with consent (multi-frame) ===");
  // Three frames from one session — each usable one becomes a stored template, which is what
  // stops a single unlucky enrollment frame defining the person forever.
  const enrolled = await postCapture(employee, "/face/enroll", [personA, personA, personA], { consent: "true" });
  check("enrolled", enrolled.status === 201, `status ${enrolled.status} ${JSON.stringify(enrolled.body).slice(0, 160)}`);
  check("stored more than one template", (enrolled.body?.templatesStored ?? 0) > 1, `templatesStored=${enrolled.body?.templatesStored}`);

  console.log("\n=== 6b. an unusable frame is a RETAKE, not a match failure ===");
  // A tiny face on a big canvas: judgeable-face floors fail, so this must come back LOW_QUALITY
  // with an actionable hint — never NO_MATCH, which would tell an honest user we think they're
  // an impostor.
  const tinyFace = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: { r: 128, g: 128, b: 128 } } })
    .composite([{ input: await sharp(path.join(ASSETS, "screenshot-faceid.jpg")).resize({ width: 130 }).toBuffer(), gravity: "centre" }])
    .jpeg()
    .toBuffer();
  const lowQ = await postCapture(employee, "/face/verify", tinyFace, { context: "TIMESHEET" });
  check(
    "tiny/unclear face returns LOW_QUALITY, not NO_MATCH",
    lowQ.body?.outcome === "LOW_QUALITY" || lowQ.body?.outcome === "NO_FACE",
    `outcome=${lowQ.body?.outcome} message=${String(lowQ.body?.message).slice(0, 80)}`
  );
  if (lowQ.body?.outcome === "LOW_QUALITY") {
    check("…and the message says what to change", /closer|dark|centre|light/i.test(String(lowQ.body?.message)), String(lowQ.body?.message));
  }

  console.log("\n=== 7. verify with the SAME face -> PASSED ===");
  const pass = await postCapture(employee, "/face/verify", personA, { context: "TIMESHEET" });
  check("passed", pass.body?.outcome === "PASSED", JSON.stringify(pass.body).slice(0, 160));
  const verificationId = pass.body?.verificationId;
  check("returned a verification id", typeof verificationId === "string");

  console.log("\n=== 7b. challenge–response (anti-injection) ===");
  await patchSettings(admin, { challengeEnabled: true });
  const challengeRes = await fetch(`${BASE}/api/face/challenge`, {
    method: "POST",
    headers: { ...auth(employee), "content-type": "application/json" },
    body: JSON.stringify({ context: "TIMESHEET" })
  });
  const challenge = await challengeRes.json();
  check("challenge issued", challengeRes.status === 201 && typeof challenge.challengeId === "string", JSON.stringify(challenge).slice(0, 120));
  check("challenge names an instruction", ["TURN_LEFT", "TURN_RIGHT", "LOOK_UP"].includes(challenge.instruction));

  // No challengeId at all → refused outright, even with a matching live face.
  const noChallenge = await postCapture(employee, "/face/verify", personA, { context: "TIMESHEET" });
  check("verify without a challenge is refused", noChallenge.body?.outcome === "CHALLENGE_FAILED", `outcome=${noChallenge.body?.outcome}`);

  // A static replay — two IDENTICAL frames — cannot satisfy any movement instruction. This is
  // the exact defeat of a virtual camera looping a recorded still/video of the right person.
  const staticReplay = await postCapture(employee, "/face/verify", [personA, personA], {
    context: "TIMESHEET",
    challengeId: challenge.challengeId
  });
  check("static two-frame replay fails the pose check", staticReplay.body?.outcome === "CHALLENGE_FAILED", `outcome=${staticReplay.body?.outcome}`);

  // Challenges are single-use: the redeem above spent it, a second try must not work.
  const reusedChallenge = await postCapture(employee, "/face/verify", [personA, personA], {
    context: "TIMESHEET",
    challengeId: challenge.challengeId
  });
  check("a challenge cannot be redeemed twice", reusedChallenge.body?.outcome === "CHALLENGE_FAILED");

  await patchSettings(admin, { challengeEnabled: false });

  console.log("\n=== 7c. virtual-camera signal is recorded and flagged, never blocking ===");
  const obsPass = await postCapture(employee, "/face/verify", personA, {
    context: "TIMESHEET",
    deviceLabel: "OBS Virtual Camera"
  });
  check("suspected virtual camera still PASSES (signal, not verdict)", obsPass.body?.outcome === "PASSED", `outcome=${obsPass.body?.outcome}`);
  const flaggedPage = await (await fetch(`${BASE}/api/face/attempts?flaggedOnly=true&pageSize=10`, { headers: auth(admin) })).json();
  const obsRow = Array.isArray(flaggedPage?.rows) ? flaggedPage.rows.find((r: any) => r.virtualCameraSuspected) : null;
  check("…but lands in the flagged review queue with the device label", Boolean(obsRow && obsRow.deviceLabel === "OBS Virtual Camera"));

  console.log("\n=== 8. submit WITH the verification succeeds ===");
  // Re-runs of this script (and other suites) leave real rows on today's date, so a random
  // hour can genuinely collide (409 overlap). The verification id survives a 409 — the gate
  // consumes it only ONCE... actually no: consumeVerification runs BEFORE the overlap check,
  // so a 409 has already spent the id. Each retry therefore needs a fresh verification.
  let ok: Response | null = null;
  let okBody: any = {};
  let retryVerificationId = verificationId;
  for (let attempt = 0; attempt < 8; attempt++) {
    const hour = attempt === 0 ? slotHour : 5 + Math.floor(Math.random() * 14);
    const minute = attempt === 0 ? 0 : [0, 15, 30][Math.floor(Math.random() * 3)];
    ok = await fetch(`${BASE}/api/timesheets/submit`, {
      method: "POST",
      headers: { ...auth(employee), "content-type": "application/json" },
      body: JSON.stringify({
        ...submitBody,
        startTime: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
        endTime: `${String(hour).padStart(2, "0")}:${String(minute + 14).padStart(2, "0")}`,
        faceVerificationId: retryVerificationId
      })
    });
    okBody = await ok.json().catch(() => ({}));
    if (ok.status !== 409) break;
    // Slot collision spent the verification — take a fresh one for the next try.
    const fresh = await postCapture(employee, "/face/verify", personA, { context: "TIMESHEET" });
    retryVerificationId = fresh.body?.verificationId;
  }
  check("submit accepted", ok !== null && (ok.status === 201 || ok.status === 200), `status ${ok?.status} ${JSON.stringify(okBody).slice(0, 200)}`);

  console.log("\n=== 8b. the submitted row carries the verified badge ===");
  const myRows = await (await fetch(`${BASE}/api/timesheets`, { headers: auth(employee) })).json();
  const submittedRow = Array.isArray(myRows) ? myRows.find((r: any) => r.id === okBody.id) : null;
  check("list reports identityVerified on the row", submittedRow?.identityVerified === true, JSON.stringify({ found: Boolean(submittedRow), v: submittedRow?.identityVerified }));

  console.log("\n=== 8c. approval gate checks the APPROVER ===");
  await patchSettings(admin, { requireForApproval: true });
  const manager = await login("manager@timesheet.local", "Admin@12345");
  const approveBlocked = await fetch(`${BASE}/api/timesheets/${okBody.id}/approve`, {
    method: "PATCH",
    headers: { ...auth(manager), "content-type": "application/json" },
    body: JSON.stringify({})
  });
  check("approve without verification rejected with 428", approveBlocked.status === 428, `got ${approveBlocked.status}`);

  // The employee's PASSED timesheet verification must not be spendable by the manager for an
  // approval — wrong user AND wrong context.
  const wrongOwner = await fetch(`${BASE}/api/timesheets/${okBody.id}/approve`, {
    method: "PATCH",
    headers: { ...auth(manager), "content-type": "application/json" },
    body: JSON.stringify({ faceVerificationId: verificationId })
  });
  check("someone else's verification is refused for approval", wrongOwner.status === 428, `got ${wrongOwner.status}`);
  await patchSettings(admin, { requireForApproval: false });

  console.log("\n=== 9. the SAME verification cannot be replayed ===");
  const replay = await fetch(`${BASE}/api/timesheets/submit`, {
    method: "POST",
    headers: { ...auth(employee), "content-type": "application/json" },
    body: JSON.stringify({
      ...submitBody,
      startTime: `${String(slotHour).padStart(2, "0")}:50`,
      endTime: `${String(slotHour).padStart(2, "0")}:55`,
      faceVerificationId: verificationId
    })
  });
  check("replay rejected with 428", replay.status === 428, `got ${replay.status}`);

  console.log("\n=== 10. a DIFFERENT face is rejected ===");
  const meta = await sharp(path.join(ASSETS, "screenshot-facematch.jpg")).metadata();
  const personB = await sharp(path.join(ASSETS, "screenshot-facematch.jpg"))
    .extract({ left: 0, top: 0, width: Math.floor((meta.width ?? 2) / 2), height: meta.height ?? 1 })
    .jpeg()
    .toBuffer();
  const wrongFace = await postCapture(employee, "/face/verify", personB, { context: "TIMESHEET" });
  const rejected = wrongFace.body?.outcome && wrongFace.body.outcome !== "PASSED";
  check(
    "different face did not pass",
    Boolean(rejected),
    `status=${wrongFace.status} outcome=${wrongFace.body?.outcome} body=${JSON.stringify(wrongFace.body).slice(0, 200)}`
  );

  console.log("\n=== 11. a no-face image is rejected ===");
  const blank = await sharp({ create: { width: 400, height: 400, channels: 3, background: { r: 20, g: 20, b: 20 } } })
    .jpeg()
    .toBuffer();
  const noFace = await postCapture(employee, "/face/verify", blank, { context: "TIMESHEET" });
  check("no-face rejected", noFace.body?.outcome === "NO_FACE", `outcome=${noFace.body?.outcome}`);

  console.log("\n=== 12. attempts are logged for admin review (paginated) ===");
  const attempts = await (await fetch(`${BASE}/api/face/attempts?pageSize=20`, { headers: auth(admin) })).json();
  check("attempt log populated", Array.isArray(attempts?.rows) && attempts.rows.length > 0, `${attempts?.rows?.length} rows`);
  check("log never leaks a filesystem path", JSON.stringify(attempts).includes("imagePath") === false);
  check("page reports a true total", typeof attempts?.total === "number" && attempts.total >= attempts.rows.length, `total=${attempts?.total}`);
  check("page size is honoured", attempts.rows.length <= 20, `${attempts?.rows?.length} rows`);

  // Page 2 must return DIFFERENT rows than page 1 — the actual regression risk with skip/take
  // is an offset that silently does nothing, which looks fine until someone pages.
  const p1 = await (await fetch(`${BASE}/api/face/attempts?pageSize=2&page=1`, { headers: auth(admin) })).json();
  const p2 = await (await fetch(`${BASE}/api/face/attempts?pageSize=2&page=2`, { headers: auth(admin) })).json();
  const p1ids = (p1.rows ?? []).map((r: any) => r.id).join(",");
  const p2ids = (p2.rows ?? []).map((r: any) => r.id).join(",");
  check("page 2 returns a different slice than page 1", Boolean(p1ids) && Boolean(p2ids) && p1ids !== p2ids, `p1=[${p1ids}] p2=[${p2ids}]`);
  check("total is stable across pages", p1.total === p2.total, `${p1.total} vs ${p2.total}`);
  // `take` stays accepted so any older caller keeps working.
  const legacy = await (await fetch(`${BASE}/api/face/attempts?take=3`, { headers: auth(admin) })).json();
  check("legacy ?take= alias still works", Array.isArray(legacy?.rows) && legacy.rows.length <= 3, `${legacy?.rows?.length} rows`);

  console.log("\n=== 13. employee cannot read the admin review log ===");
  const forbidden = await fetch(`${BASE}/api/face/attempts`, { headers: auth(employee) });
  check("employee blocked from log", forbidden.status === 403, `got ${forbidden.status}`);

  console.log("\n=== 13b. stats + self-service export ===");
  const stats = await (await fetch(`${BASE}/api/face/stats`, { headers: auth(admin) })).json();
  check("stats totals populated", typeof stats.total === "number" && stats.total > 0, `total=${stats.total}`);
  check("stats histogram has buckets", Array.isArray(stats.histogram) && stats.histogram.length > 0);
  check("accuracy metrics present", Boolean(stats.accuracy) && typeof stats.accuracy.samples?.judged === "number", JSON.stringify(stats.accuracy).slice(0, 160));
  check(
    "retake rate and non-match proxy are percentages or null",
    [stats.accuracy?.retakeRatePct, stats.accuracy?.fnmrProxyPct].every((v) => v === null || (typeof v === "number" && v >= 0 && v <= 100)),
    `retake=${stats.accuracy?.retakeRatePct} fnmr=${stats.accuracy?.fnmrProxyPct}`
  );
  const statsForbidden = await fetch(`${BASE}/api/face/stats`, { headers: auth(employee) });
  check("stats is admin-only", statsForbidden.status === 403, `got ${statsForbidden.status}`);

  const exported = await (await fetch(`${BASE}/api/face/export`, { headers: auth(employee) })).json();
  check("export includes the consent record", typeof exported?.enrollment?.consentText === "string");
  check("export lists the caller's attempts", Array.isArray(exported?.attempts) && exported.attempts.length > 0);
  check(
    "export never contains the biometric template or file paths",
    !JSON.stringify(exported).includes("encryptedEmbedding") && !JSON.stringify(exported).includes("imagePath")
  );

  console.log("\n=== 14. self-service delete removes the enrollment ===");
  const del = await fetch(`${BASE}/api/face/enrollment`, { method: "DELETE", headers: auth(employee) });
  check("deleted", del.status === 200, `status ${del.status}`);
  status = await (await fetch(`${BASE}/api/face/status`, { headers: auth(employee) })).json();
  check("no longer enrolled", status.enrolled === false);

  console.log("\n=== cleanup: restore the original settings exactly ===");
  await patchSettings(admin, {
    enabled: original.enabled,
    requireForTimesheet: original.requireForTimesheet,
    requireForTicket: original.requireForTicket,
    requireForApproval: original.requireForApproval,
    challengeEnabled: original.challengeEnabled,
    enforcementMode: original.enforcementMode,
    matchThreshold: original.matchThreshold,
    antispoofThreshold: original.antispoofThreshold,
    livenessThreshold: original.livenessThreshold,
    maxAttempts: original.maxAttempts,
    verificationTtlSeconds: original.verificationTtlSeconds,
    imageRetentionDays: original.imageRetentionDays,
    consentText: original.consentText
  });
  const restored = await (await fetch(`${BASE}/api/settings/face-verification`, { headers: auth(admin) })).json();
  check(
    "settings restored to original",
    restored.enabled === original.enabled && restored.requireForTicket === original.requireForTicket
  );

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("CRASHED:", e);
  process.exit(1);
});
