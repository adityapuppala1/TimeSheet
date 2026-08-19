-- Adds VALIDATION to ChangeState (spec §25): implementation finishing and somebody confirming it
-- worked are two different facts, and only one of them has a pass/fail.
--
-- Additive to an ENUM, so every existing row keeps its value. Written in canonical model casing by
-- hand rather than taken from an introspection (the 2.4.0 lesson, docs/DATABASE.md).
ALTER TABLE `ChangeRequest` MODIFY COLUMN `state` ENUM('DRAFT', 'SUBMITTED', 'RISK_ASSESSMENT', 'AWAITING_APPROVAL', 'APPROVED', 'SCHEDULED', 'IMPLEMENTING', 'VALIDATION', 'PIR', 'CLOSED', 'REJECTED', 'CANCELLED') NOT NULL DEFAULT 'DRAFT';
