-- V12: a person-chosen colour on a Project, so a project's mark reads the same everywhere it is
-- named (sidebar tree, tickets table, cards, group headings).
--
-- WHAT EXISTING ROWS DO: NULL, which the web renders as the colour DERIVED from the project id —
-- exactly what every project already shows today. Nobody's screen changes on deploy.
--
-- WHY A SHORT ID AND NOT A HEX VALUE: the allowed values are the eight identity palette ids in
-- packages/shared (each measured for contrast in both themes); storing an id keeps the palette
-- editable in one place and stops an arbitrary colour that fails contrast from being saved.
--
-- Idempotent through the house information_schema + PREPARE guard (MySQL 8 has no ADD COLUMN IF
-- NOT EXISTS; MariaDB does; this app runs on both). Canonical casing written by hand.

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Project' AND COLUMN_NAME = 'color'
);
SET @ddl := IF(@col_exists = 0, 'ALTER TABLE `Project` ADD COLUMN `color` VARCHAR(20) NULL', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
