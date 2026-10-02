-- Request forms that still file their tickets as CHANGE move to the form builder's default type, BUG.
--
-- WHY: only a change request's own ticket may carry the CHANGE type — a plain ticket with it is
-- counted as a change by every list and report, with no plan, approval or lifecycle behind it. Saving
-- a form with that type is refused now, but a form saved before the refusal kept filing every public
-- submission (a stranger's, from the internet) as a CHANGE ticket. The submit path also falls back
-- to BUG for such a form (request-form-public.controller.ts); this fixes the stored rows so the form
-- itself says what it does, and so re-saving it is not refused.
--
-- BUG because it is what the form builder starts a new form on and the column's own default
-- (`DEFAULT_REQUEST_FORM_TICKET_TYPE`), so the form behaves as if CHANGE had never been chosen.
--
-- DATA ONLY: no table, column or index changes. The comparison runs under the column's
-- utf8mb4_unicode_ci collation, so 'change', 'Change' and any other spelling the database reads as
-- CHANGE are moved too — the same spellings the API now refuses (ticket.service.ts#isChangeTicketType).
-- Idempotent: a second run finds nothing to move.
UPDATE `RequestForm`
SET `ticketType` = 'BUG'
WHERE `ticketType` = 'CHANGE';
