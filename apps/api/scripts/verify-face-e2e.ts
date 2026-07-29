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

async function postCapture(token: string, route: string, jpeg: Buffer, fields: Record<string, string>) {
  const form = new FormData();
  form.append("capture", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), "capture.jpg");
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
  await patchSettings(admin, { enabled: true, requireForTimesheet: true, enforcementMode: "ALL" });
  status = await (await fetch(`${BASE}/api/face/status`, { headers: auth(employee) })).json();
  check("required after enabling", status.requiredForTimesheet === true);
  check("not yet enrolled", status.enrolled === false);
  check("consent text present", typeof status.consentText === "string" && status.consentText.length > 20);

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

  console.log("\n=== 6. enroll with consent ===");
  const enrolled = await postCapture(employee, "/face/enroll", personA, { consent: "true" });
  check("enrolled", enrolled.status === 201, `status ${enrolled.status} ${JSON.stringify(enrolled.body).slice(0, 160)}`);

  console.log("\n=== 7. verify with the SAME face -> PASSED ===");
  const pass = await postCapture(employee, "/face/verify", personA, { context: "TIMESHEET" });
  check("passed", pass.body?.outcome === "PASSED", JSON.stringify(pass.body).slice(0, 160));
  const verificationId = pass.body?.verificationId;
  check("returned a verification id", typeof verificationId === "string");

  console.log("\n=== 8. submit WITH the verification succeeds ===");
  const ok = await fetch(`${BASE}/api/timesheets/submit`, {
    method: "POST",
    headers: { ...auth(employee), "content-type": "application/json" },
    body: JSON.stringify({ ...submitBody, faceVerificationId: verificationId })
  });
  const okBody = await ok.json().catch(() => ({}));
  check("submit accepted", ok.status === 201 || ok.status === 200, `status ${ok.status} ${JSON.stringify(okBody).slice(0, 200)}`);

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

  console.log("\n=== 12. attempts are logged for admin review ===");
  const attempts = await (await fetch(`${BASE}/api/face/attempts?take=20`, { headers: auth(admin) })).json();
  check("attempt log populated", Array.isArray(attempts) && attempts.length > 0, `${attempts?.length} rows`);
  check("log never leaks a filesystem path", JSON.stringify(attempts).includes("imagePath") === false);

  console.log("\n=== 13. employee cannot read the admin review log ===");
  const forbidden = await fetch(`${BASE}/api/face/attempts`, { headers: auth(employee) });
  check("employee blocked from log", forbidden.status === 403, `got ${forbidden.status}`);

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
