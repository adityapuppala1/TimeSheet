-- A proposal remembers the interaction it was parsed from.
--
-- Not a foreign key, deliberately: the retention sweep prunes AIInteraction rows after ~30 days
-- and provenance must outlive them — the same rule AuditLog.aiInteractionId follows. What the
-- column buys: a proposal a human rejected or undid names the exact captured interaction to
-- promote into a golden dataset, which is how per-row accept/reject/undo — the richest quality
-- signal the product produces — finally reaches the eval harness instead of being admired in a
-- comment.
--
-- BEHAVIOURAL CHANGE ON UPGRADE: none. Existing rows hold NULL and nothing requires the column.

-- AlterTable
ALTER TABLE `AiProposal` ADD COLUMN `sourceInteractionId` VARCHAR(64) NULL;
