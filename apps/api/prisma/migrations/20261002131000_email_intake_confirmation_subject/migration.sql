-- Email intake's confirmation ("We received your report") now leads its subject with the ticket key
-- in brackets: "[WEB-12] We received your report".
--
-- WHY: a customer's reply to that confirmation used to open a SECOND ticket. Replies are now threaded
-- onto the ticket they answer (services/email-intake.service.ts#findReplyTarget) — first by the
-- confirmation's Message-ID in In-Reply-To/References, and, for mail clients and providers that drop
-- or rewrite those headers, by a bracketed key in the subject, which every client keeps on "Re:".
-- The old subject carried the key only bare, after a dash, which is not something a reply can be
-- matched on safely ("COVID-19" is not a ticket).
--
-- WHY A MIGRATION AND NOT JUST THE SEED: prisma/seed.ts runs once, on a fresh install, so a seeded
-- template's new subject reaches no existing workspace without this.
--
-- DATA ONLY, and only for a subject nobody has edited: either of the two shipped spellings (the
-- seeded em dash and the editor default's hyphen). A workspace that rewrote its confirmation subject
-- keeps its own words; replies to it still thread by In-Reply-To.
UPDATE `EmailTemplate`
SET `subject` = '[{{ticketKey}}] We received your report'
WHERE `key` = 'ticket.received_via_email'
  AND `subject` IN ('We received your report — {{ticketKey}}', 'We received your report - {{ticketKey}}');
