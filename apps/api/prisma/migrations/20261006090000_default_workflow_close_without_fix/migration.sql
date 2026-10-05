-- Additive data fix: "close without a fix" (OPEN / IN_PROGRESS / REOPENED -> CLOSED) joined
-- packages/shared ticketStatusTransitions on 2026-10-05. A FRESH install's seed mirrors that table into
-- the system "Default" workflow, but an existing workspace keeps the nine moves it was seeded with — so
-- its board would never offer the new moves the server now accepts. Adds each one only where that exact
-- move is missing: safe on fresh installs (already present), on old ones, and if run twice.
INSERT INTO `WorkflowTransition` (`id`, `workflowId`, `fromStatusId`, `toStatusId`, `requiresApproval`, `requiredPermission`, `createdAt`)
SELECT v.id, 'wf-default', v.fromStatusId, 'wfs-closed', FALSE, NULL, NOW(3)
FROM (
  SELECT 'wft-open-closed' AS id, 'wfs-open' AS fromStatusId
  UNION ALL SELECT 'wft-inprog-closed', 'wfs-in-progress'
  UNION ALL SELECT 'wft-reopen-closed', 'wfs-reopened'
) AS v
WHERE EXISTS (SELECT 1 FROM `Workflow` w WHERE w.`id` = 'wf-default')
  AND EXISTS (SELECT 1 FROM `WorkflowStatus` s WHERE s.`id` = v.fromStatusId)
  AND EXISTS (SELECT 1 FROM `WorkflowStatus` s WHERE s.`id` = 'wfs-closed')
  AND NOT EXISTS (
    SELECT 1 FROM `WorkflowTransition` t
    WHERE t.`workflowId` = 'wf-default' AND t.`fromStatusId` = v.fromStatusId AND t.`toStatusId` = 'wfs-closed'
  );
