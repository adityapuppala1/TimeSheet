/**
 * Nightly project-risk snapshot worker — fires at 02:15 server-local, when nobody is editing
 * plans, so a snapshot never lands mid-reschedule and record a half-moved plan as a slip.
 *
 * WHY SNAPSHOTS AT ALL RATHER THAN COMPUTING ON READ: the score is cheap enough to compute live
 * (and the API does, on demand), but a stored series is what makes "is this getting better or
 * worse?" answerable. A single live number tells you today; a trend tells you whether last
 * week's intervention worked, which is the question a delivery lead actually has.
 *
 * WHY THE NARRATIVE IS BEST-EFFORT AND THE SCORE IS NOT: the score is arithmetic and always
 * succeeds. The narrative needs a model, a budget and a network. A snapshot with a number and no
 * sentence is useful; skipping the snapshot because an LLM was unreachable would lose the number
 * too, and the number is the product.
 *
 * Also sweeps expired proposals on the same tick rather than owning a second cron: an unreviewed
 * proposal past its TTL must stop being applicable, and that is the only thing the sweep
 * enforces.
 */
import cron from "node-cron";
import { prisma } from "../config/prisma.js";
import { expireStaleProposals } from "../services/ai-proposal.service.js";
import { getGlobalAISettings, narrateProjectRisk } from "../services/ai.service.js";
import { getPlanningSettings } from "../services/planning.service.js";
import { assessProject, saveSnapshot } from "../services/project-risk.service.js";
import { runForEveryOrg } from "./run-for-every-org.js";

let started = false;
let running = false;

async function tickForOneOrg() {
  const planning = await getPlanningSettings();
  // Nothing to snapshot for a workspace that never turned planning on — and computing risk for
  // projects with no plan would produce a wall of meaningless greens.
  if (!planning.enablePlanning) return;

  const expired = await expireStaleProposals();
  if (expired > 0) console.log(`[risk] expired ${expired} unreviewed proposal(s)`);

  const projects = await prisma.project.findMany({
    where: { deletedAt: null, status: "ACTIVE" },
    select: { id: true, code: true }
  });
  if (projects.length === 0) return;

  // Read once per org, not once per project: whether the narrator is available does not change
  // between two projects in the same tick.
  let narrate = false;
  try {
    const ai = await getGlobalAISettings();
    narrate = Boolean(ai.aiEnabled && ai.projectRiskAgentEnabled);
  } catch {
    narrate = false;
  }

  for (const project of projects) {
    try {
      const assessment = await assessProject(project.id);

      let narrative: string | null = null;
      if (narrate) {
        try {
          narrative = await narrateProjectRisk({
            projectName: assessment.projectName,
            riskScore: assessment.riskScore,
            band: assessment.band,
            topConcerns: assessment.topConcerns,
            facts: assessment.facts
          });
        } catch (error) {
          // Budget exhausted, key rotated, provider down — all expected, none of them a reason
          // to lose the score.
          console.warn(`[risk] narrative unavailable for ${project.code}: ${(error as Error).message}`);
        }
      }

      await saveSnapshot(assessment, narrative);
    } catch (error) {
      // One project's failure never blocks the rest — same isolation principle
      // run-for-every-org applies across orgs, applied here across projects.
      console.error(`[risk] failed for project ${project.code}:`, (error as Error).message);
    }
  }
}

export function startProjectRiskWorker() {
  if (started) return;
  started = true;

  cron.schedule("15 2 * * *", async () => {
    // A tick that overruns must not stack on the next one: risk assessment reads the whole plan
    // per project, and two concurrent passes would double that load for no benefit.
    if (running) {
      console.warn("[risk] previous run still in progress — skipping this tick.");
      return;
    }
    running = true;
    try {
      await runForEveryOrg("project-risk", tickForOneOrg);
    } finally {
      running = false;
    }
  });

  console.log("[risk] project risk worker scheduled (02:15 daily)");
}
