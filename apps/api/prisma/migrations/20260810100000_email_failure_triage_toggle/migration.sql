-- Adds the feature toggle for the on-demand AI diagnosis of grouped email-send failures
-- (ai.service.ts#analyzeEmailFailure). Default OFF, like every other AI capability toggle:
-- a workspace opts into each model-reaching feature deliberately.
ALTER TABLE `GlobalAISettings`
  ADD COLUMN `emailFailureTriageEnabled` BOOLEAN NOT NULL DEFAULT false;
