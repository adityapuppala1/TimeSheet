-- V8 phase 7: run visibility. See docs/AGENTIC_UX_PLAN.md §3.4.
--
-- One nullable column, no DML, nothing existing rewritten. Pure ASCII by design, for the reason the
-- previous two phases give.
--
-- The diff emitted `automationflowrunstep` in lower case (introspection off a case-insensitive Windows
-- MariaDB); corrected to `AutomationFlowRunStep` below. On a case-sensitive Linux MySQL the lower-case
-- form does not exist and the ALTER dies mid-deploy -- the 2.4.0 lesson.
--
-- WHY THE COLUMN: a proposal-only flow's action step could already say "proposed" and could not say
-- WHICH proposal, so the chain flow -> proposal -> applied change stopped at the first arrow. The
-- capability steps never needed it (`AgentRun.proposalId` already carried it); a deterministic action
-- that the flow itself routed into the review queue has no agent run to carry anything.

-- AlterTable
ALTER TABLE `AutomationFlowRunStep` ADD COLUMN `proposalId` VARCHAR(64) NULL;
