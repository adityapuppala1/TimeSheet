-- The "needs review" and "closed digest" emails now open the ticket they are about.
--
-- WHY: both are about ONE ticket and both sent the reader elsewhere — the needs-review button to the
-- AI activity log, the closed digest's to the whole Tickets list. Every other ticket email and every
-- bell notification already deep-links `/app/tickets?open=<id>`. The senders now pass `ticketId`
-- (email and chat intake, security-report.service.ts#sendTicketClosedDigest) and the seed links to it;
-- this brings the rows existing workspaces actually send from into line, since prisma/seed.ts only
-- runs on a fresh install.
--
-- DATA ONLY. The button's link is rewritten wherever the shipped link is still in the body — the
-- same markup the seed generated (it appears twice per button: once in the Outlook VML, once in the
-- anchor). A workspace that edited its template keeps its edits; if it also kept the shipped button,
-- that button is corrected, and if it removed or changed it, nothing here touches it.
--
-- `variables` is the editor's own record of a template's placeholders; it gains `ticketId` so the
-- row agrees with TEMPLATE_VARIABLES. It is not read when sending.
UPDATE `EmailTemplate`
SET `bodyHtml` = REPLACE(`bodyHtml`, 'href="{{appUrl}}/app/ai-activity"', 'href="{{appUrl}}/app/tickets?open={{ticketId}}"')
WHERE `key` = 'ticket.needs_review';

UPDATE `EmailTemplate`
SET `bodyHtml` = REPLACE(`bodyHtml`, 'href="{{appUrl}}/app/tickets"', 'href="{{appUrl}}/app/tickets?open={{ticketId}}"')
WHERE `key` = 'ticket.closed_digest';

UPDATE `EmailTemplate`
SET `variables` = JSON_ARRAY_APPEND(`variables`, '$', 'ticketId')
WHERE `key` IN ('ticket.needs_review', 'ticket.closed_digest')
  AND JSON_TYPE(`variables`) = 'ARRAY'
  AND NOT JSON_CONTAINS(`variables`, '"ticketId"');
