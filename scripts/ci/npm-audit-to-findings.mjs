#!/usr/bin/env node
/**
 * Maps `npm audit --json` output to TimeSphere's native findings-batch ingestion shape
 * (`{ findings: [...] }`, `POST /api/devops/:orgSlug/findings` — see
 * apps/api/src/controllers/devops-webhook.controller.ts). npm audit has no SARIF output, so this
 * is the small tool-specific translator every scanner needs (same role as the `jq` one-liners in
 * docs/SECURITY_DEVOPS_INTEGRATIONS.md, just for a tool whose native JSON needs a bit more than a
 * one-line map).
 *
 * Usage: node npm-audit-to-findings.mjs <npm-audit.json> [repository] [branch]
 * Writes the mapped `{ findings }` JSON to stdout; the caller (see .github/workflows/ci.yml's
 * "security-scan-dogfood" job) redirects it to a file and POSTs it.
 */
import fs from "node:fs";

const [, , inputPath, repository, branch] = process.argv;
if (!inputPath) {
  console.error("Usage: npm-audit-to-findings.mjs <npm-audit.json> [repository] [branch]");
  process.exit(1);
}

// TimeSphere's SecurityFindingSeverity enum (packages/shared) — npm audit's own severities
// (info/low/moderate/high/critical) map onto it, with "info" folded into LOW since the app has
// no separate INFO tier.
const SEVERITY_MAP = { info: "LOW", low: "LOW", moderate: "MEDIUM", high: "HIGH", critical: "CRITICAL" };
const SEVERITY_RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

// `npm audit` exits non-zero the moment any vulnerability exists, but still writes a valid JSON
// report to stdout — an empty or malformed file (the command itself failed to run) should yield
// zero findings rather than crash this CI step.
let report;
try {
  const raw = fs.readFileSync(inputPath, "utf8").trim();
  report = raw ? JSON.parse(raw) : { vulnerabilities: {} };
} catch {
  console.error("npm-audit-to-findings: could not parse input as JSON, emitting zero findings");
  report = { vulnerabilities: {} };
}

const vulnerabilities = report.vulnerabilities ?? {};
const findings = [];

for (const [packageName, vuln] of Object.entries(vulnerabilities)) {
  const severity = SEVERITY_MAP[vuln.severity] ?? "MEDIUM";

  // `via` mixes plain dependency-chain names (strings — "inherited from this other package") with
  // the actual advisory objects (title/url/cwe). Only the objects are worth a finding each; a
  // vulnerability with no advisory object at all (pure transitive string chain) still gets one
  // finding so it isn't silently dropped from the report.
  const advisories = (vuln.via ?? []).filter((v) => typeof v === "object" && v !== null);
  const entries = advisories.length > 0 ? advisories : [{ title: "known vulnerability", url: null, cwe: null }];

  for (const advisory of entries) {
    const cwe = Array.isArray(advisory.cwe) ? advisory.cwe[0] : advisory.cwe;
    findings.push({
      type: "SSCT",
      tool: "npm-audit",
      severity,
      title: `${packageName}: ${advisory.title ?? "known vulnerability"}`.slice(0, 255),
      description: [advisory.url, vuln.range ? `Affected range: ${vuln.range}` : null].filter(Boolean).join(" — ").slice(0, 20000) || undefined,
      cwe: typeof cwe === "string" ? cwe.slice(0, 40) : undefined,
      repository: repository || undefined,
      branch: branch || undefined
    });
  }
}

// The ingestion endpoint caps a single batch at 500 findings (devops-webhook.controller.ts) —
// truncate to the highest-severity subset rather than fail the whole post outright.
if (findings.length > 500) {
  console.error(`npm-audit-to-findings: ${findings.length} findings exceeds the 500/request cap — keeping the 500 highest-severity.`);
  findings.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  findings.length = 500;
}

process.stdout.write(JSON.stringify({ findings }));
