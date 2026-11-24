-- 7.0.0: the sandwich rule per leave type. OFF by default, so every existing type counts days
-- exactly as before; only requests made after an admin switches it on count enclosed weekends and
-- holidays (stored request days are never recomputed).
ALTER TABLE `LeaveType`
    ADD COLUMN `sandwichRule` BOOLEAN NOT NULL DEFAULT false;
