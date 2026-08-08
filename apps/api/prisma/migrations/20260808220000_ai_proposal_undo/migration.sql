-- Undo for AI proposals — see services/ai-proposal.service.ts#undoProposal.
--
-- No new data is needed to reverse a change, because createProposal already refuses an UPDATE that
-- arrives without a `before`. Every applied UPDATE row therefore carries its own inverse, a
-- CREATE's inverse is a soft delete of the id written back onto targetId at apply time, and a
-- LINK's is a delete by natural key. These columns only record the OUTCOME of a reversal.
--
-- BEHAVIOURAL CHANGE ON UPGRADE: none. Every column is nullable and unwritten until somebody
-- presses Undo, and the two new statuses are unreachable until then.

-- AlterTable
ALTER TABLE `AiProposal`
    MODIFY `status` ENUM('PENDING_REVIEW', 'PARTIALLY_APPLIED', 'APPLIED', 'REJECTED', 'EXPIRED', 'UNDONE', 'PARTIALLY_UNDONE') NOT NULL DEFAULT 'PENDING_REVIEW',
    ADD COLUMN `undoneById` VARCHAR(191) NULL,
    ADD COLUMN `undoneAt` DATETIME(3) NULL,
    ADD COLUMN `undoWindowHours` INTEGER NULL;

-- AlterTable
ALTER TABLE `AiProposalChange`
    ADD COLUMN `undoneAt` DATETIME(3) NULL,
    ADD COLUMN `undoError` VARCHAR(500) NULL;

-- AddForeignKey
ALTER TABLE `AiProposal` ADD CONSTRAINT `AiProposal_undoneById_fkey` FOREIGN KEY (`undoneById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
